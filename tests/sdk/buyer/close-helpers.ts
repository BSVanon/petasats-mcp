// Shared fixtures for the close-down tests. Not a test file itself (the name does not end in .test.ts).
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { createHash } from 'crypto'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CloseRecord } from '../../../src/sdk/buyer/close-record'
import { initialiseBuyerHome, type BuyerHome } from '../../../src/sdk/buyer/local-state'
import { createBuyerRuntime } from '../../../src/sdk/buyer/runtime/runtime'
import type { BuyerKit, BuyerSwapRecord, BuyerSweepPlan, BuyerWithdrawalReconcileOutcome } from '../../../src/sdk/buyer/types'

// Own wallet addresses for the fake kit; distinct destination addresses the close goes to.
export const OWN_BASE = '0x2222222222222222222222222222222222222222'
export const OWN_BSV = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'
export const DEST_BASE = '0x3333333333333333333333333333333333333333'
export const DEST_BSV = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
export const OTHER_BASE = '0x4444444444444444444444444444444444444444'
// A second valid mainnet P2PKH destination (the compressed-key address of private key 1).
export const OTHER_BSV = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH'
// A real checksummed address with one letter's case flipped: fails isAddress(x, { strict: true }).
export const NON_CHECKSUMMED_BASE = '0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const ZERO_BASE = '0x0000000000000000000000000000000000000000'
export const NON_P2PKH_BSV = 'not-a-valid-bsv-address'
export const PAIR = { baseAddress: DEST_BASE, bsvAddress: DEST_BSV }
// Each fails the one sweep shape check (a plan before its broadcast, or the one saved in close.json): no inputs, a txid
// that is not hex, 0 sats, an input with no vout, a vout with a leading zero, a short input txid.
const OUTPOINT = `${'d'.repeat(64)}.0`
export const BAD_SWEEPS: Array<{ txid: string; sats: string; inputs: string[] }> = [
  { txid: 'c'.repeat(64), sats: '5000', inputs: [] }, { txid: 'g'.repeat(64), sats: '5000', inputs: [OUTPOINT] }, { txid: 'c'.repeat(64), sats: '0', inputs: [OUTPOINT] },
  { txid: 'c'.repeat(64), sats: '5000', inputs: ['d'.repeat(64)] }, { txid: 'c'.repeat(64), sats: '5000', inputs: [`${'d'.repeat(64)}.01`] },
  { txid: 'c'.repeat(64), sats: '5000', inputs: [`${'d'.repeat(63)}.0`] },
]

/** withdrawBase's gas-dust refusal, carrying the ETH balance it judged too small for its gas (as the real kit does). */
export function gasDust(judgedWei: bigint): Error {
  return Object.assign(new Error('the ETH balance does not cover the Base gas for a withdrawal; nothing was sent'), { gasDustBalanceWei: judgedWei })
}

export function home(): BuyerHome {
  return initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-close-')))
}

export function row(id: string, stage: BuyerSwapRecord['stage'], more: Partial<BuyerSwapRecord> = {}): BuyerSwapRecord {
  return {
    swapId: id.repeat(32), requestId: 'r'.repeat(16), stage, amountIn: '1',
    quote: { from: 'USDC', to: 'BSV', route: 'bridge', amountIn: 1n, amountOut: 1n, expiry: 99, quoteId: 'q'.repeat(16), doorQuoteId: 'q'.repeat(16), usdcBaseUnits: 1n, bsvSats: 1n },
    createdAtMs: 1, updatedAtMs: 1, ...more,
  }
}

function writeOwnerOnly(file: string, value: unknown): void {
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  chmodSync(file, 0o600)
}

/** A raw Base withdrawal-intent record file, in the exact shape withdrawal-intent.ts validates. */
export function writeWithdrawalIntent(paths: BuyerHome, hash: string, asset: 'USDC' | 'ETH', to: string, more: { createdAtMs?: number; amount?: string; nonceConsumedAtBlock?: string } = {}): void {
  const record = {
    asset, to, amount: more.amount ?? '1', nonce: 0, hash, signedTx: `0x${'d'.repeat(10)}`, createdAtMs: more.createdAtMs ?? Date.now(), state: 'pending',
    ...(more.nonceConsumedAtBlock === undefined ? {} : { nonceConsumedAtBlock: more.nonceConsumedAtBlock }),
  }
  writeOwnerOnly(join(paths.withdrawalsDir, `${hash.toLowerCase()}.json`), record)
}

/** Test-only shortcut for "this Base withdrawal resolved": the real resolver needs a live nonce lookup. */
export function resolveWithdrawalIntent(paths: BuyerHome, hash: string, status: 'success' | 'sent' | 'reverted' | 'not-sent' = 'success'): void {
  const file = join(paths.withdrawalsDir, `${hash.toLowerCase()}.json`)
  writeOwnerOnly(file, { ...(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>), state: 'done', status })
}

export function writeCloseFile(paths: BuyerHome, value: unknown): string {
  const file = join(paths.home, 'close.json')
  writeOwnerOnly(file, value)
  return file
}

/** close.json as written, without the reader's checks (a test may need to see a record the reader refuses). */
export function readCloseFile(paths: BuyerHome): CloseRecord {
  return JSON.parse(readFileSync(join(paths.home, 'close.json'), 'utf8')) as CloseRecord
}

export interface FakeState { usdc: bigint; eth: bigint; claimedBsvSats: bigint; swaps: BuyerSwapRecord[]; unconfirmedBsvSats?: bigint }
type WalletInfo = Awaited<ReturnType<BuyerKit['walletInfo']>>
export interface FakeOverrides {
  walletInfo?: () => Promise<WalletInfo>
  withdrawBsv?: (address: string, opts?: { beforeBroadcast?: (sweep: BuyerSweepPlan) => void | Promise<void> }) => Promise<{ txid?: string; sats: bigint; reason?: string }>
  withdrawBase?: (request: { asset: 'USDC' | 'ETH'; to: string; amount: string }) => Promise<{ asset: 'USDC' | 'ETH'; amount: bigint; to: string; txid: string; status: string }>
  /** Left undefined, the kit does not implement reconcileWithdrawals at all (the "no capability" fallback). */
  reconcileWithdrawals?: () => Promise<BuyerWithdrawalReconcileOutcome | undefined>
  /** Left undefined, the fake accepts every pair. */
  assertWithdrawDestinations?: (to: { base: string; bsv: string }) => Promise<void>
}

export function walletInfoOf(state: FakeState): WalletInfo {
  return {
    baseAddress: OWN_BASE, bsvAddress: OWN_BSV, usdc: state.usdc, eth: state.eth, claimedBsvSats: state.claimedBsvSats,
    unconfirmedBsvSats: state.unconfirmedBsvSats ?? 0n, capUsdPerSwap: 100,
  }
}

/**
 * A fake BuyerKit over a live FakeState the test mutates between calls. Its default withdrawBase also writes a
 * real withdrawal-intent record (like the real one does), so tests see the same ordering the real kit gives.
 */
export function fakeKit(paths: BuyerHome, state: FakeState, overrides: FakeOverrides = {}) {
  const calls = { withdrawBsv: 0, withdrawBase: [] as Array<{ asset: string; amount: string }>, reconcileWithdrawals: 0 }
  let sendCount = 0
  const notImplemented = async (): Promise<never> => { throw new Error('not used by close.ts') }
  const kit: BuyerKit = {
    quote: notImplemented, convert: notImplemented, startSwap: notImplemented, recover: notImplemented,
    status: async () => state.swaps,
    walletInfo: async () => overrides.walletInfo ? overrides.walletInfo() : walletInfoOf(state),
    withdrawBsv: async (address, opts) => {
      calls.withdrawBsv++
      if (overrides.withdrawBsv) return overrides.withdrawBsv(address, opts)
      return { sats: state.claimedBsvSats, txid: `0x${'b'.repeat(64)}` }
    },
    withdrawBase: async (request) => {
      calls.withdrawBase.push({ asset: request.asset, amount: request.amount })
      if (overrides.withdrawBase) return overrides.withdrawBase(request)
      sendCount++
      const hash = `0x${sendCount.toString().padStart(64, '0')}`
      writeWithdrawalIntent(paths, hash, request.asset, request.to)
      return { asset: request.asset, amount: request.asset === 'USDC' ? state.usdc : state.eth, to: request.to, txid: hash, status: 'success' }
    },
    ...(overrides.reconcileWithdrawals ? { reconcileWithdrawals: async () => { calls.reconcileWithdrawals++; return overrides.reconcileWithdrawals!() } } : {}),
    assertWithdrawDestinations: overrides.assertWithdrawDestinations ?? (async () => {}),
  }
  return { kit, calls }
}

export interface RuntimeCoin { tx_hash: string; tx_pos: number; value: number; confirmations: number; height: number }
export function coin(hashChar: string, value: number, confirmations = 1, txPos = 0): RuntimeCoin {
  return { tx_hash: hashChar.repeat(64), tx_pos: txPos, value, confirmations, height: confirmations > 0 ? 900_000 : 0 }
}

/**
 * The real kit and runtime over fake rails: Base balances, a BSV coin list (the one list both balances and the sweep
 * read), and a relay. The fake sweep builder keeps the real one's shape: every confirmed coin is an input, the txid is
 * a pure function of the inputs, and the output is the total less a 100-sat fee. `events` records the step order.
 */
export async function runtimeKit(paths: BuyerHome, rails: { usdc?: bigint; eth?: bigint; coins: RuntimeCoin[]; relay?: (txid: string) => Promise<void> }) {
  writeOwnerOnly(paths.configPath, { doorIdentity: `02${'1'.repeat(64)}`, baseRpcUrls: ['http://synthetic.invalid'], bsvSources: [], anvilHost: 'http://synthetic.invalid', capUsdPerSwap: 100 })
  const events: string[] = []
  const buildSweepTx = async (opts: { coins: RuntimeCoin[] }) => {
    const txid = createHash('sha256').update(opts.coins.map((c) => `${c.tx_hash}.${c.tx_pos}`).join(',')).digest('hex')
    const outputSatoshis = opts.coins.reduce((total, c) => total + c.value, 0) - 100
    if (outputSatoshis <= 546) throw new Error(`buyer sweep: output ${outputSatoshis} sat is at or below dust (546)`)
    events.push(`build ${txid}`)
    return { rawTx: `raw-${txid}`, atomicBeefHex: 'beef', outputSatoshis, tx: { id: () => txid } }
  }
  const bsvRails = {
    chainTracker: {},
    unspentFor: async () => { events.push('unspent'); return rails.coins.map((c) => ({ ...c })) },
    fetchBeef: async () => ({ merklePath: {} }),
    broadcast: async (rawTx: string) => {
      const txid = rawTx.replace(/^raw-/, '')
      events.push(`broadcast ${txid}`)
      await rails.relay?.(txid)
      return txid
    },
  }
  const factories = {
    makeIdentityOnlyWallet: () => ({}), makeAnvilMessageBoxComms: () => ({}), makeMessageBoxDoorClient: () => ({}),
    makeBuyerEvmRails: async () => ({ client: {}, balances: async () => ({ usdc: rails.usdc ?? 0n, eth: rails.eth ?? 0n }), assertSafeForNewLock: () => {}, pool: {} }),
    makeBuyerBsvRails: () => bsvRails, buildSweepTx,
    makeBuyerEngine: () => ({ execute: async () => ({ ok: true }), recoverAll: async () => new Map() }),
  }
  // The fakes cover only what this kit path reaches, so the factory types are not satisfied in full.
  const runtime = await createBuyerRuntime({ home: paths.home, log: () => {}, factories: factories as any })
  return { kit: runtime.kit, events }
}
