import { baseRefundParamsFromRecord } from '../../bridge/watchtower-adapters'
import type { Erc20SwapParams } from '../../bridge/evm/erc20swap'
import type { SettlementRecord } from '../../bridge/settlement-session'

export const UNLANDED_LOCK_ABORT_REASON = 'nothing is locked: the USDC lock did not land or was already refunded, and it can no longer land'
const ZERO_LOCK_HASH = `0x${'0'.repeat(64)}`
const OLD_RECORD_GRACE_SECONDS = 600
/** A record without the attempt marker rests its nonce bound on the local clock, so it waits longer. */
const LEGACY_RECORD_GRACE_SECONDS = 3_600
/** A record names one lock attempt in practice; a wider span means a damaged record, which is never burned through. */
const MAX_BURN_SPAN = 8
type LockAttempt = NonNullable<SettlementRecord['baseLockAttempts']>[number]

/** Buyer-only read/send surface. Tuple and nonce reads are pinned to one finalized block. */
export interface BuyerUnlandedLockRails {
  finalizedBlockNumber(): Promise<bigint>
  isSwapLocked(params: Erc20SwapParams, opts: { blockNumber: bigint }): Promise<boolean>
  nonceAtBlock(blockNumber: bigint): Promise<number>
  pendingNonce(): Promise<number>
  blockTimestamp?(blockNumber: bigint): Promise<number>
  consumeNonce?(
    nonce: number,
    priorTxid?: `0x${string}`,
    onRecorded?: (signed: { hash: `0x${string}`; signedTx: `0x${string}`; nonce: number }) => void | Promise<void>,
  ): Promise<`0x${string}`>
}

export function isUnlandedLockCandidate(record: SettlementRecord): boolean {
  return record.role === 'initiator' && record.state === 'base-locked' &&
    record.baseLockTxHash?.toLowerCase() === ZERO_LOCK_HASH &&
    !record.bsvClaimTxid && !record.bsvClaimTxHex && !record.bsvClaimBeefHex && !record.refundTxid
}

function sameRecord(a: SettlementRecord, b: SettlementRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function nonceBound(attempts: LockAttempt[]): number {
  return Math.max(...attempts.map((attempt) => attempt.nonce))
}

function latestAtNonce(attempts: LockAttempt[], nonce: number): LockAttempt | undefined {
  return [...attempts].reverse().find((attempt) => attempt.nonce === nonce)
}

function recentlyBurned(attempts: LockAttempt[], nowSeconds: number): boolean {
  return attempts.some((attempt) => attempt.kind === 'burn' && attempt.at !== undefined && attempt.at >= nowSeconds - OLD_RECORD_GRACE_SECONDS)
}

/**
 * Classify only when a finalized nonce proof says every possible lock nonce is already consumed. Otherwise, after
 * the grace period, replace each possible lock transaction with a zero-value self-transfer and let a later finalized
 * pass prove that replacement mined. Read failures and every send error deliberately mean "try again later".
 */
export async function resolveUnlandedLock(record: SettlementRecord, deps: {
  evm: BuyerUnlandedLockRails
  now: () => number
  reread: (hashHex: string) => SettlementRecord | undefined
  persist: (record: SettlementRecord) => void
  isExecuting?: (hashHex: string) => boolean
  /** Throws while the Base pool is split or unverified: such a pool can serve a fork, so its reads prove nothing. */
  assertPoolSafe: () => void
  /** Operator statement that one kit process used this home while records without the attempt marker were written. */
  resolveUnmarkedRecords?: boolean
}): Promise<SettlementRecord | undefined> {
  if (!isUnlandedLockCandidate(record) || deps.isExecuting?.(record.hashHex)) return undefined
  try {
    const finalized = await deps.evm.finalizedBlockNumber()
    if (typeof finalized !== 'bigint' || finalized <= 0n) return undefined
    const params = baseRefundParamsFromRecord(record)
    const locked = await deps.evm.isSwapLocked(params, { blockNumber: finalized })
    if (locked !== false) return undefined
    const tombstone = (): SettlementRecord | undefined => {
      // Re-read immediately before the terminal write: a landing/reveal/refund updater wins over this diagnosis.
      const current = deps.reread(record.hashHex)
      if (!current || !sameRecord(current, record) || deps.isExecuting?.(record.hashHex)) return undefined
      // After the reads and immediately before the terminal write; a throw means "try later", like a read error.
      deps.assertPoolSafe()
      const next: SettlementRecord = {
        ...current, state: 'aborted', abortReason: UNLANDED_LOCK_ABORT_REASON,
        history: [...current.history, { state: 'aborted', at: Math.floor(deps.now() / 1000) }],
      }
      deps.persist(next)
      return next
    }
    // An explicitly empty marker proves this kit never signed a lock. No nonce (and therefore no burn) is needed.
    if (record.baseLockAttempts !== undefined && record.baseLockAttempts.length === 0) return tombstone()

    const nonceAtFinalized = await deps.evm.nonceAtBlock(finalized)
    if (!Number.isSafeInteger(nonceAtFinalized) || nonceAtFinalized < 0) return undefined
    const attempts = record.baseLockAttempts
    if (attempts && nonceAtFinalized > nonceBound(attempts)) return tombstone()
    // Kit 0.2.0 did not keep a second process off its home, so an unmarked record has no provable bound unless the
    // operator states that only one kit process used this home. Without that statement, leave the record as it is.
    if (!attempts && deps.resolveUnmarkedRecords !== true) return undefined

    // An old kit has no capability marker. Its first burn becomes the durable bound; until then equality at F is not
    // proof that a signed lock cannot still land. An old kit entered 'base-locked' only after its approve receipt and
    // then signed one lock at the pending nonce with nothing else in flight, so for any F mined after that entry the
    // lock's nonce is at most nonce@F. The anchor is that entry, not record creation (the approve can take minutes).
    if (!deps.evm.blockTimestamp) return undefined
    const lockedAt = record.history.find((entry) => entry.state === 'base-locked')?.at
    if (lockedAt === undefined) return undefined
    const grace = attempts ? OLD_RECORD_GRACE_SECONDS : LEGACY_RECORD_GRACE_SECONDS
    const timestamp = await deps.evm.blockTimestamp(finalized)
    if (!Number.isSafeInteger(timestamp) || timestamp < lockedAt + grace) return undefined
    if (!deps.evm.consumeNonce || deps.isExecuting?.(record.hashHex)) return undefined
    const pendingNonce = await deps.evm.pendingNonce()
    if (!Number.isSafeInteger(pendingNonce) || pendingNonce < 0 || pendingNonce !== nonceAtFinalized) return undefined
    const nowSeconds = Math.floor(deps.now() / 1000)
    if (recentlyBurned(attempts ?? [], nowSeconds)) return undefined
    const bound = attempts ? nonceBound(attempts) : nonceAtFinalized
    if (nonceAtFinalized > bound || bound - nonceAtFinalized >= MAX_BURN_SPAN) return undefined

    // Do not overwrite an updater that won between the finalized reads and the first irreversible write-ahead burn.
    let work = deps.reread(record.hashHex)
    if (!work || !sameRecord(work, record) || deps.isExecuting?.(record.hashHex)) return undefined
    for (let nonce = nonceAtFinalized; nonce <= bound; nonce++) {
      const priorTxid = latestAtNonce(work.baseLockAttempts ?? [], nonce)?.txHash
      try {
        await deps.evm.consumeNonce(nonce, priorTxid, async (signed) => {
          if (signed.nonce !== nonce) throw new Error('buyer nonce burn recorder received a different nonce')
          // A refund or landing update written while this burn was being priced wins: refuse, so nothing is sent.
          const current = deps.reread(record.hashHex)
          if (!current || !sameRecord(current, work!)) throw new Error('buyer nonce burn refused: the settlement record changed')
          const burn: LockAttempt = { txHash: signed.hash, nonce, kind: 'burn', at: nowSeconds }
          work = { ...work!, baseLockAttempts: [...(work!.baseLockAttempts ?? []), burn] }
          // The client does not submit until this completes. A persistence failure therefore never burns a nonce.
          deps.persist(work)
        })
      } catch {
        return undefined
      }
    }
    return undefined
  } catch {
    return undefined
  }
}
