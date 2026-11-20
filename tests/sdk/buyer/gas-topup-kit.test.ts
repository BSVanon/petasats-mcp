import { expect } from 'chai'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { createBuyerKit } from '../../../src/sdk/buyer/buyer-kit'
import { closeKitStep } from '../../../src/sdk/buyer/close'
import { makeCowOrderBook } from '../../../src/sdk/buyer/gas-topup-api'
import { makeBuyerGasTopUp } from '../../../src/sdk/buyer/gas-topup'
import { BUY_GAS_HINT, GAS_TOPUP_HISTORY_FILE, GAS_TOPUP_SWAP_MESSAGE, GAS_TOPUP_WAIT_MESSAGE, gasTopUpPath } from '../../../src/sdk/buyer/gas-topup-state'
import { initialiseBuyerHome } from '../../../src/sdk/buyer/local-state'
import { createBuyerRuntime } from '../../../src/sdk/buyer/runtime/runtime'
import { readSpendingStop, stopSpending } from '../../../src/sdk/buyer/stop'
import type { GasTopUpStep } from '../../../src/sdk/buyer/types'
import { FakeCowOrderBook, FakeGasChain } from './helpers/gas-fakes'

const DEST_BASE = '0x3333333333333333333333333333333333333333'
const DEST_BSV = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
const OWN_BSV = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'

/** The real kit and the real gas module, over a fake Base chain and a fake CoW Protocol order book. */
function kitHarness() {
  const paths = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-kit-')))
  const account = privateKeyToAccount(generatePrivateKey())
  const chain = new FakeGasChain()
  const book = new FakeCowOrderBook(chain)
  let orders = 0
  const signTypedData = (async (parameters: any) => { if (parameters.primaryType === 'Order') orders++; return account.signTypedData(parameters) }) as LocalAccount['signTypedData']
  const gasTopUp = makeBuyerGasTopUp({ home: paths.home, owner: account.address, chain, api: makeCowOrderBook({ fetch: book.fetch, timeoutMs: 200 }), signTypedData, now: chain.clock })
  const sends: Array<{ asset: 'USDC' | 'ETH'; to: string; value: bigint }> = []
  const hash = (): string => `0x${(sends.length).toString(16).padStart(64, '0')}`
  const never = async (): Promise<never> => { throw new Error('the counterparty is never reached in these tests') }
  const kit = createBuyerKit({}, {
    spendingStopped: () => readSpendingStop(paths), stopSpending: (reason) => stopSpending(paths, reason),
    store: { list: async () => [], get: async () => undefined, put: async () => {} },
    door: { quote: never, admit: never }, executor: { execute: async () => ({ ok: true }) },
    wallet: {
      baseAddress: account.address, bsvAddress: OWN_BSV,
      balances: async () => ({ usdc: chain.usdc, eth: chain.eth, claimedBsvSats: 0n, unconfirmedBsvSats: 0n }),
      withdrawBsv: async () => ({ sats: 0n }),
      transferUsdc: async (to, value) => { sends.push({ asset: 'USDC', to, value }); chain.usdc -= value; return { hash: hash(), status: 'success' } },
      transferEth: async (to, value) => { sends.push({ asset: 'ETH', to, value }); chain.eth -= value; return { hash: hash(), status: 'success' } },
    },
    gasTopUp,
  })
  return { paths, account, chain, book, sends, kit, orders: () => orders }
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { return error instanceof Error ? error.message : String(error) }
  throw new Error('expected a refusal')
}

function uidOf(step: GasTopUpStep): string {
  if (step.state === 'refused') throw new Error(`refused: ${step.reason}`)
  return step.uid
}

describe('buy_gas in the kit', () => {
  it('F10 two concurrent buy_gas calls, or buy_gas beside a USDC withdrawal, give one order at most', async () => {
    const h = kitHarness()
    const [first, second] = await Promise.all([h.kit.buyGas!(), h.kit.buyGas!()])
    expect(first.state).eq('pending'); expect(second.state).eq('pending')
    expect(uidOf(second)).eq(uidOf(first))
    expect(h.orders()).eq(1); expect(h.book.orders.size).eq(1); expect(h.book.quotes).length(1)

    const w = kitHarness()
    const [gas, withdrawal] = await Promise.allSettled([w.kit.buyGas!(), w.kit.withdrawBase({ asset: 'USDC', to: DEST_BASE, amount: 'all' })])
    expect(gas.status === 'fulfilled' && gas.value.state).eq('pending')
    expect(withdrawal.status === 'rejected' && (withdrawal.reason as Error).message).eq(GAS_TOPUP_WAIT_MESSAGE)
    expect(w.sends).length(0)
  })

  it('F10 a second process (the CLI close beside a running MCP server) cannot open a kit home that is in use', async () => {
    const h = kitHarness()
    await h.kit.buyGas!()
    const before = readFileSync(gasTopUpPath(h.paths.home))
    const directory = join(h.paths.home, 'kit.lock.d'); mkdirSync(directory, { mode: 0o700 })
    writeFileSync(join(directory, `${process.ppid}-1-${'a'.repeat(16)}`), '') // the running server's entry: a live pid
    let rails = 0
    const refusal = await rejection(createBuyerRuntime({ home: h.paths.home, factories: { makeBuyerEvmRails: async () => { rails++; throw new Error('must not run') } } as any }))
    expect(refusal).include(`another petasats-mcp process (pid ${process.ppid}) is using the buyer home ${h.paths.home}`)
    expect(rails).eq(0)
    expect(readFileSync(gasTopUpPath(h.paths.home)).equals(before)).eq(true)
  })

  it('F11 refuses while spending is stopped, before reading or signing anything', async () => {
    const h = kitHarness()
    stopSpending(h.paths, 'pause')
    expect(await rejection(h.kit.buyGas!())).match(/^spending is stopped/)
    expect(h.chain.reads).eq(0); expect(h.book.quotes).length(0); expect(h.orders()).eq(0)
  })

  it('4 P4: a STOP written while the quote request is in flight: nothing is saved, archived or posted, and the call is refused', async () => {
    const h = kitHarness()
    await h.kit.buyGas!()
    h.chain.timestamp += 1200n + 121n
    expect((await h.kit.buyGas!()).state).eq('expired')
    const before = readFileSync(gasTopUpPath(h.paths.home))
    h.book.quoteReply = (body) => { stopSpending(h.paths, 'user stop'); return h.book.answerQuote(body) }
    expect(await h.kit.buyGas!()).deep.eq({ state: 'refused', reason: 'spending is stopped; the user removes the stop with `npx petasats-mcp resume`' })
    expect(h.book.quotes).length(2); expect(h.book.posts).length(1) // the new order was quoted and never posted
    expect(readFileSync(gasTopUpPath(h.paths.home)).equals(before)).eq(true) // the ended record stays, never replaced
    expect(existsSync(join(h.paths.home, GAS_TOPUP_HISTORY_FILE))).eq(false) // and is not archived
  })

  it('F16 a USDC withdrawal and close wait for an open gas order, and go ahead once it has filled', async () => {
    const h = kitHarness()
    const uid = uidOf(await h.kit.buyGas!())
    expect(await rejection(h.kit.withdrawBase({ asset: 'USDC', to: DEST_BASE, amount: '1000000' }))).eq(GAS_TOPUP_WAIT_MESSAGE)
    expect(await rejection(h.kit.startSwap({ amountIn: 1_000_000n, minBsvOut: 1n }))).eq(GAS_TOPUP_SWAP_MESSAGE)
    const waiting = await closeKitStep({ kit: h.kit, paths: h.paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(waiting).to.deep.include({ state: 'in_progress', call_again_after_seconds: 30, sent: [] })
    if (waiting.state === 'in_progress') expect(waiting.did).include('gas purchase (buy_gas) is still finishing')
    expect(h.sends).length(0)
    h.book.settle(uid)
    const sent = await closeKitStep({ kit: h.kit, paths: h.paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(sent.state).eq('in_progress')
    expect(h.sends).deep.eq([{ asset: 'USDC', to: DEST_BASE, value: 1_500_000n }])
  })

  it('F16 a USDC withdrawal goes ahead once the gas order has expired unfilled; an ETH withdrawal never waits', async () => {
    const h = kitHarness()
    h.chain.eth = 10_000_000_000_000n // below the threshold, so buy_gas still runs
    await h.kit.buyGas!()
    await h.kit.withdrawBase({ asset: 'ETH', to: DEST_BASE, amount: '1000' })
    expect(await rejection(h.kit.withdrawBase({ asset: 'USDC', to: DEST_BASE, amount: '1000000' }))).eq(GAS_TOPUP_WAIT_MESSAGE)
    h.chain.timestamp += 1200n + 121n
    await h.kit.withdrawBase({ asset: 'USDC', to: DEST_BASE, amount: '1000000' })
    expect(h.sends).deep.eq([{ asset: 'ETH', to: DEST_BASE, value: 1000n }, { asset: 'USDC', to: DEST_BASE, value: 1_000_000n }])
    expect((await h.kit.walletInfo()).gas_topup?.status).eq('expired')
  })

  it('F18 a corrupt gas record refuses buy_gas, a USDC withdrawal, a swap and close, and is never overwritten', async () => {
    const h = kitHarness()
    writeFileSync(gasTopUpPath(h.paths.home), '{"uid": "0x', { mode: 0o600 })
    const before = readFileSync(gasTopUpPath(h.paths.home))
    const fixed = `gas-topup.json in ${h.paths.home} cannot be read (it is not valid JSON). It records this kit's gas purchase. Inspect it`
    const gas = await h.kit.buyGas!() // a refusal, never a throw
    expect(gas.state === 'refused' && gas.reason).include(fixed)
    expect(await rejection(h.kit.withdrawBase({ asset: 'USDC', to: DEST_BASE, amount: '1' }))).include(fixed)
    expect(await rejection(h.kit.startSwap({ amountIn: 1_000_000n, minBsvOut: 1n }))).include(fixed)
    const close = await closeKitStep({ kit: h.kit, paths: h.paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(close.state).eq('refused')
    if (close.state === 'refused') expect(close.reason).include(fixed)
    expect((await h.kit.walletInfo()).gas_topup).deep.eq({ status: 'unreadable' })
    expect(readFileSync(gasTopUpPath(h.paths.home)).equals(before)).eq(true)
    expect(h.sends).length(0); expect(h.orders()).eq(0)
    // An empty kit still never closes over a gas record it cannot read.
    const empty = kitHarness(); empty.chain.usdc = 0n
    writeFileSync(gasTopUpPath(empty.paths.home), '{"uid": "0x', { mode: 0o600 })
    const emptyClose = await closeKitStep({ kit: empty.kit, paths: empty.paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(emptyClose.state === 'refused' && emptyClose.reason).include(`gas-topup.json in ${empty.paths.home} cannot be read`)
    expect(readSpendingStop(empty.paths)).eq(undefined)
  })

  it('wallet_info reports the gas purchase; a swap with no ETH names buy_gas; withdraw and close keep the text close_kit leaves to the user', async () => {
    const h = kitHarness()
    expect((await h.kit.walletInfo()).gas_topup).eq(undefined)
    expect(await rejection(h.kit.startSwap({ amountIn: 1_000_000n, minBsvOut: 1n }))).eq(`insufficient ETH balance for Base gas; ${BUY_GAS_HINT}`)
    // The MCP tools add the buy_gas hint to these two (petasats-mcp/tests/gas-tool.test.ts); the kit's text stays fixed.
    expect(await rejection(h.kit.withdrawBase({ asset: 'USDC', to: DEST_BASE, amount: '1' }))).eq('ETH is needed for Base gas')
    const close = await closeKitStep({ kit: h.kit, paths: h.paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(close).to.deep.include({ state: 'refused', reason: 'ETH is needed for Base gas' })
    expect(close).not.to.have.property('retry_after_seconds')
    const uid = uidOf(await h.kit.buyGas!())
    expect((await h.kit.walletInfo()).gas_topup).deep.eq({ status: 'posted', uid, open: true })
  })
})
