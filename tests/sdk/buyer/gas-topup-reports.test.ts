// FIX-C2 item 5: buy_gas reports only what it knows. A refusal is stored alone and the step says what it means for the
// sale; a record that ends drops what no longer applies; the order book's ETH amount is shown only when it is plausible.
import { expect } from 'chai'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { makeCowOrderBook } from '../../../src/sdk/buyer/gas-topup-api'
import { formatEth, makeBuyerGasTopUp } from '../../../src/sdk/buyer/gas-topup'
import { GAS_TOPUP_MAY_HAVE_FILLED, gasTopUpPath, readGasTopUp, readGasTopUpHistory } from '../../../src/sdk/buyer/gas-topup-state'
import { initialiseBuyerHome } from '../../../src/sdk/buyer/local-state'
import type { GasTopUpStep } from '../../../src/sdk/buyer/types'
import { FakeCowOrderBook, FakeGasChain } from './helpers/gas-fakes'

const REFUSED = { status: 400, body: { errorType: 'InsufficientAllowance', description: 'x' } }
const REFUSAL = 'the CoW Protocol order book refused the order (HTTP 400, InsufficientAllowance)'
const SO_FAR = 'nothing was sold so far, but the kit treats the order as open until it expires; call buy_gas again after it expires to check it'
const EXPIRED_UNSOLD = 'no CoW Protocol solver filled the order before it expired; nothing was sold'

function harness() {
  const paths = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-reports-')))
  const account = privateKeyToAccount(generatePrivateKey())
  const chain = new FakeGasChain()
  const book = new FakeCowOrderBook(chain)
  let orders = 0
  const signTypedData = (async (parameters: any) => { if (parameters.primaryType === 'Order') orders++; return account.signTypedData(parameters) }) as LocalAccount['signTypedData']
  const gas = makeBuyerGasTopUp({ home: paths.home, owner: account.address, chain, api: makeCowOrderBook({ fetch: book.fetch, timeoutMs: 200 }), signTypedData, now: chain.clock })
  return { paths, chain, book, gas, orders: () => orders, record: () => readGasTopUp(paths.home) }
}
type Harness = ReturnType<typeof harness>

const uidOf = (step: GasTopUpStep): string => { if (step.state === 'refused') throw new Error(`refused: ${step.reason}`); return step.uid }
const pastExpiry = (h: Harness): void => { h.chain.timestamp = BigInt(h.record()!.validTo) + 121n }
/** The order book says fulfilled with this amount, while the chain may not show any fill. */
const bookSaysFilled = (h: Harness, amount: () => string): void => {
  h.book.getReply = (asked) => ({ status: 200, body: { uid: asked, status: 'fulfilled', executedBuyAmount: amount() } })
}

describe('buy_gas: honest reports', () => {
  it('5 a 4xx stores the refusal alone; the step says nothing was sold so far until the record is over, then that nothing was sold', async () => {
    const h = harness()
    h.book.postReply = () => REFUSED
    const first = await h.gas.buy()
    expect(first).to.deep.include({ state: 'rejected', sold: 'nothing so far', reason: `${REFUSAL}; ${SO_FAR}` })
    expect(h.record()).to.include({ status: 'rejected', reason: REFUSAL })
    h.book.postReply = undefined
    expect(await h.gas.buy()).to.deep.include({ state: 'rejected', uid: uidOf(first), sold: 'nothing so far', reason: `${REFUSAL}; ${SO_FAR}` })
    pastExpiry(h)
    expect(await h.gas.buy()).to.deep.include({ state: 'rejected', uid: uidOf(first), sold: 'nothing', reason: `${REFUSAL}; nothing was sold` })
    expect(h.record()).to.include({ status: 'rejected', reason: REFUSAL, over: true })
  })

  it('5 the uid-mismatch answer is reported the same way, before and after the record is over', async () => {
    const h = harness()
    const foreign = `0x${'ab'.repeat(56)}`
    h.book.postReply = () => ({ status: 201, body: foreign })
    const first = await h.gas.buy()
    const mismatch = `the CoW Protocol order book answered with uid ${foreign}, not this order's uid ${uidOf(first)}; it is not treated as posted`
    expect(first).to.deep.include({ state: 'rejected', sold: 'nothing so far', reason: `${mismatch}; ${SO_FAR}` })
    expect(h.record()?.reason).eq(mismatch)
    pastExpiry(h)
    expect(await h.gas.buy()).to.deep.include({ state: 'rejected', sold: 'nothing', reason: `${mismatch}; nothing was sold` })
  })

  it('5 a refused order whose permit nonce moved before it expired keeps the may-have-filled outcome', async () => {
    const h = harness()
    h.book.postReply = () => REFUSED
    const uid = uidOf(await h.gas.buy())
    expect(await h.book.runPermit(h.book.posts[0].appData)).eq(true) // run out of band: a stored copy of the order could still fill
    pastExpiry(h)
    expect(await h.gas.buy()).to.deep.include({ state: 'expired', uid, sold: 'up to 0.50 USDC', reason: GAS_TOPUP_MAY_HAVE_FILLED })
  })

  it('5 P6: a record that got a 4xx and then filled drops the refusal, in gas-topup.json and in the history', async () => {
    const h = harness()
    h.book.postReply = () => 'fill-then-refuse'
    const uid = uidOf(await h.gas.buy())
    expect(h.record()?.reason).eq(REFUSAL)
    h.book.postReply = undefined
    expect(await h.gas.buy()).to.deep.include({ state: 'filled', uid })
    expect(h.record()).to.include({ status: 'filled', over: true })
    expect(h.record()).not.to.have.property('reason')
    h.chain.eth = 0n // the kit spent its gas, so the next call signs a new order and archives this one
    expect((await h.gas.buy()).state).eq('pending')
    const [archived] = readGasTopUpHistory(h.paths.home)
    expect(archived).to.include({ uid, status: 'filled' })
    expect(archived).not.to.have.property('reason')
  })

  it('5 a record the order book called filled that then expires on chain drops the order book\'s amount', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    bookSaysFilled(h, () => h.record()!.buyAmountMin)
    expect(await h.gas.buy()).to.deep.include({ state: 'filled', uid })
    expect(h.record()?.executedBuyAmount).eq(h.record()!.buyAmountMin)
    pastExpiry(h)
    expect(await h.gas.buy()).to.deep.include({ state: 'expired', uid, sold: 'nothing', reason: EXPIRED_UNSOLD })
    expect(h.record()).not.to.have.property('executedBuyAmount')
  })

  it('5 P5: the order book\'s 999999 ETH is never shown or stored, even once the chain shows the real fill', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    h.book.settle(uid) // the real fill: the order's minimum of ETH arrives
    bookSaysFilled(h, () => '999999000000000000000000')
    const step = await h.gas.buy()
    expect(step).to.deep.include({ state: 'filled', uid })
    expect(step).not.to.have.property('eth_received')
    expect(h.record()).to.include({ over: true })
    expect(h.record()).not.to.have.property('executedBuyAmount')
    expect(readFileSync(gasTopUpPath(h.paths.home), 'utf8')).not.include('999999')
  })

  it('5 eth_received is shown and stored only from buyAmountMin up to twice it', async () => {
    const probe = harness()
    uidOf(await probe.gas.buy())
    const min = BigInt(probe.record()!.buyAmountMin) // the same quote, so the same minimum, in every harness below
    for (const [amount, shown] of [[min - 1n, false], [min, true], [2n * min, true], [2n * min + 1n, false]] as const) {
      const h = harness()
      uidOf(await h.gas.buy())
      expect(h.record()?.buyAmountMin).eq(min.toString())
      bookSaysFilled(h, () => amount.toString())
      const step = await h.gas.buy() // the order book's word alone; the chain has not shown the fill
      expect(step.state, String(amount)).eq('filled')
      if (shown) {
        expect(step, String(amount)).to.deep.include({ eth_received: formatEth(amount) })
        expect(h.record()?.executedBuyAmount, String(amount)).eq(amount.toString())
      } else {
        expect(step, String(amount)).not.to.have.property('eth_received')
        expect(h.record(), String(amount)).not.to.have.property('executedBuyAmount')
      }
    }
  })

  it('5 wallet_info\'s gas record says open while the record still blocks, and false once the chain has ended it', async () => {
    const h = harness()
    const uid = uidOf(await h.gas.buy())
    expect(h.gas.view()).deep.eq({ status: 'posted', uid, open: true })
    bookSaysFilled(h, () => h.record()!.buyAmountMin)
    await h.gas.buy()
    expect(h.gas.view()).deep.eq({ status: 'filled', uid, open: true }) // the order book's word alone: it still blocks
    pastExpiry(h)
    await h.gas.buy()
    expect(h.gas.view()).deep.eq({ status: 'expired', uid, open: false })
  })
})
