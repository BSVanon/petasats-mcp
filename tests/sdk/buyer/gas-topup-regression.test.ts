// FIX-C1 item 9: the two review probes (sequential fills behind a 400; two live orders), kept as regression tests.
// They use only the gas module's API as it stood at ad6b4224 (makeBuyerGasTopUp, buy()), so they also run against
// that commit, where each one fails: there the order book's answer ended a record.
import { expect } from 'chai'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { makeCowOrderBook } from '../../../src/sdk/buyer/gas-topup-api'
import { makeBuyerGasTopUp } from '../../../src/sdk/buyer/gas-topup'
import { initialiseBuyerHome } from '../../../src/sdk/buyer/local-state'
import type { GasTopUpStep } from '../../../src/sdk/buyer/types'
import { FakeCowOrderBook, FakeGasChain } from './helpers/gas-fakes'

/** The 400 the probes' order book answers while it keeps (and may fill) the order. */
const REFUSED = { status: 400, body: { errorType: 'InsufficientAllowance', description: 'x' } }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const uidOf = (step: GasTopUpStep): string => { if (step.state === 'refused') throw new Error(`refused: ${step.reason}`); return step.uid }

function setup() {
  const paths = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-regression-')))
  const account = privateKeyToAccount(generatePrivateKey())
  const chain = new FakeGasChain(); const book = new FakeCowOrderBook(chain)
  const gas = makeBuyerGasTopUp({ home: paths.home, owner: account.address, chain, api: makeCowOrderBook({ fetch: book.fetch, timeoutMs: 200 }), signTypedData: account.signTypedData, now: chain.clock })
  return { chain, book, gas }
}

describe('buy_gas review probes, as regressions', () => {
  it('sequential fills behind a 400: an order book that stores and fills each order but answers 400 gets 0.50 USDC once, never once per call', async () => {
    const { chain, book, gas } = setup()
    book.ethUsd = 19_900n // an ETH price just under the kit's $20,000 limit, so each fill pays close to the least the kit accepts
    const settleErrors: unknown[] = []
    book.postReply = (body) => {
      void book.acceptOrder(body).then((reply) => { if (reply.status === 201) book.settle(reply.body as string) }).catch((error) => { settleErrors.push(error) })
      return REFUSED
    }
    const states: string[] = []
    for (let i = 0; i < 5; i++) {
      const step = await gas.buy(); states.push(step.state + (step.state === 'rejected' ? `:${step.sold}` : ''))
      await sleep(20); chain.timestamp += 15n
    }
    expect(settleErrors).deep.eq([])
    expect(states).deep.eq(['rejected:nothing so far', 'filled', 'refused', 'refused', 'refused'])
    expect(2_000_000n - chain.usdc).eq(500_000n)
    expect(book.orders.size).eq(1)
  })

  it('S1 an order book that stores the order but answers 400, then the permit run out of band: the next call reports that order and signs no second one', async () => {
    const h = setup()
    h.book.postReply = (body) => { void h.book.acceptOrder(body); return REFUSED }
    const first = await h.gas.buy()
    expect(first.state).eq('rejected')
    await sleep(20)
    expect([...h.book.orders.values()].map((o) => o.status)).deep.eq(['open']) // the order is live in the book
    expect(await h.book.runPermit(h.book.posts[0].appData)).eq(true) // nonce +1 and a standing 0.50 USDC allowance
    h.book.postReply = undefined; h.chain.timestamp += 30n // well inside the order's validTo
    const second = await h.gas.buy()
    expect(second).to.deep.include({ state: 'pending', uid: uidOf(first) })
    expect(h.book.orders.size).eq(1)
  })

  it('S3 an order book that says fulfilled for a live order, then the permit run out of band: the next call reports that order and signs no second one', async () => {
    const h = setup()
    const first = await h.gas.buy(); expect(first.state).eq('pending')
    h.book.getReply = (uid) => ({ status: 200, body: { uid, status: 'fulfilled', executedBuyAmount: '1' } })
    expect((await h.gas.buy()).state).eq('filled') // reported; nothing on chain changed
    expect(await h.book.runPermit(h.book.posts[0].appData)).eq(true) // the nonce moves on, so a nonce lag no longer holds the kit
    h.book.getReply = undefined; h.chain.timestamp += 30n
    const third = await h.gas.buy()
    expect(third).to.deep.include({ state: 'pending', uid: uidOf(first) })
    expect([...h.book.orders.values()].map((o) => o.status)).deep.eq(['open'])
  })
})
