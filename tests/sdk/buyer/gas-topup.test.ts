import { expect } from 'chai'
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { domainSeparator, type LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { makeCowOrderBook } from '../../../src/sdk/buyer/gas-topup-api'
import { makeBuyerGasTopUp } from '../../../src/sdk/buyer/gas-topup'
import { ALREADY_HAS_GAS_WEI, COW_NATIVE_ETH, GAS_TOPUP_MIN_QUOTE_WEI, USDC_PERMIT_DOMAIN } from '../../../src/sdk/buyer/gas-topup-order'
import { archiveGasTopUp, GAS_TOPUP_HISTORY_FILE, GAS_TOPUP_WAIT_MESSAGE, gasTopUpPath, readGasTopUp, readGasTopUpHistory } from '../../../src/sdk/buyer/gas-topup-state'
import { initialiseBuyerHome } from '../../../src/sdk/buyer/local-state'
import type { GasTopUpStep } from '../../../src/sdk/buyer/types'
import { FakeCowOrderBook, FakeGasChain } from './helpers/gas-fakes'

function harness(opts: { now?: () => number } = {}) {
  const paths = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-')))
  const account = privateKeyToAccount(generatePrivateKey())
  const chain = new FakeGasChain()
  const book = new FakeCowOrderBook(chain)
  const signed: Array<{ primaryType: string; message: Record<string, any> }> = []
  const signTypedData = (async (parameters: any) => { signed.push({ primaryType: parameters.primaryType, message: parameters.message }); return account.signTypedData(parameters) }) as LocalAccount['signTypedData']
  const gas = makeBuyerGasTopUp({ home: paths.home, owner: account.address, chain, api: makeCowOrderBook({ fetch: book.fetch, timeoutMs: 200 }), signTypedData, now: opts.now ?? chain.clock })
  return {
    paths, account, chain, book, signed, gas,
    orders: () => signed.filter((entry) => entry.primaryType === 'Order'),
    permits: () => signed.filter((entry) => entry.primaryType === 'Permit'),
    record: () => readGasTopUp(paths.home),
  }
}
type Harness = ReturnType<typeof harness>

function uidOf(step: GasTopUpStep): string {
  if (step.state === 'refused') throw new Error(`refused: ${step.reason}`)
  return step.uid
}

async function expectWait(h: Harness): Promise<void> {
  try { await h.gas.assertNoOpenOrder('withdraw') } catch (error) { expect((error as Error).message).eq(GAS_TOPUP_WAIT_MESSAGE); return }
  expect.fail('the gas order must still hold the USDC')
}

async function expectRefusedUnsigned(h: Harness, reason: string | RegExp): Promise<void> {
  const step = await h.gas.buy()
  expect(step.state).eq('refused')
  if (step.state !== 'refused') return
  if (typeof reason === 'string') expect(step.reason).include(reason)
  else expect(step.reason).match(reason)
  expect(h.signed).length(0)
  expect(h.book.posts).length(0)
  expect(existsSync(gasTopUpPath(h.paths.home))).eq(false)
}

describe('buy_gas step', () => {
  it('saves the signed order before posting it, then posts one order whose uid the order book confirms', async () => {
    const h = harness()
    let onDiskAtPost: ReturnType<typeof readGasTopUp>
    h.book.postReply = () => { onDiskAtPost = h.record(); return undefined }
    const step = await h.gas.buy()
    expect(step.state).eq('pending')
    const uid = uidOf(step)
    expect(onDiskAtPost!).to.include({ status: 'signed', uid })
    expect(onDiskAtPost!.signature).match(/^0x[0-9a-f]{130}$/)
    expect(h.book.only().uid).eq(uid)
    expect(h.record()).to.include({ status: 'posted', uid, sellAmount: '500000', permitNonce: '7', validTo: 1_800_001_200 })
    expect(step).to.include({ sold: '0.50 USDC', call_again_after_seconds: 30, order_url: `https://explorer.cow.fi/base/orders/${uid}` })
    expect(h.permits()).length(1); expect(h.orders()).length(1)
    const [quote] = h.book.quotes
    expect(quote).to.include({ from: h.account.address, receiver: h.account.address, kind: 'sell', sellAmountBeforeFee: '500000', buyToken: COW_NATIVE_ETH, validTo: 1_800_001_200 })
    expect(JSON.parse(quote.appData).metadata.hooks.pre[0].callData).match(/0{128}$/) // the quote's hook carries no signature
    expect(h.permits()[0].message).to.include({ value: 500_000n, nonce: 7n, deadline: 1_800_001_200n })
  })

  it('F1 refuses when the quote API is down, times out or fails, signs nothing, and suggests sending ETH', async () => {
    for (const reply of ['network', { status: 500, body: { errorType: 'InternalServerError', description: 'boom' } }, { status: 429 }, 'hang'] as const) {
      const h = harness()
      h.book.quoteReply = () => reply === 'hang' ? new Promise(() => {}) : reply
      await expectRefusedUnsigned(h, "send a little ETH for gas to the kit's Base address instead")
    }
  })

  it('F2 refuses a bad quote from the API and signs nothing', async () => {
    const tamper: Array<[string, (q: any) => void]> = [
      ['does not buy native ETH', (q) => { q.quote.buyToken = '0x4200000000000000000000000000000000000006' }],
      ["pays an address other than the kit's", (q) => { q.quote.receiver = '0x4444444444444444444444444444444444444444' }],
      ['is not a sell order', (q) => { q.quote.kind = 'buy' }],
      ['buys no ETH', (q) => { q.quote.buyAmount = '0' }],
      ['prices ETH above $20,000', (q) => { q.quote.buyAmount = (GAS_TOPUP_MIN_QUOTE_WEI - 1n).toString() }],
    ]
    for (const [reason, change] of tamper) {
      const h = harness()
      h.book.quoteReply = (body) => { const reply = h.book.answerQuote(body) as { status: number; body: any }; change(reply.body); return reply }
      await expectRefusedUnsigned(h, reason)
    }
  })

  it('F3 reports a 4xx at POST as rejected, keeps it blocking until the chain shows it expired, then starts a fresh order', async () => {
    const h = harness()
    h.book.postReply = () => ({ status: 400, body: { errorType: 'InsufficientAllowance', description: 'no allowance' } })
    const step = await h.gas.buy()
    expect(step.state).eq('rejected')
    if (step.state !== 'rejected') return
    expect(step.reason).eq('the CoW Protocol order book refused the order (HTTP 400, InsufficientAllowance); nothing was sold so far, but the kit treats the order as open until it expires; call buy_gas again after it expires to check it'); expect(step.sold).eq('nothing so far')
    expect(h.record()?.status).eq('rejected'); expect(h.record()?.over).eq(undefined)
    expect(h.record()?.reason).eq('the CoW Protocol order book refused the order (HTTP 400, InsufficientAllowance)') // the refusal alone is stored
    await expectWait(h) // the order book's 4xx is only reported: the order may still have been stored
    h.book.postReply = undefined; h.chain.timestamp += 5n
    expect(await h.gas.buy()).to.deep.include({ state: 'rejected', uid: step.uid }) // the same record; nothing new is signed
    expect(h.orders()).length(1); expect(h.book.quotes).length(1)
    h.chain.timestamp = BigInt(h.record()!.validTo) + 121n
    expect(await h.gas.buy()).to.deep.include({ state: 'rejected', uid: step.uid, sold: 'nothing', reason: 'the CoW Protocol order book refused the order (HTTP 400, InsufficientAllowance); nothing was sold' }) // unsold: filledAmount 0, nonce unmoved
    expect(h.record()?.over).eq(true)
    await h.gas.assertNoOpenOrder('withdraw')
    const fresh = await h.gas.buy()
    expect(fresh.state).eq('pending')
    expect(uidOf(fresh)).not.eq(step.uid)
    expect(h.orders()).length(2); expect(h.book.orders.size).eq(1)
  })

  it('F4 a posted order that is never filled stays open until validTo plus 2 minutes, then expires with nothing sold', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.chain.timestamp = 1_800_001_200n + 120n // validTo + 120: not yet past the grace
    expect((await h.gas.buy()).state).eq('pending')
    try { await h.gas.assertNoOpenOrder('withdraw'); expect.fail('the open order must hold the USDC') } catch (error) { expect((error as Error).message).eq(GAS_TOPUP_WAIT_MESSAGE) }
    h.chain.timestamp += 1n
    const step = await h.gas.buy()
    expect(step).to.include({ state: 'expired', uid, sold: 'nothing', reason: 'no CoW Protocol solver filled the order before it expired; nothing was sold' })
    expect(h.record()).to.include({ status: 'expired', over: true })
    await h.gas.assertNoOpenOrder('withdraw')
    expect(h.chain.usdcNonce).eq(7n) // the unused permit was never run: the next permit reuses nonce 7, so at most one can ever run
    expect(h.orders()).length(1)
  })

  it('F7 an order book uid that differs from the local uid is recorded as rejected, never as posted', async () => {
    const h = harness()
    const foreign = `0x${'ab'.repeat(56)}`
    h.book.postReply = () => ({ status: 201, body: foreign })
    const step = await h.gas.buy()
    expect(step.state).eq('rejected')
    if (step.state !== 'rejected') return
    expect(step.reason).include(foreign); expect(step.reason).include('not treated as posted')
    expect(h.record()?.status).eq('rejected')
    expect(h.record()?.postedAt).eq(undefined)
    await expectWait(h) // a mismatched answer never ends the record either
  })

  it('F8 after signing without a POST, the next call re-posts the same signature; DuplicatedOrder counts as posted', async () => {
    const h = harness()
    h.book.postReply = () => 'network' // the request never reached the order book
    const first = await h.gas.buy()
    expect(first.state).eq('pending')
    expect(h.record()?.status).eq('signed')
    expect(h.book.orders.size).eq(0)
    h.book.postReply = undefined
    const second = await h.gas.buy()
    expect(second.state).eq('pending')
    expect(uidOf(second)).eq(uidOf(first))
    expect(h.book.posts).length(2)
    expect(h.book.posts[1].signature).eq(h.book.posts[0].signature)
    expect(h.record()?.status).eq('posted')
    expect(h.orders()).length(1)

    const d = harness()
    d.book.postReply = () => 'store-then-network' // accepted, but the answer was lost
    await d.gas.buy()
    d.book.postReply = undefined
    d.book.getReply = () => 'network' // and the status read fails too: only a re-POST can tell
    const again = await d.gas.buy()
    expect(again.state).eq('pending')
    expect(d.record()?.status).eq('posted')
    expect(d.book.posts).length(2); expect(d.book.orders.size).eq(1); expect(d.orders()).length(1)
  })

  it('F8 never re-posts a signed order the order book would refuse as too close to its validTo', async () => {
    const h = harness()
    h.book.postReply = () => 'network'
    await h.gas.buy()
    h.book.postReply = undefined
    h.chain.timestamp = 1_800_001_200n - 90n
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', note: 'the order is signed and saved, but too little time is left to post it; call buy_gas again after it expires to check it' })
    expect(h.book.posts).length(1)
    expect(h.record()?.status).eq('signed')
  })

  it('F9 an accepted POST whose answer was lost resolves to posted by GET, with no second order', async () => {
    const h = harness()
    h.book.postReply = () => 'store-then-network'
    const first = await h.gas.buy()
    expect(h.record()?.status).eq('signed')
    h.book.postReply = undefined
    const second = await h.gas.buy()
    expect(second.state).eq('pending')
    expect(uidOf(second)).eq(uidOf(first))
    expect(h.record()?.status).eq('posted')
    expect(h.book.posts).length(1); expect(h.book.orders.size).eq(1); expect(h.orders()).length(1)
    // A 5xx or an unexpected 2xx may also hide an accepted order: the record stays signed, never rejected.
    for (const reply of [{ status: 503 }, { status: 200, body: 'ok' }]) {
      const u = harness()
      u.book.postReply = () => reply
      expect((await u.gas.buy()).state).eq('pending')
      expect(u.record()?.status).eq('signed')
    }
  })

  it('F11 refuses below 0.50 USDC and at or above the gas threshold, signing nothing', async () => {
    const low = harness(); low.chain.usdc = 499_999n
    await expectRefusedUnsigned(low, 'buy_gas needs 0.50 USDC in the kit, and it has 0.499999 USDC')
    const full = harness(); full.chain.eth = ALREADY_HAS_GAS_WEI
    await expectRefusedUnsigned(full, 'the kit already has gas (0.00002 ETH); nothing was signed')
    const under = harness(); under.chain.eth = ALREADY_HAS_GAS_WEI - 1n
    expect((await under.gas.buy()).state).eq('pending')
  })

  it('F12 reports filled from the API while the RPC still reads 0 ETH, and never signs again', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.book.settle(uid, 280_000_000_000_000n, { chainSeesIt: false })
    const filled = await h.gas.buy()
    expect(filled).to.include({ state: 'filled', uid, eth_received: '0.00028 ETH', note: 'the ETH from this gas purchase does not show on the Base RPC yet; check wallet_info again shortly' })
    expect(h.record()).to.include({ status: 'filled', executedBuyAmount: '280000000000000' })
    expect(h.record()?.over).eq(undefined) // the order book's word alone never ends the record
    await expectWait(h)
    const lagging = await h.gas.buy()
    expect(lagging).to.include({ state: 'filled', uid })
    if (lagging.state === 'filled') expect(lagging.note).include('does not show on the Base RPC yet')
    expect(h.orders()).length(1); expect(h.book.quotes).length(1)
    // The RPC catches up: the permit raised the nonce, and the ETH is there.
    h.chain.usdcNonce += 1n; h.chain.eth += 280_000_000_000_000n; h.chain.filled.set(uid, 500_000n)
    const shown = await h.gas.buy()
    expect(shown).to.deep.include({ state: 'filled', uid, eth_received: '0.00028 ETH' }); expect(shown).not.to.have.property('note')
    expect(h.record()?.over).eq(true)
    const after = await h.gas.buy()
    expect(after).deep.eq({ state: 'refused', reason: 'the kit already has gas (0.00028 ETH); nothing was signed' })
    expect(h.orders()).length(1)
  })

  it('F12 a fill the chain shows while the order book is unreachable still counts as filled', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.book.settle(uid)
    h.book.getReply = () => 'network'
    expect(await h.gas.buy()).to.include({ state: 'filled', uid })
  })

  it('F13 reads the permit nonce fresh for every order, so a later order uses the current nonce', async () => {
    const h = harness()
    await h.gas.buy()
    h.chain.timestamp += 1200n + 121n
    expect((await h.gas.buy()).state).eq('expired')
    const reused = await h.gas.buy() // the expired order's permit never ran: nonce 7 is still current
    expect(reused.state).eq('pending')
    expect(h.permits().map((p) => p.message.nonce)).deep.eq([7n, 7n])
    h.chain.timestamp += 1200n + 121n
    await h.gas.buy()
    h.chain.usdcNonce = 9n // something used the kit's permits meanwhile
    const moved = await h.gas.buy()
    expect(moved.state).eq('pending')
    expect(h.permits().map((p) => p.message.nonce)).deep.eq([7n, 7n, 9n])
    expect(h.record()?.permitNonce).eq('9')
  })

  it('F14 refuses when Base USDC\'s DOMAIN_SEPARATOR does not match its name, version, chain or address', async () => {
    const other = '0x3333333333333333333333333333333333333333' as const
    for (const domain of [{ ...USDC_PERMIT_DOMAIN, name: 'USDC' }, { ...USDC_PERMIT_DOMAIN, version: '1' }, { ...USDC_PERMIT_DOMAIN, chainId: 1 }, { ...USDC_PERMIT_DOMAIN, verifyingContract: other }]) {
      const h = harness()
      h.chain.separator = domainSeparator({ domain })
      await expectRefusedUnsigned(h, "Base USDC's signing domain is not the one this kit signs permits for")
    }
  })

  it('F15 refuses when the Base block time and the local clock differ by more than 10 minutes, and keeps validTo within 25 minutes of the local clock', async () => {
    const clockSkew = "the Base block time and this computer's clock differ by more than 10 minutes; nothing was signed"
    for (const offset of [601, -601]) {
      const h: Harness = harness({ now: () => (Number(h.chain.timestamp) + offset) * 1000 })
      await expectRefusedUnsigned(h, clockSkew)
      expect(await h.gas.buy()).deep.eq({ state: 'refused', reason: clockSkew })
    }
    for (const [offset, validTo] of [[600, 1_800_001_200], [-600, 1_800_000_900], [-540, 1_800_000_960]] as const) {
      const h = harness({ now: () => (1_800_000_000 + offset) * 1000 })
      expect((await h.gas.buy()).state, String(offset)).eq('pending')
      expect(h.record()?.validTo, String(offset)).eq(validTo) // the chain's block time + 20 minutes, never past the local clock + 25
      expect(h.orders()[0].message.validTo).eq(validTo)
      expect(h.permits()[0].message.deadline).eq(BigInt(validTo))
    }
    // A local clock that stopped never ends an order, and never waits with no end: once the chain is past the order's
    // end and the two clocks differ by more than 10 minutes, buy_gas names the clock, and the record stays open.
    const stopped = harness({ now: () => 1_800_000_000_000 })
    uidOf(await stopped.gas.buy())
    stopped.chain.timestamp += 1200n + 121n
    expect(await stopped.gas.buy()).deep.eq({ state: 'refused', reason: clockSkew })
    expect(stopped.record()?.over).eq(undefined)
  })

  it('F17 archives a finished record before a new one replaces it, and keeps every earlier line', async () => {
    const h = harness()
    const first = uidOf(await h.gas.buy())
    h.book.settle(first)
    expect((await h.gas.buy()).state).eq('filled')
    h.chain.eth = 0n // the kit spent its gas
    const second = uidOf(await h.gas.buy())
    expect(readGasTopUpHistory(h.paths.home).map((r) => [r.uid, r.status])).deep.eq([[first, 'filled']])
    expect(h.record()?.uid).eq(second)
    h.chain.timestamp += 1200n + 121n
    expect((await h.gas.buy()).state).eq('expired')
    appendFileSync(join(h.paths.home, GAS_TOPUP_HISTORY_FILE), '{"torn":') // a crash mid-append
    const third = uidOf(await h.gas.buy())
    expect(readGasTopUpHistory(h.paths.home).map((r) => [r.uid, r.status])).deep.eq([[first, 'filled'], [second, 'expired']])
    archiveGasTopUp(h.paths.home, readGasTopUpHistory(h.paths.home)[1]) // archiving twice adds nothing
    expect(readGasTopUpHistory(h.paths.home)).length(2)
    expect(h.record()?.uid).eq(third)
    expect(() => archiveGasTopUp(h.paths.home, h.record()!)).to.throw('an open gas purchase is never archived')
  })

  it('F18 refuses with one fixed message for a corrupt, unsafe or altered record and never overwrites it', async () => {
    const NOT_A_GAS_PURCHASE_RECORD = 'contents are not a gas purchase record'
    const corruptions: Array<[string, (path: string) => void]> = [
      ['not valid JSON', (path) => writeFileSync(path, '{"uid":', { mode: 0o600 })],
      [NOT_A_GAS_PURCHASE_RECORD, (path) => writeFileSync(path, JSON.stringify({ uid: 'x' }), { mode: 0o600 })],
      ['unsafe permissions', (path) => { writeFileSync(path, '{}'); chmodSync(path, 0o644) }],
    ]
    for (const [detail, corrupt] of corruptions) {
      const h = harness()
      const path = gasTopUpPath(h.paths.home)
      corrupt(path)
      const before = readFileSync(path)
      const step = await h.gas.buy() // buy_gas returns the refusal; it never throws
      expect(step.state, detail).eq('refused')
      // Windows has no POSIX permission bits, so local-state.ts's secureFileText skips the mode check there: this
      // chmod is inert, and the file is read as plain '{}', which fails the same shape check as the corruption above.
      const expectedText = process.platform === 'win32' && detail === 'unsafe permissions' ? NOT_A_GAS_PURCHASE_RECORD : detail
      for (const call of [() => h.gas.assertNoOpenOrder('withdraw'), () => h.gas.assertNoOpenOrder('swap')]) {
        try { await call(); expect.fail(`${detail}: must refuse`) } catch (error) {
          if (step.state === 'refused') expect(step.reason, detail).eq((error as Error).message)
          expect((error as Error).message, detail).include(`gas-topup.json in ${h.paths.home} cannot be read`)
          expect((error as Error).message, detail).include('Inspect it')
          expect((error as Error).message, detail).include(expectedText)
        }
      }
      expect(h.gas.view()).deep.eq({ status: 'unreadable' })
      expect(readFileSync(path).equals(before), detail).eq(true)
      expect(h.signed).length(0); expect(h.book.quotes).length(0)
    }
    const altered = harness()
    await altered.gas.buy()
    const path = gasTopUpPath(altered.paths.home)
    const record = JSON.parse(readFileSync(path, 'utf8'))
    const otherWallet = privateKeyToAccount(generatePrivateKey()).address
    // An owner field alone that names another wallet is refused too, though the uid still rebuilds with this kit's address.
    for (const [change, detail] of [[{ buyAmountMin: '1' }, 'its order does not match its uid'], [{ buyAmountMin: '9'.repeat(78) }, 'its order does not match its uid'], [{ owner: otherWallet }, "it names another wallet's order"]] as const) {
      writeFileSync(path, JSON.stringify({ ...record, ...change }), { mode: 0o600 })
      const step = await altered.gas.buy()
      expect(step.state === 'refused' && step.reason, detail).include(`cannot be read (${detail})`)
    }
    expect(altered.orders()).length(1)
  })
})
