import type { Transaction } from '@bsv/sdk'
import { BASE_BLOCK_SECS_FLOOR } from './base-block-time'
import { AmbiguousBsvLockError } from './bsv-lock-discovery'
import { guardInitiatorRevealRunway, SettlementSession, type SettlementRecord } from './settlement-session'
import type { Erc20SwapParams } from './evm/erc20swap'
import { withRequestTimeout } from '../wallet/abortable-request'

/** Defence-in-depth bound for each independent chain read at the irreversible publication boundary. */
export const FIRST_PUBLICATION_READ_TIMEOUT_MS = 15_000
/** Reserve enough Base blocks for the final bounded BSV read after the Base-height observation. */
export const FIRST_PUBLICATION_BASE_HEIGHT_MARGIN_BLOCKS = Math.ceil(
  FIRST_PUBLICATION_READ_TIMEOUT_MS / 1_000 / BASE_BLOCK_SECS_FLOOR,
)
/** Fixed wall-clock backstop for every wait before the secret/claim write-ahead. */
export const PRE_REVEAL_WAIT_BACKSTOP_MS = 4 * 60 * 60_000

export type FirstPublicationGuardResult =
  | { ok: true }
  | { ok: false; terminal: boolean; reason: string }

export interface FirstPublicationGuardDeps {
  findLockTxByScript?: (
    lockingScriptHex: string,
    expectedSatoshis: number,
    signal?: AbortSignal,
    opts?: { forceHistory?: boolean },
  ) => Promise<Transaction | null>
  isSwapLocked?: (params: Erc20SwapParams, signal?: AbortSignal) => Promise<boolean>
  currentBaseHeight?: (signal?: AbortSignal) => Promise<bigint>
  currentBsvHeight?: (signal?: AbortSignal) => Promise<number>
  nowMs?: () => number
  signal?: AbortSignal
  readTimeoutMs?: number
  log?: (chain: 'bsv' | 'evm', message: string) => void
  /** Preserve the executor's message-vs-chain conflict latch around every ordered read. */
  assertNoConflict?: () => void
  /** Preserve the executor's cross-cycle qualifying-tx ambiguity latch. */
  observeQualifiedLockTxid?: (txid: string) => void
}

/** The responder must still own its negotiated Base claim budget after this initiator reveals. */
export function baseSafeRevealCutoff(baseTimelockBlock: number, claimBudgetBaseBlocks: number): number {
  return baseTimelockBlock - claimBudgetBaseBlocks
}

/** Compute once when the Base lock lands; the smaller Base-derived/fixed deadline wins and is then persisted. */
export function computePreRevealWaitDeadlineMs(opts: {
  landedAtMs: number
  baseHeightAtLanding: number
  baseTimelockBlock: number
  claimBudgetBaseBlocks: number
  fixedBackstopMs?: number
}): number {
  const values = [opts.landedAtMs, opts.baseHeightAtLanding, opts.baseTimelockBlock, opts.claimBudgetBaseBlocks]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('pre-reveal deadline inputs must be non-negative safe integers')
  const cutoff = baseSafeRevealCutoff(opts.baseTimelockBlock, opts.claimBudgetBaseBlocks)
  const remainingBlocks = Math.max(0, cutoff - opts.baseHeightAtLanding)
  const baseDeadlineMs = opts.landedAtMs + Math.floor(remainingBlocks * BASE_BLOCK_SECS_FLOOR * 1_000)
  const backstop = opts.fixedBackstopMs ?? PRE_REVEAL_WAIT_BACKSTOP_MS
  if (!Number.isSafeInteger(backstop) || backstop < 1) throw new Error('pre-reveal fixed backstop must be a positive safe integer')
  return Math.min(baseDeadlineMs, opts.landedAtMs + backstop)
}

export function assertPreRevealWaitCeiling(deadlineMs: number | undefined, nowMs: () => number = Date.now): void {
  if (deadlineMs === undefined) throw new Error('pre-reveal wait ceiling is unavailable after the Base lock')
  if (nowMs() >= deadlineMs) {
    throw new Error(`pre-reveal wait ceiling ${deadlineMs} reached; ending before reveal with the Base refund record intact`)
  }
}

function baseTuple(rec: SettlementRecord): Erc20SwapParams {
  return {
    preimageHash: `0x${rec.hashHex}` as `0x${string}`,
    amount: BigInt(rec.amountUsdc),
    tokenAddress: rec.usdcTokenAddress as `0x${string}`,
    claimAddress: rec.baseClaimAddress as `0x${string}`,
    refundAddress: rec.baseRefundAddress as `0x${string}`,
    timelock: BigInt(rec.baseTimelockBlock),
  }
}

/** Preserve the executor's early source-independent Base gate; the complete five-step guard still runs last. */
export async function guardObservedLockBaseSafety(
  rec: SettlementRecord,
  deps: Pick<FirstPublicationGuardDeps, 'isSwapLocked' | 'currentBaseHeight' | 'nowMs' | 'signal' | 'readTimeoutMs' | 'log' | 'assertNoConflict'>,
  label: string,
): Promise<FirstPublicationGuardResult> {
  const nowMs = deps.nowMs ?? Date.now
  const timeoutCap = deps.readTimeoutMs ?? FIRST_PUBLICATION_READ_TIMEOUT_MS
  const timeoutMs = (): number => Math.max(1, Math.min(timeoutCap,
    rec.preRevealWaitDeadlineMs === undefined ? timeoutCap : rec.preRevealWaitDeadlineMs - nowMs()))
  const retry = (reason: string): FirstPublicationGuardResult => ({ ok: false, terminal: false, reason })
  const terminal = (reason: string): FirstPublicationGuardResult => ({ ok: false, terminal: true, reason })
  const conflict = (): FirstPublicationGuardResult | undefined => {
    try { deps.assertNoConflict?.(); return undefined }
    catch (error) { return terminal(error instanceof Error ? error.message : String(error)) }
  }
  const read = async <T>(
    missing: string,
    failed: (error: unknown) => string,
    call?: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ value: T } | { result: FirstPublicationGuardResult }> => {
    const before = conflict()
    if (before) return { result: before }
    if (!call) return { result: retry(missing) }
    try {
      const value = await withRequestTimeout(timeoutMs(), deps.signal, call)
      const after = conflict()
      return after ? { result: after } : { value }
    } catch (error) {
      const reason = failed(error)
      deps.log?.('evm', reason)
      return { result: retry(reason) }
    }
  }
  const locked = await read(`${label}: isSwapLocked(exact tuple) rail is missing`,
    (error) => `${label}: isSwapLocked(exact tuple) read failed; this attempt will not reveal and will retry next cycle: ${error instanceof Error ? error.message : String(error)}`,
    deps.isSwapLocked && ((signal) => deps.isSwapLocked!(baseTuple(rec), signal)))
  if ('result' in locked) return locked.result
  if (!locked.value) return terminal(`${label}: exact Base swap tuple is no longer locked (finalized claim/refund or competing resolution); refusing to reveal`)
  const height = await read(`${label}: Base height rail is missing`,
    (error) => `${label}: Base height read failed; this attempt will not reveal and will retry next cycle: ${error instanceof Error ? error.message : String(error)}`,
    deps.currentBaseHeight)
  if ('result' in height) return height.result
  const numeric = Number(height.value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) return retry(`${label}: Base height read returned invalid ${String(height.value)}; this attempt will not reveal and will retry next cycle`)
  const cutoff = baseSafeRevealCutoff(rec.baseTimelockBlock, rec.claimBudgetBaseBlocks)
  return numeric >= cutoff
    ? terminal(`${label}: live Base height ${numeric} reached the safe reveal cutoff ${cutoff} = timelock ${rec.baseTimelockBlock} − responder claim budget ${rec.claimBudgetBaseBlocks}; refusing to reveal`)
    : { ok: true }
}

/**
 * Prove every first-publication invariant in its canonical order. A read failure is retryable doubt; a positive
 * contradiction is terminal. The final operation is the synchronous persisted-deadline comparison, so a caller can
 * put the write-ahead and broadcast directly after an `ok` result without another await.
 */
export async function guardFirstClaimPublication(
  rec: SettlementRecord,
  deps: FirstPublicationGuardDeps,
  label = 'final pre-reveal Base guard',
): Promise<FirstPublicationGuardResult> {
  const nowMs = deps.nowMs ?? Date.now
  const log = deps.log ?? (() => {})
  const timeoutCap = deps.readTimeoutMs ?? FIRST_PUBLICATION_READ_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutCap) || timeoutCap < 1) throw new Error('first-publication read timeout must be a positive safe integer')
  const timeoutMs = (): number => Math.max(1, Math.min(
    timeoutCap,
    rec.preRevealWaitDeadlineMs === undefined ? timeoutCap : rec.preRevealWaitDeadlineMs - nowMs(),
  ))
  const terminal = (reason: string): FirstPublicationGuardResult => ({ ok: false, terminal: true, reason })
  const retry = (reason: string): FirstPublicationGuardResult => ({ ok: false, terminal: false, reason })
  const conflict = (): FirstPublicationGuardResult | undefined => {
    try { deps.assertNoConflict?.(); return undefined }
    catch (error) { return terminal(error instanceof Error ? error.message : String(error)) }
  }
  const read = async <T>(
    chain: 'bsv' | 'evm',
    missing: string,
    failed: (error: unknown) => string,
    call: ((signal: AbortSignal) => Promise<T>) | undefined,
  ): Promise<{ value: T } | { result: FirstPublicationGuardResult }> => {
    const before = conflict()
    if (before) return { result: before }
    if (!call) {
      const reason = `${missing} — first publication refused fail-closed; this attempt will retry`
      log(chain, reason)
      return { result: retry(reason) }
    }
    try {
      const value = await withRequestTimeout(timeoutMs(), deps.signal, call)
      const after = conflict()
      return after ? { result: after } : { value }
    } catch (error) {
      if (error instanceof AmbiguousBsvLockError) return { result: terminal(error.message) }
      const reason = failed(error)
      log(chain, reason)
      return { result: retry(reason) }
    }
  }

  // A recovery which starts at/past its persisted ceiling is terminal before any bounded network read. Keep the
  // identical post-read comparison at step 5: a run which starts in time can still cross the ceiling while reading.
  if (rec.preRevealWaitDeadlineMs !== undefined && nowMs() >= rec.preRevealWaitDeadlineMs) {
    return terminal(`pre-reveal wait ceiling ${rec.preRevealWaitDeadlineMs} reached; ending before reveal with the Base refund record intact`)
  }

  const outpoint = /^([0-9a-f]{64})_(\d+)$/i.exec(rec.bsvLockOutpoint ?? '')
  if (!outpoint) return terminal('persisted BSV lock outpoint is malformed — refusing first publication')
  const acceptedLockTxid = outpoint[1].toLowerCase()
  let lockingScriptHex: string
  try { lockingScriptHex = SettlementSession.fromRecord(rec).bsvHtlcScriptHex() }
  catch (error) { return terminal(`record-derived BSV lock script is invalid — refusing first publication: ${error instanceof Error ? error.message : String(error)}`) }

  // 1. Forced all-history uniqueness, bound to the persisted lock txid.
  const unique = await read(
    'bsv',
    'fresh pre-reveal exact-script finder rail is missing',
    (error) => `fresh pre-reveal exact-script read failed; this attempt will not reveal and will retry next cycle: ${error instanceof Error ? error.message : String(error)}`,
    deps.findLockTxByScript && ((signal) => deps.findLockTxByScript!(lockingScriptHex, rec.amountBsvSats, signal, { forceHistory: true })),
  )
  if ('result' in unique) return unique.result
  if (!unique.value) {
    const reason = 'fresh pre-reveal exact-script read did not yet report the accepted lock; this attempt will not reveal and will retry next cycle'
    log('bsv', reason)
    return retry(reason)
  }
  const foundTxid = unique.value.id('hex').toLowerCase()
  try { deps.observeQualifiedLockTxid?.(foundTxid) }
  catch (error) { return terminal(error instanceof Error ? error.message : String(error)) }
  if (foundTxid !== acceptedLockTxid) return terminal(`fresh pre-reveal exact-script read found lock ${foundTxid}, not persisted lock ${acceptedLockTxid}; refusing to reveal`)

  // 2. The exact Base tuple remains locked.
  const locked = await read(
    'evm',
    `${label}: isSwapLocked(exact tuple) rail is missing`,
    (error) => `${label}: isSwapLocked(exact tuple) read failed; this attempt will not reveal and will retry next cycle: ${error instanceof Error ? error.message : String(error)}`,
    deps.isSwapLocked && ((signal) => deps.isSwapLocked!(baseTuple(rec), signal)),
  )
  if ('result' in locked) return locked.result
  if (!locked.value) return terminal(`${label}: exact Base swap tuple is no longer locked (finalized claim/refund or competing resolution); refusing to reveal`)

  // 3. Height is read only after the exact tuple read, closing the stale-order race.
  const baseHeight = await read(
    'evm',
    `${label}: Base height rail is missing`,
    (error) => `${label}: Base height read failed; this attempt will not reveal and will retry next cycle: ${error instanceof Error ? error.message : String(error)}`,
    deps.currentBaseHeight,
  )
  if ('result' in baseHeight) return baseHeight.result
  const numericBaseHeight = Number(baseHeight.value)
  if (!Number.isSafeInteger(numericBaseHeight) || numericBaseHeight < 0) {
    const reason = `${label}: Base height read returned invalid ${String(baseHeight.value)}; this attempt will not reveal and will retry next cycle`
    log('evm', reason)
    return retry(reason)
  }
  const cutoff = baseSafeRevealCutoff(rec.baseTimelockBlock, rec.claimBudgetBaseBlocks)
  const guardedCutoff = cutoff - FIRST_PUBLICATION_BASE_HEIGHT_MARGIN_BLOCKS
  if (numericBaseHeight >= guardedCutoff) {
    return terminal(`${label}: live Base height ${numericBaseHeight} reached guarded cutoff ${guardedCutoff} = safe reveal cutoff ${cutoff} − ${FIRST_PUBLICATION_BASE_HEIGHT_MARGIN_BLOCKS}-block bounded-read margin; responder keeps its full ${rec.claimBudgetBaseBlocks}-block claim budget; refusing to reveal`)
  }

  // 4. The BSV runway is the final chain read.
  const bsvHeight = await read(
    'bsv',
    'first-publication live BSV height rail is missing',
    (error) => `first-publication live BSV height read failed; this attempt will not reveal and will retry next cycle: ${error instanceof Error ? error.message : String(error)}`,
    deps.currentBsvHeight,
  )
  if ('result' in bsvHeight) return bsvHeight.result
  if (!Number.isSafeInteger(bsvHeight.value) || bsvHeight.value < 0) {
    const reason = `first-publication live BSV height read returned invalid ${String(bsvHeight.value)}; this attempt will not reveal and will retry next cycle`
    log('bsv', reason)
    return retry(reason)
  }
  const runway = guardInitiatorRevealRunway(rec.bsvRefundLocktime, bsvHeight.value)
  if (!runway.ok) return terminal(`reveal-safety margin expired before first publication: ${runway.reason}`)

  // 5. Persisted wall-clock ceiling, when present. No await follows this read inside the guard.
  if (rec.preRevealWaitDeadlineMs !== undefined && nowMs() >= rec.preRevealWaitDeadlineMs) {
    return terminal(`pre-reveal wait ceiling ${rec.preRevealWaitDeadlineMs} reached; ending before reveal with the Base refund record intact`)
  }
  return { ok: true }
}
