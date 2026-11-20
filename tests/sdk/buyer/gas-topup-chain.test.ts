// FIX-C1 items 1b, 1c, 2 and the INVALIDATED branch: the chain alone ends a gas record; the order book is only reported.
import { expect } from 'chai'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { makeCowOrderBook } from '../../../src/sdk/buyer/gas-topup-api'
import { makeBuyerGasTopUp } from '../../../src/sdk/buyer/gas-topup'
import { GAS_TOPUP_MAY_HAVE_FILLED, GAS_TOPUP_SWAP_MESSAGE, GAS_TOPUP_WAIT_MESSAGE, gasTopUpPath, readGasTopUp } from '../../../src/sdk/buyer/gas-topup-state'
import { initialiseBuyerHome } from '../../../src/sdk/buyer/local-state'
import type { GasTopUpStep } from '../../../src/sdk/buyer/types'
import { FakeCowOrderBook, FakeGasChain, UNTRUSTED_DESCRIPTION, UNTRUSTED_ERROR_TYPE } from './helpers/gas-fakes'

function harness() {
  const paths = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-chain-')))
  const account = privateKeyToAccount(generatePrivateKey())
  const chain = new FakeGasChain()
  const book = new FakeCowOrderBook(chain)
  let orders = 0
  const signTypedData = (async (parameters: any) => { if (parameters.primaryType === 'Order') orders++; return account.signTypedData(parameters) }) as LocalAccount['signTypedData']
  const gas = makeBuyerGasTopUp({ home: paths.home, owner: account.address, chain, api: makeCowOrderBook({ fetch: book.fetch, timeoutMs: 200 }), signTypedData, now: chain.clock })
  return { paths, chain, book, gas, orders: () => orders, record: () => readGasTopUp(paths.home), sold: () => 2_000_000n - chain.usdc }
}
type Harness = ReturnType<typeof harness>

const uidOf = (step: GasTopUpStep): string => { if (step.state === 'refused') throw new Error(`refused: ${step.reason}`); return step.uid }
const pastExpiry = (h: Harness): void => { h.chain.timestamp = BigInt(h.record()!.validTo) + 121n }

async function blockedMessage(h: Harness, purpose: 'withdraw' | 'swap'): Promise<string | undefined> {
  try { await h.gas.assertNoOpenOrder(purpose) } catch (error) { return (error as Error).message }
  return undefined
}

async function expectBlocking(h: Harness): Promise<void> {
  expect(await blockedMessage(h, 'withdraw')).eq(GAS_TOPUP_WAIT_MESSAGE)
  expect(await blockedMessage(h, 'swap')).eq(GAS_TOPUP_SWAP_MESSAGE)
  expect(h.record()?.over).eq(undefined)
}

describe('buy_gas: the chain alone ends a gas record', () => {
  it('1b an order book that fills the order but answers 400: the record keeps blocking, the chain shows the fill, and the next call refuses as already having gas', async () => {
    const h = harness()
    h.book.ethUsd = 19_900n // an ETH price just under the kit's $20,000 limit, so the fill pays close to the least ETH the kit accepts
    h.book.postReply = () => 'fill-then-refuse'
    const first = await h.gas.buy()
    expect(first).to.deep.include({ state: 'rejected', sold: 'nothing so far' }) // the order book's answer, only reported
    h.book.postReply = undefined
    const second = await h.gas.buy()
    expect(second).to.deep.include({ state: 'filled', uid: uidOf(first), sold: '0.50 USDC' })
    expect(second.state === 'filled' && second.eth_received).match(/ ETH$/)
    expect(h.record()).to.include({ status: 'filled', over: true })
    const third = await h.gas.buy()
    expect(third.state === 'refused' && third.reason).match(/^the kit already has gas \(0\.0000245\d* ETH\); nothing was signed$/)
    expect(h.sold()).eq(500_000n); expect(h.orders()).eq(1)
  })

  it('1b a record the order book refused but stored keeps blocking withdrawals, swaps and new orders until validTo + 120 s', async () => {
    const h = harness()
    h.book.postReply = () => 'store-then-refuse'
    const first = await h.gas.buy()
    expect(first.state).eq('rejected')
    await expectBlocking(h)
    h.book.postReply = undefined
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid: uidOf(first) }) // the order book does know it
    h.chain.timestamp = BigInt(h.record()!.validTo) + 120n
    await expectBlocking(h)
    h.chain.timestamp += 1n
    expect(await h.gas.buy()).to.deep.include({ state: 'expired', uid: uidOf(first), sold: 'nothing', reason: 'no CoW Protocol solver filled the order before it expired; nothing was sold' })
    expect(await blockedMessage(h, 'withdraw')).eq(undefined)
    expect((await h.gas.buy()).state).eq('pending') // now a new order may be signed
    expect(h.orders()).eq(2)
  })

  it('1b "fulfilled" from the order book alone never ends a record: it is reported, and the record expires unsold on chain', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.book.getReply = (asked) => ({ status: 200, body: { uid: asked, status: 'fulfilled', executedBuyAmount: '280000000000000' } })
    expect(await h.gas.buy()).to.deep.include({ state: 'filled', uid, eth_received: '0.00028 ETH', note: 'the ETH from this gas purchase does not show on the Base RPC yet; check wallet_info again shortly' })
    await expectBlocking(h)
    expect((await h.gas.buy()).state).eq('filled'); expect(h.orders()).eq(1)
    pastExpiry(h)
    expect(await h.gas.buy()).to.deep.include({ state: 'expired', uid, sold: 'nothing', reason: 'no CoW Protocol solver filled the order before it expired; nothing was sold' })
    expect(h.record()?.over).eq(true)
  })

  it('1b no 4xx on a re-post ends a record (an order book that checks its quote before duplicates)', async () => {
    const h = harness()
    h.book.postReply = () => 'store-then-network' // accepted, but the answer was lost
    const first = await h.gas.buy()
    expect(h.record()?.status).eq('signed')
    h.book.postReply = undefined; h.book.getReply = () => 'network'
    h.book.duplicateCheckLast = true; h.book.quoteExpired = true
    const reposted = await h.gas.buy()
    expect(reposted).to.deep.include({ state: 'rejected', uid: uidOf(first) })
    expect(reposted.state === 'rejected' && reposted.reason).eq('the CoW Protocol order book refused the order (HTTP 400, InvalidQuote); nothing was sold so far, but the kit treats the order as open until it expires; call buy_gas again after it expires to check it')
    expect(h.book.posts).length(2)
    await expectBlocking(h)
    h.book.settle(uidOf(first)) // the stored order fills after all
    expect(await h.gas.buy()).to.deep.include({ state: 'filled', uid: uidOf(first) })
    expect((await h.gas.buy()).state).eq('refused')
    expect(h.sold()).eq(500_000n); expect(h.orders()).eq(1)
  })

  it('1c an order that expires after its permit nonce moved is never reported as unsold', async () => {
    // The permit run out of band: the nonce moves on, the allowance stands, and no solver fills the order.
    const outOfBand = harness()
    const uid = uidOf(await outOfBand.gas.buy())
    expect(await outOfBand.book.runPermit(outOfBand.book.posts[0].appData)).eq(true)
    expect(outOfBand.chain.allowance).eq(500_000n)
    pastExpiry(outOfBand)
    const step = await outOfBand.gas.buy()
    expect(step).deep.eq({ state: 'expired', uid, order_url: `https://explorer.cow.fi/base/orders/${uid}`, min_eth: (step as { min_eth: string }).min_eth, sold: 'up to 0.50 USDC', reason: GAS_TOPUP_MAY_HAVE_FILLED })
    expect(GAS_TOPUP_MAY_HAVE_FILLED).eq('the order may have filled before it expired; check wallet_info for the ETH')
    // A fill whose filledAmount was cleared after validTo, with the order book unreachable: only the chain is read.
    const cleared = harness()
    const clearedUid = uidOf(await cleared.gas.buy())
    cleared.book.getReply = () => 'network'
    cleared.book.settle(clearedUid)
    expect(cleared.chain.allowance).eq(0n) // the fill used up the allowance its permit set
    cleared.chain.filled.delete(clearedUid.toLowerCase())
    pastExpiry(cleared)
    expect(await cleared.gas.buy()).to.deep.include({ state: 'expired', sold: 'up to 0.50 USDC', reason: GAS_TOPUP_MAY_HAVE_FILLED })
  })

  it('9 an invalidated order (filledAmount 2^256 - 1) is not a fill: it keeps blocking until it expires, then it may have filled', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.book.getReply = () => 'network'
    h.chain.filled.set(uid.toLowerCase(), 2n ** 256n - 1n)
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid })
    await expectBlocking(h)
    pastExpiry(h)
    expect(await h.gas.buy()).to.deep.include({ state: 'expired', uid, reason: GAS_TOPUP_MAY_HAVE_FILLED })
  })

  it('6 no order book status but fulfilled ends a record or sets over: expired, cancelled, presignaturePending, open, or one this kit does not know', async () => {
    for (const status of ['expired', 'cancelled', 'presignaturePending', 'open', 'somethingNew']) {
      const h = harness()
      const uid = uidOf(await h.gas.buy())
      h.book.getReply = (asked) => ({ status: 200, body: { uid: asked, status, executedBuyAmount: '0' } })
      expect(await h.gas.buy(), status).to.deep.include({ state: 'pending', uid })
      expect(h.record(), status).to.include({ status: 'posted' })
      await expectBlocking(h)
      expect(h.orders(), status).eq(1)
    }
  })

  it('2 order book text reaches no reason, note or gas-topup.json, on the order, quote and status paths', async () => {
    const untrusted = { status: 400, body: { errorType: UNTRUSTED_ERROR_TYPE, description: UNTRUSTED_DESCRIPTION } }
    const clean = (text: string): void => { expect(text).not.include(UNTRUSTED_ERROR_TYPE); expect(text).not.include(UNTRUSTED_DESCRIPTION) }
    const posted = harness()
    posted.book.postReply = () => untrusted
    const rejected = await posted.gas.buy()
    expect(rejected.state === 'rejected' && rejected.reason).eq('the CoW Protocol order book refused the order (HTTP 400); nothing was sold so far, but the kit treats the order as open until it expires; call buy_gas again after it expires to check it')
    clean(JSON.stringify(rejected)); clean(readFileSync(gasTopUpPath(posted.paths.home), 'utf8'))
    const quoted = harness()
    quoted.book.quoteReply = () => untrusted
    const refused = await quoted.gas.buy()
    expect(refused.state === 'refused' && refused.reason).eq("CoW Protocol could not quote the gas purchase (the CoW Protocol order book refused the quote (HTTP 400)); nothing was signed; call buy_gas again later, or send a little ETH for gas to the kit's Base address instead")
    for (const reply of [untrusted, { ...untrusted, status: 500 }]) {
      const status = harness()
      await status.gas.buy()
      status.book.getReply = () => reply
      const step = await status.gas.buy()
      expect(step.state).eq('pending')
      clean(JSON.stringify(step)); clean(readFileSync(gasTopUpPath(status.paths.home), 'utf8'))
    }
  })
})
