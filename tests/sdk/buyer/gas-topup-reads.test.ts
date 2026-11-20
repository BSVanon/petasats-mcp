// FIX-C2 items 1-3: a new order is signed only from a read at or after the block that ended the last record; a fill
// must show again until it is past validTo + 120 s on both clocks; and a record ends by expiry only when both the Base
// block time and the local clock are past validTo + 120 s, with a refusal (never a wait with no end) when they disagree.
import { expect } from 'chai'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Hex, LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { makeCowOrderBook } from '../../../src/sdk/buyer/gas-topup-api'
import { makeBuyerGasTopUp, type GasTopUpChainView } from '../../../src/sdk/buyer/gas-topup'
import { ALREADY_HAS_GAS_WEI } from '../../../src/sdk/buyer/gas-topup-order'
import { GAS_TOPUP_SWAP_MESSAGE, GAS_TOPUP_WAIT_MESSAGE, gasTopUpPath, readGasTopUp } from '../../../src/sdk/buyer/gas-topup-state'
import { initialiseBuyerHome } from '../../../src/sdk/buyer/local-state'
import type { GasTopUpStep } from '../../../src/sdk/buyer/types'
import { FakeCowOrderBook, FakeGasChain } from './helpers/gas-fakes'

const NOT_ON_RPC_YET = 'the ETH from this gas purchase does not show on the Base RPC yet; check wallet_info again shortly'
const FILL_NOT_SHOWN = "the Base RPC no longer shows this order's fill; the kit treats it as open until it expires; call buy_gas again to check it"
const CLOCK_SKEW = "the Base block time and this computer's clock differ by more than 10 minutes; nothing was signed"
const EXPIRED_UNSOLD = 'no CoW Protocol solver filled the order before it expired; nothing was sold'
/** The block rule's note on a record that did not end 'filled' (review MINOR-2 / FIX-C3 item 1): no ETH is coming for it. */
const OLDER_BLOCK_NOTE = "this answer comes from an older Base block than the kit's last check; nothing new was signed; call buy_gas again shortly"
const REFUSED_4XX = { status: 400, body: { errorType: 'InsufficientAllowance', description: 'x' } }
const REFUSAL_4XX = 'the CoW Protocol order book refused the order (HTTP 400, InsufficientAllowance)'

/** The gas module over the fakes. read, when given, answers in place of the chain; clock.localAt, when set, fixes the local clock (in seconds). */
function harness(read?: (chain: FakeGasChain, uid?: Hex) => Promise<GasTopUpChainView>) {
  const paths = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-reads-')))
  const account = privateKeyToAccount(generatePrivateKey())
  const chain = new FakeGasChain()
  const book = new FakeCowOrderBook(chain)
  const clock: { localAt?: number } = {}
  let orders = 0
  const signTypedData = (async (parameters: any) => { if (parameters.primaryType === 'Order') orders++; return account.signTypedData(parameters) }) as LocalAccount['signTypedData']
  const gas = makeBuyerGasTopUp({
    home: paths.home, owner: account.address, chain: read ? { read: (uid) => read(chain, uid) } : chain,
    api: makeCowOrderBook({ fetch: book.fetch, timeoutMs: 200 }), signTypedData, now: () => (clock.localAt ?? Number(chain.timestamp)) * 1000,
  })
  return { paths, chain, book, gas, clock, orders: () => orders, record: () => readGasTopUp(paths.home), sold: () => 2_000_000n - chain.usdc }
}
type Harness = ReturnType<typeof harness>

const uidOf = (step: GasTopUpStep): string => { if (step.state === 'refused') throw new Error(`refused: ${step.reason}`); return step.uid }
/** validTo + 120 s: a clock is past the order's end once it is past this second. */
const graceEnd = (h: Harness): number => h.record()!.validTo + 120

async function blockedMessage(h: Harness, purpose: 'withdraw' | 'swap'): Promise<string | undefined> {
  try { await h.gas.assertNoOpenOrder(purpose) } catch (error) { return (error as Error).message }
  return undefined
}
async function expectOpen(h: Harness): Promise<void> {
  expect(await blockedMessage(h, 'withdraw')).eq(GAS_TOPUP_WAIT_MESSAGE)
  expect(await blockedMessage(h, 'swap')).eq(GAS_TOPUP_SWAP_MESSAGE)
  expect(h.record()?.over).eq(undefined)
}

describe('buy_gas: a new order is signed only from a read at or after the block that ended the last record', () => {
  it('1 P2: the permit run out of band, a fill through the standing allowance, then a lagging read: the record reopens and signs nothing; an up-to-date read ends it filled again', async () => {
    let lagging: GasTopUpChainView | undefined
    // A lagging member answers every read from its older block, where the order's filledAmount is still 0.
    const h = harness(async (chain, uid) => lagging ? (uid === undefined ? lagging : { ...lagging, filledAmount: 0n }) : chain.read(uid))
    const uid = uidOf(await h.gas.buy())
    expect(await h.book.runPermit(h.book.posts[0].appData)).eq(true) // nonce 7 -> 8, and a standing 0.50 USDC allowance
    const before = await h.chain.read() // the lagging member's block: after the permit ran, before the fill
    h.book.settle(uid) // the order's hook is skipped (its nonce moved on); the standing allowance pays
    expect(await h.gas.buy()).to.deep.include({ state: 'filled', uid })
    const ended = h.record()!
    expect(ended).to.include({ status: 'filled', over: true })
    expect(BigInt(ended.overAtBlock!) > before.blockNumber).eq(true)
    lagging = { ...before, timestamp: h.chain.timestamp } // within the 60 s the kit's Base gate allows, but shows no fill
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid, note: FILL_NOT_SHOWN }) // the lagging read reopens it
    expect(h.record()).to.include({ status: 'posted' })
    expect(h.record()).not.to.have.any.keys('over', 'overAtBlock')
    await expectOpen(h) // withdrawals, swaps and close_kit wait again
    expect(h.orders()).eq(1) // no second order is signed
    lagging = undefined
    expect(await h.gas.buy()).to.deep.include({ state: 'filled', uid }) // an up-to-date read ends it filled again
    expect(h.record()).to.include({ status: 'filled', over: true })
    expect(h.orders()).eq(1)
    const current = await h.gas.buy() // the kit already has the ETH the real fill paid
    expect(current.state === 'refused' && current.reason).match(/^the kit already has gas \(/)
    expect(h.orders()).eq(1); expect(h.sold()).eq(500_000n)
  })

  it('1 X1: one lying read that also inflates the block number: the record still reopens once honest reads return, and no second order is signed', async () => {
    let lie = false
    let first = ''
    const h = harness(async (chain, uid) => {
      const v = await chain.read(uid)
      return lie && uid !== undefined && uid.toLowerCase() === first.toLowerCase() ? { ...v, filledAmount: 500_000n, blockNumber: v.blockNumber + 1_000_000n } : v
    })
    first = uidOf(await h.gas.buy())
    expect(await h.book.runPermit(h.book.posts[0].appData)).eq(true) // nonce 7 -> 8, and a standing 0.50 USDC allowance
    lie = true
    expect(await h.gas.buy()).to.deep.include({ state: 'filled', uid: first })
    expect(h.record()?.over).eq(true)
    lie = false
    h.chain.timestamp += 30n // an honest read, at a real (far lower) block, still well inside the 120 s grace
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid: first, note: FILL_NOT_SHOWN })
    expect(h.record()).to.include({ status: 'posted' })
    expect(h.record()).not.to.have.any.keys('over', 'overAtBlock')
    await expectOpen(h) // withdrawals, swaps and close_kit wait again
    expect(h.orders()).eq(1) // no second order is signed
    h.book.settle(first) // order 1 is still live and fills through the standing allowance
    expect(h.sold()).eq(500_000n)
  })

  it('1 an expired record, then a read from before the block that ended it: its own step with the note and no new order; a read at that block may sign', async () => {
    let answer: (() => Promise<GasTopUpChainView>) | undefined
    const h = harness(async (chain, uid) => answer ? answer() : chain.read(uid))
    const uid = uidOf(await h.gas.buy())
    const before = await h.chain.read()
    h.chain.timestamp = BigInt(graceEnd(h) + 1)
    const expired = await h.gas.buy()
    expect(expired).to.deep.include({ state: 'expired', uid, sold: 'nothing', reason: EXPIRED_UNSOLD })
    const ended = h.record()!
    answer = async () => ({ ...before, timestamp: h.chain.timestamp })
    expect(await h.gas.buy()).deep.eq({ ...expired, note: OLDER_BLOCK_NOTE })
    expect(h.record()).deep.eq(ended); expect(h.orders()).eq(1)
    answer = async () => ({ ...await h.chain.read(), blockNumber: BigInt(ended.overAtBlock!) }) // at the very block that ended it
    expect((await h.gas.buy()).state).eq('pending')
    expect(h.orders()).eq(2)
  })

  it('1 a rejected record that ends unsold, then a read from before the block that ended it: the older-block note, not NOT_ON_RPC_YET', async () => {
    let answer: (() => Promise<GasTopUpChainView>) | undefined
    const h = harness(async (chain, uid) => answer ? answer() : chain.read(uid))
    h.book.postReply = () => REFUSED_4XX
    const uid = uidOf(await h.gas.buy())
    const before = await h.chain.read()
    h.chain.timestamp = BigInt(graceEnd(h) + 1)
    const rejected = await h.gas.buy()
    expect(rejected).to.deep.include({ state: 'rejected', uid, sold: 'nothing', reason: `${REFUSAL_4XX}; nothing was sold` })
    const ended = h.record()!
    expect(ended).to.include({ status: 'rejected', over: true })
    answer = async () => ({ ...before, timestamp: h.chain.timestamp })
    expect(await h.gas.buy()).deep.eq({ ...rejected, note: OLDER_BLOCK_NOTE })
    expect(h.record()).deep.eq(ended); expect(h.orders()).eq(1)
  })

  it('1 X5: the block rule compares block numbers as numbers, not strings, across a digit-length change', async () => {
    let shift = 0n
    const h = harness(async (chain, uid) => { const v = await chain.read(uid); return { ...v, blockNumber: v.blockNumber + shift } })
    uidOf(await h.gas.buy())
    shift = 999_999_999n - (h.chain.blockNumber + 1n)
    h.chain.timestamp = BigInt(graceEnd(h) + 1)
    expect((await h.gas.buy()).state).eq('expired')
    expect(h.record()?.overAtBlock).eq('999999999')
    expect((await h.gas.buy()).state).eq('pending') // block 1000000000: a string compare would call it "older" than 999999999
    expect(h.orders()).eq(2)
  })

  it('1 the one record check requires overAtBlock, a decimal string, whenever over is true', async () => {
    const h = harness()
    uidOf(await h.gas.buy())
    h.chain.timestamp = BigInt(graceEnd(h) + 1)
    expect((await h.gas.buy()).state).eq('expired')
    const { overAtBlock, ...withoutBlock } = h.record()!
    expect(overAtBlock).eq(h.chain.blockNumber.toString())
    for (const [label, record] of [['missing', withoutBlock], ['a number', { ...withoutBlock, overAtBlock: 1001 }], ['hex', { ...withoutBlock, overAtBlock: '0x3e9' }]] as const) {
      writeFileSync(gasTopUpPath(h.paths.home), JSON.stringify(record), { mode: 0o600 })
      const step = await h.gas.buy()
      expect(step.state === 'refused' && step.reason, label).include('cannot be read (its contents are not a gas purchase record)')
    }
    expect(h.orders()).eq(1)
  })
})

describe('buy_gas: a fill must show again until it is past validTo + 120 s on both clocks', () => {
  it('2 P1: one read that shows a fill that never happened, then honest reads: the record reopens and blocks again, and no second order is signed', async () => {
    let lie = false
    let first = ''
    const h = harness(async (chain, uid) => {
      const view = await chain.read(uid)
      return lie && uid !== undefined && uid.toLowerCase() === first.toLowerCase() ? { ...view, filledAmount: 500_000n } : view
    })
    first = uidOf(await h.gas.buy())
    expect(await h.book.runPermit(h.book.posts[0].appData)).eq(true) // nonce 7 -> 8, and a standing 0.50 USDC allowance
    lie = true
    expect(await h.gas.buy()).to.deep.include({ state: 'filled', uid: first })
    expect(h.record()?.over).eq(true) // the one lying read ended the record
    lie = false; h.chain.timestamp += 30n
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid: first, sold: '0.50 USDC', note: FILL_NOT_SHOWN })
    expect(h.record()).to.include({ status: 'posted' })
    expect(h.record()).not.to.have.any.keys('over', 'overAtBlock')
    await expectOpen(h) // withdrawals and swaps wait again
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid: first }) // and so does a new order
    expect(h.orders()).eq(1)
    for (const order of [...h.book.orders.values()]) h.book.settle(order.uid)
    expect(h.sold()).eq(500_000n)
  })

  it('2 X3: the reopen happens whatever the kit\'s ETH balance, even once it is already at the already-has-gas threshold', async () => {
    let lie = false
    let first = ''
    const h = harness(async (chain, uid) => {
      const view = await chain.read(uid)
      return lie && uid !== undefined && uid.toLowerCase() === first.toLowerCase() ? { ...view, filledAmount: 500_000n } : view
    })
    first = uidOf(await h.gas.buy())
    lie = true
    expect(await h.gas.buy()).to.deep.include({ state: 'filled', uid: first })
    lie = false; h.chain.timestamp += 30n
    h.chain.eth = ALREADY_HAS_GAS_WEI // the user sent ETH meanwhile; the reopen must not wait for a low balance
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid: first, note: FILL_NOT_SHOWN })
    expect(h.record()).to.include({ status: 'posted' })
    expect(h.record()).not.to.have.any.keys('over', 'overAtBlock')
    expect(h.orders()).eq(1)
  })

  it('2 the reopen happens for any filledAmount that is not the sell amount, not only for 0 (the invalidateOrder sentinel, and a partial fill)', async () => {
    for (const bogus of [2n ** 256n - 1n, 250_000n]) {
      const h = harness()
      const uid = uidOf(await h.gas.buy())
      h.book.settle(uid)
      expect(await h.gas.buy()).to.deep.include({ state: 'filled', uid })
      h.chain.filled.set(uid.toLowerCase(), bogus) // a later read no longer shows the exact sell amount
      h.chain.timestamp += 30n // still well inside the 120 s grace
      expect(await h.gas.buy(), String(bogus)).to.deep.include({ state: 'pending', uid, note: FILL_NOT_SHOWN })
      expect(h.record(), String(bogus)).to.include({ status: 'posted' })
      expect(h.record(), String(bogus)).not.to.have.any.keys('over', 'overAtBlock')
    }
  })

  it('2 the fill is read again while either clock is inside validTo + 120 s, and no longer once both are past it', async () => {
    const filledThenCleared = async (): Promise<{ h: Harness; uid: string; end: number }> => {
      const h = harness()
      const uid = uidOf(await h.gas.buy())
      h.book.settle(uid)
      expect(await h.gas.buy()).to.deep.include({ state: 'filled', uid })
      expect(h.record()?.over).eq(true)
      h.chain.eth = 0n // the kit spent its gas
      h.chain.filled.delete(uid.toLowerCase()) // and the order's filledAmount reads 0 again
      return { h, uid, end: graceEnd(h) }
    }
    const chainPast = await filledThenCleared() // the chain is past validTo + 120 s, the local clock is not
    chainPast.h.chain.timestamp = BigInt(chainPast.end + 1); chainPast.h.clock.localAt = chainPast.end
    expect(await chainPast.h.gas.buy()).to.deep.include({ state: 'pending', uid: chainPast.uid, note: FILL_NOT_SHOWN })
    const localPast = await filledThenCleared() // the local clock is past, the chain is not
    localPast.h.chain.timestamp = BigInt(localPast.end); localPast.h.clock.localAt = localPast.end + 1
    expect(await localPast.h.gas.buy()).to.deep.include({ state: 'pending', uid: localPast.uid, note: FILL_NOT_SHOWN })
    for (const { h } of [chainPast, localPast]) { await expectOpen(h); expect(h.orders()).eq(1) }
    const bothPast = await filledThenCleared() // the order can no longer fill: a new order is signed
    bothPast.h.chain.timestamp = BigInt(bothPast.end + 1)
    const fresh = await bothPast.h.gas.buy()
    expect(fresh.state).eq('pending'); expect(uidOf(fresh)).not.eq(bothPast.uid); expect(bothPast.h.orders()).eq(2)
  })
})

describe('buy_gas: a record ends by expiry only when both clocks are past validTo + 120 s', () => {
  it('3 X4: the clock refusal waits for the chain to pass the order end; a live order with a clock more than 10 minutes behind still gets pending', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.chain.timestamp += 60n // the order is barely a minute old: nowhere near its end
    h.clock.localAt = Number(h.chain.timestamp) - 660 // 11 minutes behind, well past the 10-minute skew allowance
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid })
  })

  it('3 the chain is past validTo + 120 s and the local clock is not: the record stays open', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.chain.timestamp = BigInt(graceEnd(h) + 1); h.clock.localAt = graceEnd(h) - 30 // 31 s apart: within the 10 minutes allowed
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid })
    await expectOpen(h)
    h.clock.localAt = graceEnd(h) + 1
    expect(await h.gas.buy()).to.deep.include({ state: 'expired', uid, sold: 'nothing', reason: EXPIRED_UNSOLD })
  })

  it('3 the local clock is past validTo + 120 s and the chain is not: the record stays open', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.chain.timestamp = BigInt(graceEnd(h)); h.clock.localAt = graceEnd(h) + 300
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid })
    await expectOpen(h)
  })

  it('3 both clocks past validTo + 120 s: the record ends, at the block of the read that saw it', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.chain.timestamp = BigInt(graceEnd(h) + 1)
    expect(await h.gas.buy()).to.deep.include({ state: 'expired', uid, sold: 'nothing', reason: EXPIRED_UNSOLD })
    expect(h.record()).to.include({ over: true, overAtBlock: h.chain.blockNumber.toString() })
    expect(await blockedMessage(h, 'withdraw')).eq(undefined)
  })

  it('3 a chain read that fails never ends a record, whatever the local clock says', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.clock.localAt = graceEnd(h) + 3600 // an hour past the order's end
    h.chain.failReads = 3
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid })
    await expectOpen(h)
    expect(h.chain.failReads).eq(0) // every one of those reads failed
  })

  it('3 the chain is past validTo + 120 s and the local clock more than 10 minutes behind: refused with the clock text, and the record stays open', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.chain.timestamp = BigInt(graceEnd(h) + 1); h.clock.localAt = graceEnd(h) + 1 - 601
    expect(await h.gas.buy()).deep.eq({ state: 'refused', reason: CLOCK_SKEW })
    await expectOpen(h)
    expect(h.orders()).eq(1)
    h.clock.localAt = graceEnd(h) + 1 - 600 // exactly 10 minutes apart: the usual wait
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid })
    h.clock.localAt = graceEnd(h) + 1 // once the clock is right, the record ends
    expect(await h.gas.buy()).to.deep.include({ state: 'expired', uid })
  })
})
