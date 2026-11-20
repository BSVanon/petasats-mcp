// FIX-C4 items 1 and 2: a new gas order is signed only while the kit's USDC allowance for the CoW Protocol vault relayer
// is below 0.50 USDC, so any fill needs the order's own permit and the permit nonce shows whether it sold; and a quote id
// is kept only when the record check accepts it, so a quote reply can never make the saved record unreadable.
import { expect } from 'chai'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { makeCowOrderBook } from '../../../src/sdk/buyer/gas-topup-api'
import { makeBuyerGasTopUp } from '../../../src/sdk/buyer/gas-topup'
import { GAS_TOPUP_EXPIRY_GRACE_SECONDS, GAS_TOPUP_SELL } from '../../../src/sdk/buyer/gas-topup-order'
import { GAS_TOPUP_MAY_HAVE_FILLED, GAS_TOPUP_WAIT_MESSAGE, gasTopUpPath, readGasTopUp, readGasTopUpHistory } from '../../../src/sdk/buyer/gas-topup-state'
import { initialiseBuyerHome } from '../../../src/sdk/buyer/local-state'
import type { GasTopUpStep } from '../../../src/sdk/buyer/types'
import { FakeCowOrderBook, FakeGasChain } from './helpers/gas-fakes'

const ALLOWANCE_STANDS = "a USDC allowance of 0.50 USDC or more for the CoW Protocol vault relayer already exists, so the kit could not later tell whether a new order sold; nothing was signed; send a little ETH for gas to the kit's Base address instead"

function harness() {
  const paths = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-allowance-')))
  const account = privateKeyToAccount(generatePrivateKey())
  const chain = new FakeGasChain()
  const book = new FakeCowOrderBook(chain)
  const signed: string[] = []
  const signTypedData = (async (parameters: any) => { signed.push(parameters.primaryType); return account.signTypedData(parameters) }) as LocalAccount['signTypedData']
  const gas = makeBuyerGasTopUp({ home: paths.home, owner: account.address, chain, api: makeCowOrderBook({ fetch: book.fetch, timeoutMs: 200 }), signTypedData, now: chain.clock })
  return { paths, chain, book, gas, signed, record: () => readGasTopUp(paths.home), saved: () => existsSync(gasTopUpPath(paths.home)) }
}
type Harness = ReturnType<typeof harness>

const uidOf = (step: GasTopUpStep): string => { if (step.state === 'refused') throw new Error(`refused: ${step.reason}`); return step.uid }
/** The fake order book's own quote, with its id replaced. */
const quoteIdIs = (h: Harness, id: unknown): void => {
  h.book.quoteReply = (body) => { const reply = h.book.answerQuote(body) as { status: number; body: any }; reply.body.id = id; return reply }
}
async function blockedMessage(h: Harness): Promise<string | undefined> {
  try { await h.gas.assertNoOpenOrder('withdraw') } catch (error) { return (error as Error).message }
  return undefined
}

describe('buy_gas: a new order is signed only while the USDC allowance for the CoW vault relayer is below 0.50 USDC', () => {
  it('1 B5: a standing allowance of 1.00 USDC before the first call is refused, with no quote, permit, order or gas-topup.json', async () => {
    const h = harness()
    h.chain.allowance = 1_000_000n // a settlement could take 0.50 USDC through it without running the order's permit
    expect(await h.gas.buy()).deep.eq({ state: 'refused', reason: ALLOWANCE_STANDS })
    expect(h.signed).deep.eq([])
    expect(h.book.quotes).length(0); expect(h.book.posts).length(0)
    expect(h.saved()).eq(false)
  })

  it('1 the boundary: an allowance of exactly 0.50 USDC is refused; 0.499999 USDC signs as before', async () => {
    const at = harness()
    at.chain.allowance = GAS_TOPUP_SELL
    expect(await at.gas.buy()).deep.eq({ state: 'refused', reason: ALLOWANCE_STANDS })
    expect(at.signed).deep.eq([]); expect(at.book.quotes).length(0); expect(at.saved()).eq(false)
    const below = harness()
    below.chain.allowance = GAS_TOPUP_SELL - 1n
    const step = await below.gas.buy()
    expect(step).to.deep.include({ state: 'pending', sold: '0.50 USDC' })
    expect(below.signed).deep.eq(['Permit', 'Order'])
    expect(below.record()).to.include({ status: 'posted', uid: uidOf(step), permitNonce: '7' })
    expect(below.book.only().uid).eq(uidOf(step))
  })

  it('1 the permit run out of band, then order 1 expires unfilled: it may have filled, and the next call is refused while the 0.50 USDC allowance stands', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    expect(await h.book.runPermit(h.book.posts[0].appData)).eq(true) // nonce 7 -> 8, and a standing 0.50 USDC allowance
    h.chain.timestamp = BigInt(h.record()!.validTo + GAS_TOPUP_EXPIRY_GRACE_SECONDS + 1)
    expect(await h.gas.buy()).to.deep.include({ state: 'expired', uid, sold: 'up to 0.50 USDC', reason: GAS_TOPUP_MAY_HAVE_FILLED })
    const ended = h.record()!
    expect(ended).to.include({ status: 'expired', over: true })
    expect(h.chain.allowance).eq(GAS_TOPUP_SELL)
    expect(await h.gas.buy()).deep.eq({ state: 'refused', reason: ALLOWANCE_STANDS })
    expect(h.signed).deep.eq(['Permit', 'Order']) // order 1's permit and order, and nothing since
    expect(h.book.quotes).length(1); expect(h.book.posts).length(1)
    expect(h.record()).deep.eq(ended) // order 1's record stays as it ended
    expect(readGasTopUpHistory(h.paths.home)).deep.eq([]) // no new record replaced it, so nothing was archived
  })
})

describe('buy_gas: a quote id is kept only when it is a non-negative safe integer', () => {
  it('2 B7: a quote id of -1 is left out: the order is posted without it, the record has none, and the record stays readable', async () => {
    const h = harness()
    quoteIdIs(h, -1)
    const first = await h.gas.buy()
    expect(first.state).eq('pending')
    expect(h.signed).deep.eq(['Permit', 'Order'])
    expect(h.book.posts).length(1)
    expect(h.book.posts[0]).not.to.have.property('quoteId')
    expect(h.record()).not.to.have.property('quoteId')
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid: uidOf(first) }) // not refused as unreadable
    expect(await blockedMessage(h)).eq(GAS_TOPUP_WAIT_MESSAGE)
  })

  it('2 a quote id of 0 is kept: the order is posted with it and the record holds it', async () => {
    const h = harness()
    quoteIdIs(h, 0)
    const first = await h.gas.buy()
    expect(first.state).eq('pending')
    expect(h.book.posts[0].quoteId).eq(0)
    expect(h.record()?.quoteId).eq(0)
    expect(await h.gas.buy()).to.deep.include({ state: 'pending', uid: uidOf(first) })
  })
})
