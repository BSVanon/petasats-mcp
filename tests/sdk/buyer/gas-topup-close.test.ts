// FIX-C1 items 4 and 5: close never says closed while a gas order could still fill, whatever the USDC balance, and it
// checks the gas record exactly as buy_gas does.
import { expect } from 'chai'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { createBuyerKit } from '../../../src/sdk/buyer/buyer-kit'
import { CLOSED_STOP_REASON, closeKitStep } from '../../../src/sdk/buyer/close'
import { makeCowOrderBook } from '../../../src/sdk/buyer/gas-topup-api'
import { makeBuyerGasTopUp } from '../../../src/sdk/buyer/gas-topup'
import { GasTopUpUnreadableError, gasTopUpPath, readGasTopUp } from '../../../src/sdk/buyer/gas-topup-state'
import { readSpendingStop, stopSpending } from '../../../src/sdk/buyer/stop'
import type { GasTopUpStep } from '../../../src/sdk/buyer/types'
import { DEST_BASE, home, OWN_BSV, PAIR } from './close-helpers'
import { FakeCowOrderBook, FakeGasChain } from './helpers/gas-fakes'

/** The approved close wait (close-gas.ts), word for word. */
const WAIT = { state: 'in_progress', did: 'nothing sent; a gas purchase (buy_gas) is still finishing and may use 0.50 USDC', next: 'call again; the USDC goes out once the gas order has filled or expired', call_again_after_seconds: 30, sent: [] }

/** The real kit, gas module and close over fakes. onRead, when set, runs inside the given balance read of a call. */
function closeHarness() {
  const paths = home()
  const account = privateKeyToAccount(generatePrivateKey())
  const chain = new FakeGasChain()
  const book = new FakeCowOrderBook(chain)
  const gasTopUp = makeBuyerGasTopUp({ home: paths.home, owner: account.address, chain, api: makeCowOrderBook({ fetch: book.fetch, timeoutMs: 200 }), signTypedData: account.signTypedData, now: chain.clock })
  const sends: Array<{ asset: 'USDC' | 'ETH'; to: string; value: bigint }> = []
  const hash = (): string => `0x${(sends.length).toString(16).padStart(64, '0')}`
  const never = async (): Promise<never> => { throw new Error('the counterparty is never reached in these tests') }
  const state = { reads: 0, onRead: undefined as undefined | { at: number; run: () => Promise<void> } }
  const kit = createBuyerKit({}, {
    spendingStopped: () => readSpendingStop(paths), stopSpending: (reason) => stopSpending(paths, reason),
    store: { list: async () => [], get: async () => undefined, put: async () => {} },
    door: { quote: never, admit: never }, executor: { execute: never },
    wallet: {
      baseAddress: account.address, bsvAddress: OWN_BSV,
      balances: async () => {
        const read = { usdc: chain.usdc, eth: chain.eth, claimedBsvSats: 0n, unconfirmedBsvSats: 0n }
        state.reads++
        const hook = state.onRead
        if (hook && state.reads === hook.at) { state.onRead = undefined; await hook.run() }
        return read // the balances as read, before anything the hook did
      },
      withdrawBsv: async () => ({ sats: 0n }),
      transferUsdc: async (to, value) => { sends.push({ asset: 'USDC', to, value }); chain.usdc -= value; return { hash: hash(), status: 'success' } },
      transferEth: async (to, value) => { sends.push({ asset: 'ETH', to, value }); chain.eth -= value; return { hash: hash(), status: 'success' } },
    },
    gasTopUp,
  })
  const close = () => closeKitStep({ kit, paths }, PAIR)
  return { paths, account, chain, book, kit, sends, state, close, record: () => readGasTopUp(paths.home)! }
}
type Harness = ReturnType<typeof closeHarness>

async function rejection(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { return error instanceof Error ? error.message : String(error) }
  throw new Error('expected a refusal')
}
const uidOf = (step: GasTopUpStep): string => { if (step.state === 'refused') throw new Error(`refused: ${step.reason}`); return step.uid }
const expire = (h: Harness): void => { h.chain.timestamp = BigInt(h.record().validTo) + 121n }

async function expectStoppedBuyGas(h: Harness): Promise<void> {
  const quotes = h.book.quotes.length
  expect(await rejection(h.kit.buyGas!())).eq('spending is stopped; the user removes the stop with `npx petasats-mcp resume`')
  expect(h.book.quotes).length(quotes)
}

describe('close_kit and an open gas order', () => {
  it('5 USDC is 0 and a gas record is live: close waits after its STOP, buy_gas refuses, and close finishes once the order has expired', async () => {
    const h = closeHarness()
    uidOf(await h.kit.buyGas!())
    h.chain.usdc = 0n // however the USDC left, the order can still fill until the chain shows otherwise
    expect(await h.close()).deep.eq(WAIT)
    expect(readSpendingStop(h.paths)?.reason).eq(CLOSED_STOP_REASON)
    await expectStoppedBuyGas(h)
    expect(await h.close()).deep.eq(WAIT) // the STOP is written, and the next call still waits
    expire(h)
    expect((await h.close()).state).eq('closed')
    expect(h.sends).length(0)
  })

  it('5 a buy_gas that runs during close\'s last balance read, before its STOP, is caught: close waits, then refuses as funds arrived', async () => {
    const h = closeHarness()
    h.chain.usdc = 0n
    let gas: GasTopUpStep | undefined
    // The fresh read in close's empty check (the second read of the call) sees no USDC; 0.50 USDC arrives just after
    // it, and buy_gas spends it before close writes its STOP.
    h.state.onRead = { at: 2, run: async () => { h.chain.usdc = 500_000n; gas = await h.kit.buyGas!() } }
    expect(await h.close()).deep.eq(WAIT)
    expect(gas?.state).eq('pending')
    expect(readSpendingStop(h.paths)?.reason).eq(CLOSED_STOP_REASON)
    await expectStoppedBuyGas(h)
    expect(await h.close()).deep.eq(WAIT)
    expire(h)
    expect(await h.close()).deep.eq({ state: 'refused', reason: 'funds arrived after this kit was closed; run `npx petasats-mcp resume` in a terminal, then close_kit again', sent: [] })
    expect(h.sends).length(0); expect(h.book.orders.size).eq(1)
  })

  it('5 buy_gas between two close calls: the next close waits for the order, and sends the USDC once it has filled', async () => {
    const h = closeHarness()
    expect(await h.close()).deep.eq({ state: 'refused', reason: 'ETH is needed for Base gas', sent: [] })
    const uid = uidOf(await h.kit.buyGas!())
    expect(await h.close()).deep.eq(WAIT)
    expect(h.sends).length(0)
    h.book.settle(uid)
    expect((await h.close()).state).eq('in_progress')
    expect(h.sends).deep.eq([{ asset: 'USDC', to: DEST_BASE, value: 1_500_000n }])
  })

  it('6 a gas record that appears at the last moment before the STOP is caught: close waits, and its STOP is written', async () => {
    const h = closeHarness()
    uidOf(await h.kit.buyGas!())
    h.chain.usdc = 0n
    const path = gasTopUpPath(h.paths.home)
    const aside = `${path}.aside`
    renameSync(path, aside) // every gas check close makes before its STOP finds no record
    // close reads its clock for closedAt just before it writes its final record and its STOP: the record is back by then.
    const now = (): number => { if (existsSync(aside)) renameSync(aside, path); return Date.now() }
    expect(await closeKitStep({ kit: h.kit, paths: h.paths, now }, PAIR)).deep.eq(WAIT)
    expect(existsSync(aside)).eq(false)
    expect(readSpendingStop(h.paths)?.reason).eq(CLOSED_STOP_REASON)
    await expectStoppedBuyGas(h)
    expire(h)
    expect((await h.close()).state).eq('closed')
    expect(h.sends).length(0)
  })

  it('4 close checks the gas record as buy_gas does: a well-formed record that does not rebuild its order refuses, with no retry, before anything is sent or stopped', async () => {
    for (const usdc of [2_000_000n, 0n]) {
      const altered = closeHarness()
      await altered.kit.buyGas!()
      writeFileSync(gasTopUpPath(altered.paths.home), JSON.stringify({ ...altered.record(), buyAmountMin: '1' }), { mode: 0o600 })
      expect(altered.record().buyAmountMin).eq('1') // the shape still reads
      altered.chain.usdc = usdc
      const fixed = new GasTopUpUnreadableError(altered.paths.home, 'its order does not match its uid').message
      expect(await altered.close(), `${usdc}`).deep.eq({ state: 'refused', reason: fixed, sent: [] })
      expect(readSpendingStop(altered.paths), `${usdc}`).eq(undefined)
      expect(altered.sends).length(0)
    }
    const foreign = closeHarness()
    await foreign.kit.buyGas!()
    writeFileSync(gasTopUpPath(foreign.paths.home), JSON.stringify({ ...foreign.record(), owner: privateKeyToAccount(generatePrivateKey()).address }), { mode: 0o600 })
    const altered = readFileSync(gasTopUpPath(foreign.paths.home))
    expect(await foreign.close()).deep.eq({ state: 'refused', reason: new GasTopUpUnreadableError(foreign.paths.home, "it names another wallet's order").message, sent: [] })
    expect(readFileSync(gasTopUpPath(foreign.paths.home)).equals(altered)).eq(true) // never overwritten
    expect(readSpendingStop(foreign.paths)).eq(undefined)
  })
})
