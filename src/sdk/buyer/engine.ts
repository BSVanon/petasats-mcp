import { Transaction, type ChainTracker, type CommsLayer, type PublicKey } from '@bsv/sdk'
import { makeBridgeInitiatorExecutor, type BridgeInitiatorBsvRails, type BridgeInitiatorEvmRails } from '../../bridge/initiator-executor'
import { defaultInitiatorTimelocks } from '../../bridge/initiator-timelocks'
import { makeInitiatorRecoverySupervisor, makeValidatedBsvFinality, type RecoveryBsvRails } from '../../bridge/in-process-recovery'
import type { RecoveryClaimEvm } from '../../bridge/watchtower-adapters'
import { DEFAULT_BSV_FINALITY_CONFIRMATIONS } from '../../bridge/watchtower'
import type { Erc20SwapEvmClient } from '../../bridge/evm/client'
import type { SettlementRecord, SettlementState } from '../../bridge/settlement-session'
import { makeFileSwapRecordStore } from '../../market-maker/swap-record-store'
import { DEFAULT_BSV_FEE_RATE_SAT_PER_KB } from '../../settlement/htlc/bridge-covenant'
import { sizeCovenantFeeBudgetSats } from '../../settlement/htlc/bridge-covenant'
import { makeMessageBoxInitiatorCoordinator } from '../../transport/messagebox-coordinator'
import type { BuyerExecutor, BuyerQuote, BuyerRecoveryOutcome, BuyerSwapRecord, BuyerSwapStage } from './types'
import { resolveUnlandedLock, UNLANDED_LOCK_ABORT_REASON, type BuyerUnlandedLockRails } from './unlanded-lock'

const knownBuyerStage = (stage: string): stage is BuyerSwapStage => new Set<BuyerSwapStage>([
  'quoted', 'admitted', 'usdc_locked', 'waiting_bsv_lock', 'bsv_lock_confirming', 'claiming', 'claimed',
  'settled', 'sweeping', 'delivered', 'refund_waiting', 'refunded', 'failed', 'needs_attention',
]).has(stage as BuyerSwapStage)

/** Quote rendering uses the very fee sizing used by the initiator executor. */
export function buyerClaimFeeBudgetSats(): number {
  return sizeCovenantFeeBudgetSats(DEFAULT_BSV_FEE_RATE_SAT_PER_KB)
}

/**
 * The buyer-facing rendering of the settlement state machine.  In particular, `revealed` is never refundable:
 * it remains `claiming` until the persisted BSV claim is buried.  `aborted` is only produced before a lock and is
 * presented as failed; the kit itself only writes that terminal stage when it has never seen a settlement record.
 */
export function buyerStageForSettlement(state: SettlementState): BuyerSwapStage {
  switch (state) {
    case 'created': return 'admitted'
    case 'base-locked': return 'waiting_bsv_lock'
    case 'bsv-locked': return 'bsv_lock_confirming'
    case 'revealed': return 'claiming'
    case 'settled': return 'settled'
    case 'refunding': return 'refund_waiting'
    case 'refunded': return 'refunded'
    case 'aborted': return 'failed'
  }
}

const terminalSettlement = (state: SettlementState): boolean => state === 'settled' || state === 'refunded' || state === 'aborted'

/** The covenant claim pays the buyer from output 0.  Prefer the persisted bytes over a derived estimate. */
function claimPayoutSats(record: SettlementRecord): number | undefined {
  if (record.bsvClaimTxHex) {
    try {
      const sats = Transaction.fromHex(record.bsvClaimTxHex).outputs[0]?.satoshis
      if (typeof sats === 'number' && Number.isSafeInteger(sats) && sats >= 0) return sats
    } catch { /* retain the safe committed-value fallback below */ }
  }
  const budget = record.bsvClaimFeeBudgetSats
  if (Number.isSafeInteger(record.amountBsvSats) && typeof budget === 'number' && Number.isSafeInteger(budget)) {
    const payout = record.amountBsvSats - budget
    if (payout >= 0) return payout
  }
  return undefined
}

/** A persisted reveal is irreversible: stale/contradictory later labels must never put its USDC on a refund UI path. */
function stageForRecord(record: BuyerSwapRecord, state: SettlementState): BuyerSwapStage {
  return record.settlementState === 'revealed' && state !== 'settled' ? 'claiming' : buyerStageForSettlement(state)
}

export interface BuyerEngineDeps {
  comms: CommsLayer
  doorIdentity: string
  evm: BridgeInitiatorEvmRails & Pick<RecoveryClaimEvm, 'refund'> & Partial<BuyerUnlandedLockRails>
  bsv: BridgeInitiatorBsvRails & RecoveryBsvRails
  chainTracker: ChainTracker
  bsvReservePub: PublicKey
  settlementDir: string
  usdcTokenAddress: `0x${string}`
  capUsdPerSwap: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
  /** Throws while the Base pool is split or unverified; an unlanded-lock tombstone is never written past it. */
  assertEvmPoolSafe: () => void | Promise<void>
  /** Operator opt-in: resolve stuck records written before the attempt marker (one kit process used this home). */
  resolveUnmarkedStuckLocks?: boolean
}

/**
 * Compose the proven initiator and its recovery supervisor for the SDK.  All chain and transport surfaces are
 * injected; this factory deliberately has no live-runtime assembly.
 */
export function makeBuyerEngine(deps: BuyerEngineDeps): BuyerExecutor & { recoverAll(records: BuyerSwapRecord[]): Promise<Map<string, BuyerRecoveryOutcome>> } {
  const records = makeFileSwapRecordStore(deps.settlementDir, { censusGroupRead: false, recordMode: 0o600 })
  const claimIsBuried = makeValidatedBsvFinality({ ...deps.bsv, chainTracker: deps.chainTracker } as RecoveryBsvRails)
  const known = new Map<string, { hashHex: string; state: SettlementState }>()
  const executorClears = new Map<string, { state: SettlementState; reason?: string }>()
  const lastUnlandedLockCheck = new Map<string, number>()
  const executingHashes = new Set<string>()
  const mark = (hashHex: string, state: SettlementState): void => {
    for (const [swapId, current] of known) if (current.hashHex === hashHex) known.set(swapId, { hashHex, state })
  }
  const recovery = makeInitiatorRecoverySupervisor({
    evm: deps.evm as unknown as Erc20SwapEvmClient,
    evmRefund: deps.evm,
    bsvRails: deps.bsv,
    log: deps.log,
    clearRecord: (hashHex, expected) => {
      if (expected) mark(hashHex, expected.state)
      // Buyer terminal records are acknowledgement tombstones.  Do not discard the only durable result before the
      // buyer row has recorded the same terminal state and txids.
      const state = expected?.state ?? [...known.values()].find((entry) => entry.hashHex === hashHex)?.state
      if (!state || !terminalSettlement(state)) records.clear(hashHex, expected)
    },
    recordPathFor: (hashHex) => records.pathFor(hashHex),
    pollMs: 1_000,
    refundConfs: 1,
    onPersist: (record) => mark(record.hashHex, record.state),
  })
  const remember = (swapId: string, record: SettlementRecord, notify?: (r: { hashHex: string; state: SettlementState }) => void): void => {
    const seen = { hashHex: record.hashHex, state: record.state }
    known.set(swapId, seen)
    // This runs in the executor's synchronous write-ahead callback, after the settlement record is durable and before
    // `evm.lock`.  The kit callback starts its own durable update without allowing a UI-write problem to strand value.
    notify?.(seen)
  }
  /** The initiator's two direct clear sites are terminal hand-offs, not deletion. */
  const writeExecutorTombstone = (hashHex: string, abortReason = 'the USDC lock reverted; nothing was locked'): SettlementState | undefined => {
    const current = records.list().records.find((entry) => entry.hashHex === hashHex)
    if (!current) return undefined
    const at = Math.floor(deps.now() / 1000)
    if (current.state === 'revealed') {
      const tombstone: SettlementRecord = { ...current, state: 'settled', history: [...current.history, { state: 'settled', at }] }
      records.write(tombstone)
      mark(hashHex, 'settled')
      return 'settled'
    }
    if (current.state === 'created' || current.state === 'base-locked') {
      const tombstone: SettlementRecord = {
        ...current, state: 'aborted', abortReason,
        history: [...current.history, { state: 'aborted', at }],
      }
      records.write(tombstone)
      mark(hashHex, 'aborted')
      return 'aborted'
    }
    return current.state
  }
  const clearExecutorRecord = (hashHex: string, nothingLockedReason?: string): void => {
    // The initiator also clears a pre-lock record after a receipt-level revert plus an exact-tuple absence proof, and
    // (with a reason) after a lock call that failed before any attempt was recorded, so was never sent.  Record what
    // was actually last persisted; only the eventual execute result tells us whether this clear means clean
    // settlement or "nothing locked".
    for (const [swapId, current] of known) if (current.hashHex === hashHex) executorClears.set(swapId, { state: current.state, reason: nothingLockedReason })
    writeExecutorTombstone(hashHex, nothingLockedReason)
  }
  const absentOutcome = async (record: BuyerSwapRecord): Promise<BuyerRecoveryOutcome> => {
    // A missing settlement record is only terminal when the kit's own DURABLE observation proves which terminal
    // resolution occurred.  In particular, never turn a missing BSV-side/recovery record into a guessed settlement.
    // A refund the supervisor finished in this process is known exactly (its clear carries the terminal state).
    const observed = record.settlementState === 'revealed' ? 'revealed' : known.get(record.swapId)?.state ?? record.settlementState
    switch (observed) {
      case 'revealed': {
        if (record.bsvClaimTxid && claimIsBuried) {
          try {
            // The same burial depth recovery requires before it stops watching a claim.
            if (await claimIsBuried(record.bsvClaimTxid, DEFAULT_BSV_FINALITY_CONFIRMATIONS)) return { stage: 'settled', settlementState: 'settled', reason: record.reason }
          } catch { /* missing recovery evidence remains an attention state */ }
        }
        return { stage: 'needs_attention', settlementState: 'revealed', reason: 'the settlement record is missing after the BSV claim revealed the secret; check that the BSV claim confirmed' }
      }
      case 'settled': return { stage: 'settled', settlementState: 'settled', reason: record.reason }
      case 'refunded': return { stage: 'refunded', settlementState: 'refunded', reason: record.reason }
      case 'aborted': return { stage: 'failed', settlementState: 'aborted', reason: record.reason }
      case 'created':
      // Missing evidence is not a terminal outcome.  In particular a prior base-locked checkpoint may have been
      // unreadable or lost after value moved; only a terminal tombstone or a direct chain proof may say otherwise.
      case 'base-locked': return { stage: 'needs_attention', reason: 'settlement record is absent; recovery needs a direct chain check' }
      default: return { stage: knownBuyerStage(record.stage) ? record.stage : 'needs_attention', reason: 'outcome needs a chain check' }
    }
  }
  const resolveUnlandedLockIfDue = async (record: SettlementRecord): Promise<SettlementRecord> => {
    if (!deps.evm.finalizedBlockNumber || !deps.evm.nonceAtBlock || !deps.evm.pendingNonce || typeof deps.assertEvmPoolSafe !== 'function') return record
    const checkedAt = lastUnlandedLockCheck.get(record.hashHex) ?? -Infinity
    if (deps.now() - checkedAt < 30_000) return record
    lastUnlandedLockCheck.set(record.hashHex, deps.now())
    const resolved = await resolveUnlandedLock(record, {
      evm: deps.evm as BuyerUnlandedLockRails,
      now: deps.now,
      reread: (hashHex) => records.list().records.find((entry) => entry.hashHex === hashHex),
      persist: (tombstone) => records.write(tombstone),
      isExecuting: (hashHex) => executingHashes.has(hashHex),
      assertPoolSafe: () => deps.assertEvmPoolSafe(),
      resolveUnmarkedRecords: deps.resolveUnmarkedStuckLocks === true,
    })
    if (!resolved) return record
    recovery.cancel(record.hashHex, UNLANDED_LOCK_ABORT_REASON)
    mark(resolved.hashHex, resolved.state)
    return resolved
  }

  return {
    async execute(input) {
      let executingHash: string | undefined
      // The admission deadline gates only the intent (below). Later BSV-lock replies keep the channel's
      // default wait: capping them at the short admission window would strand a locked USDC leg until the timelock.
      const messageBox = makeMessageBoxInitiatorCoordinator({
        comms: deps.comms, namespace: input.swapNamespace, peerIdentityPubKeyHex: deps.doorIdentity,
      })
      // Admission is a short-lived reservation at the public door. Refuse before emitting the first settlement message
      // when it has expired, rather than allowing an old admission to create a fresh on-chain lock.
      const coordinator = {
        ...messageBox,
        sendIntent: async (...args: Parameters<typeof messageBox.sendIntent>) => {
          if (deps.now() >= input.handshakeDeadlineMs) throw new Error('market maker admission expired before the swap intent was sent')
          return messageBox.sendIntent(...args)
        },
      }
      const times = defaultInitiatorTimelocks()
      const executor = makeBridgeInitiatorExecutor({
        bsvReservePub: deps.bsvReservePub, evm: deps.evm, bsv: deps.bsv, coordinator, chainTracker: deps.chainTracker,
        now: () => Math.floor(deps.now() / 1000), nowMs: deps.now, sleep: deps.sleep,
        persist: (record) => {
          executingHash = record.hashHex
          executingHashes.add(record.hashHex)
          records.write(record)
          remember(input.swapId, record, input.onSettlement)
        },
        onHashlockCreated: async (hashHex) => {
          executingHash = hashHex
          executingHashes.add(hashHex)
          await input.onSettlementLink?.(hashHex)
        },
        clearRecord: (hashHex) => clearExecutorRecord(hashHex),
        clearNeverSentLock: (hashHex, reason) => clearExecutorRecord(hashHex, reason),
        log: (tag, message) => deps.log(`${tag}: ${message}`),
        config: {
          erc20SwapAddress: deps.evm.swapAddress as `0x${string}`, baseChainId: deps.evm.chainId,
          baseTimelockBlocks: times.baseTimelockBlocks, bsvRefundBlocks: times.bsvRefundBlocks,
          claimBudgetBaseBlocks: times.claimBudgetBaseBlocks, bsvFeeRate: DEFAULT_BSV_FEE_RATE_SAT_PER_KB, bsvConfirmations: 1, // both sides size the covenant fee budget identically
          capUsdPerSwap: deps.capUsdPerSwap, zeroConfCapUsd: 0, requireLockMerkleProof: true, htlcKind: 'covenant',
          approveOnlyBelowAllowance: true, recordLockAttempts: true,
        },
      })
      try {
        const result = await executor.execute({ erc20TokenAddress: deps.usdcTokenAddress, deliverAmount: input.quote.usdcBaseUnits, receiveBsvSats: input.quote.bsvSats })
        const seen = known.get(input.swapId)
        const cleared = executorClears.get(input.swapId)
        executorClears.delete(input.swapId)
        if (!result.ok && (cleared?.state === 'created' || cleared?.state === 'base-locked')) {
          return { ok: false, reason: cleared.reason ?? 'the USDC lock reverted; nothing was locked', nothingLocked: true }
        }
        if (result.ok && seen) known.set(input.swapId, { hashHex: seen.hashHex, state: 'settled' })
        const settlement = seen ? records.list().records.find((entry) => entry.hashHex === seen.hashHex) : undefined
        return { ...result, bsvClaimPayoutSats: settlement ? claimPayoutSats(settlement) : undefined, revealed: seen?.state === 'revealed' || !!result.bsvClaimTxid }
      } catch (error) {
        const cleared = executorClears.get(input.swapId)
        executorClears.delete(input.swapId)
        if (cleared?.state === 'created' || cleared?.state === 'base-locked') {
          return { ok: false, reason: cleared.reason ?? 'the USDC lock reverted; nothing was locked', nothingLocked: true }
        }
        throw error
      } finally {
        if (executingHash) executingHashes.delete(executingHash)
      }
    },
    async recover(record) {
      const prior = known.get(record.swapId)
      const hashHex = record.settlementHashHex ?? prior?.hashHex
      if (!hashHex) return undefined
      const listed = records.list()
      const directoryError = listed.errors.find((error) => !error.hashHex)
      if (directoryError) {
        const reason = `RECOVERY NEEDS ATTENTION: cannot read settlement record directory ${directoryError.path}: ${directoryError.error.message}`
        deps.log(reason)
        return { stage: 'needs_attention', reason }
      }
      const unreadable = listed.errors.find((error) => error.hashHex?.toLowerCase() === hashHex.toLowerCase())
      if (unreadable) {
        const reason = `RECOVERY NEEDS ATTENTION: cannot read settlement record ${unreadable.path}: ${unreadable.error.message}`
        deps.log(reason)
        return { stage: 'needs_attention', reason }
      }
      const found = listed.records.find((item) => item.hashHex === hashHex)
      const settlement = found ? await resolveUnlandedLockIfDue(found) : undefined
      if (!settlement) {
        if (!record.settlementRecordCreated && record.handshakeDeadlineMs !== undefined && deps.now() >= record.handshakeDeadlineMs) {
          return { stage: 'failed', reason: 'handshake expired before a settlement checkpoint was created; nothing was locked' }
        }
        return await absentOutcome(record)
      }
      known.set(record.swapId, { hashHex, state: settlement.state })
      recovery.ensure([settlement])
      return { stage: stageForRecord(record, settlement.state), baseLockTxid: settlement.baseLockTxHash, baseRefundTxid: settlement.refundTxid, bsvClaimTxid: settlement.bsvClaimTxid, bsvClaimPayoutSats: claimPayoutSats(settlement), bsvLockOutpoint: settlement.bsvLockOutpoint, bsvRefundLocktime: settlement.bsvRefundLocktime, baseTimelockBlock: settlement.baseTimelockBlock, settlementState: settlement.state }
    },
    async recoverAll(buyerRecords) {
      const listed = records.list()
      const resolvedRecords = await Promise.all(listed.records.map((record) => resolveUnlandedLockIfDue(record)))
      recovery.ensure(resolvedRecords)
      const stages = new Map<string, BuyerRecoveryOutcome>()
      for (const buyer of buyerRecords) {
        const hashHex = buyer.settlementHashHex
        if (!hashHex) {
          const deadline = buyer.handshakeDeadlineMs ?? buyer.quote.expiry * 1000
          if ((buyer.stage === 'quoted' || buyer.stage === 'admitted') && deps.now() >= deadline) {
            stages.set(buyer.swapId, { stage: 'failed', reason: 'handshake expired before a settlement checkpoint was created; nothing was locked' })
          }
          continue
        }
        const directoryError = listed.errors.find((error) => !error.hashHex)
        if (directoryError) {
          const reason = `RECOVERY NEEDS ATTENTION: cannot read settlement record directory ${directoryError.path}: ${directoryError.error.message}`
          deps.log(reason)
          stages.set(buyer.swapId, { stage: 'needs_attention', reason })
          continue
        }
        const unreadable = listed.errors.find((error) => error.hashHex?.toLowerCase() === hashHex.toLowerCase())
        if (unreadable) {
          const reason = `RECOVERY NEEDS ATTENTION: cannot read settlement record ${unreadable.path}: ${unreadable.error.message}`
          deps.log(reason)
          stages.set(buyer.swapId, { stage: 'needs_attention', reason })
          continue
        }
        const item = resolvedRecords.find((entry) => entry.hashHex === hashHex)
        // Track live records so the supervisor's terminal clear (refunded/settled) is visible to this swap.
        if (item) known.set(buyer.swapId, { hashHex, state: item.state })
        stages.set(buyer.swapId, item
          ? { stage: stageForRecord(buyer, item.state), settlementState: item.state, baseLockTxid: item.baseLockTxHash, baseRefundTxid: item.refundTxid, bsvClaimTxid: item.bsvClaimTxid, bsvClaimPayoutSats: claimPayoutSats(item), bsvLockOutpoint: item.bsvLockOutpoint, bsvRefundLocktime: item.bsvRefundLocktime, baseTimelockBlock: item.baseTimelockBlock, reason: item.abortReason }
          : !buyer.settlementRecordCreated && buyer.handshakeDeadlineMs !== undefined && deps.now() >= buyer.handshakeDeadlineMs
            ? { stage: 'failed', reason: 'handshake expired before a settlement checkpoint was created; nothing was locked' }
            : await absentOutcome(buyer))
      }
      return stages
    },
    async acknowledgeTerminal(buyer) {
      if (!buyer.settlementHashHex || !buyer.settlementState || !terminalSettlement(buyer.settlementState)) return
      const listed = records.list()
      const settlement = listed.records.find((item) => item.hashHex === buyer.settlementHashHex)
      if (!settlement || settlement.state !== buyer.settlementState) return
      // A never-landed lock's tombstone stays on disk: it keeps the exact tuple, so a lock that still landed after the
      if (settlement.abortReason === UNLANDED_LOCK_ABORT_REASON) return
      // A tombstone is acknowledged only by the exact observable terminal artifacts, never merely by a UI stage.
      if (settlement.baseLockTxHash !== buyer.baseLockTxid || settlement.refundTxid !== buyer.baseRefundTxid || settlement.bsvClaimTxid !== buyer.bsvClaimTxid) return
      records.clear(settlement.hashHex, settlement)
    },
  }
}
