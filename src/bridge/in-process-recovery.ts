import { Transaction, type ChainTracker } from '@bsv/sdk'
import { hasPersistedBsvClaimArtifact, runWatchtower, type WatchtowerDeps } from './watchtower'
import { makeBsvWatchtowerDeps, makeBaseWatchtowerDeps } from './watchtower-adapters'
import { broadcastHtlcSpendAsBeef } from '../settlement/htlc/beef-spend-broadcast'
import { SettlementSession, type SettlementRecord, type SettlementState } from './settlement-session'
import type { RecoveryClaimEvm } from './watchtower-adapters'
import type { Erc20SwapEvmClient } from './evm/client'
import { watchtowerRecordKey } from './watchtower-record-identity'
import { assertInitiatorRefundSafeOnBsv } from './initiator-refund-safety'
import type { BsvHeightPurpose } from '../wallet/bsv-height'
export { assertInitiatorRefundSafeOnBsv } from './initiator-refund-safety'
export interface RecoveryBsvRails {
  chainHeight: () => Promise<number>
  /** Purpose-aware two-source tip reader. Required by live mainnet rails; optional for legacy/test adapters. */
  readBsvHeight?: (purpose: BsvHeightPurpose) => Promise<number>
  broadcast: (rawTx: string, atomicBeefHex?: string) => Promise<string>
  fetchBeef?: (txid: string) => Promise<Transaction | null>
  txConfirmations: (txid: string) => Promise<number>
  resolveSpender: (txid: string, vout: number) => Promise<string | null>
  fetchTx: (txid: string) => Promise<Transaction | null>
  /** Confirmed + mempool history for a record-derived exact locking script. Required only for pre-marker records
   * whose BSV lock outpoint was never persisted. */
  readScriptHistory?: (lockingScriptHex: string) => Promise<string[]>
  /** Corroborated, reorg-aware header root of trust used before any BSV terminal state. */
  chainTracker?: ChainTracker
}
function recoveryHeight(rails: RecoveryBsvRails): Promise<number> {
  return rails.readBsvHeight ? rails.readBsvHeight('recovery') : rails.chainHeight()
}

/** A missing finality quorum is deliberately indistinguishable from zero depth:
 * recovery keeps the record and retries; it never terminalises on one source. */
async function finalityHeight(rails: RecoveryBsvRails): Promise<number> {
  try {
    if (rails.readBsvHeight) return await rails.readBsvHeight('finality')
    return await rails.chainTracker!.currentHeight()
  } catch {
    return 0
  }
}

export function makeValidatedBsvFinality(rails: RecoveryBsvRails): ((txid: string, minimumConfirmations: number) => Promise<boolean>) | undefined {
  if (!rails.chainTracker || !rails.fetchBeef) return undefined
  return async (txid: string, minimumConfirmations: number): Promise<boolean> => {
    const proved = await rails.fetchBeef!(txid)
    if (!proved || proved.id('hex').toLowerCase() !== txid.toLowerCase() || !proved.merklePath) return false
    try {
      if (!await proved.merklePath.verify(txid, rails.chainTracker!)) return false
    } catch (e) {
      // A discovery source can deliver a proof before the independent tracker has that block's header. Keep the
      // recovery armed in that case; a caught-up tracker that throws remains fail-closed as before.
      let trackerTip: number
      try { trackerTip = await rails.chainTracker!.currentHeight() }
      catch { return false }
      if (trackerTip < proved.merklePath.blockHeight) return false
      throw e
    }
    const tip = await finalityHeight(rails)
    const confirmations = tip - proved.merklePath.blockHeight + 1
    return Number.isSafeInteger(confirmations) && confirmations >= minimumConfirmations
  }
}

/** BR-H3: compose the BSV-only recovery used after an initiator has revealed `s`. The persisted claim is kept alive
 * until a header-validated burial; this route deliberately has no EVM/refund capability. */
export function makeInitiatorClaimRecoveryDeps(session: SettlementSession, opts: {
  persistPath: string
  dry: boolean
  pollMs?: number
  maxPolls?: number
  refundConfs?: number
  bsvRails: RecoveryBsvRails
  beforeSend?: () => void | Promise<void>
  strictPersistedRecordTrust?: boolean
}): WatchtowerDeps {
  const { bsvRails } = opts
  return makeBsvWatchtowerDeps(session, {
    persistPath: opts.persistPath,
    dry: opts.dry,
    pollMs: opts.pollMs,
    maxPolls: opts.maxPolls,
    refundConfs: opts.refundConfs,
    bsvHeight: () => recoveryHeight(bsvRails),
    broadcastBsv: (rawHex, beefHex) => bsvRails.broadcast(rawHex, beefHex),
    bsvConfirmations: (txid) => bsvRails.txConfirmations(txid),
    bsvFinality: makeValidatedBsvFinality(bsvRails),
    resolveSpender: (txid, vout) => bsvRails.resolveSpender(txid, vout),
    fetchTx: (txid) => bsvRails.fetchTx(txid),
    beforeSend: opts.beforeSend,
    strictPersistedRecordTrust: opts.strictPersistedRecordTrust,
  })
}

export interface SuperviseRecoveryOpts {
  session: SettlementSession
  /** The record's persistence file (the swapStore path) — the watchtower writes the refund txid + terminal here. */
  recordPath: string
  /** Optional exact mode for recovery's atomic record replacements. */
  persistMode?: number
  bsvRails: RecoveryBsvRails
  /** The RESPONDER's Base CLAIM surface (its address MUST equal the record's baseClaimAddress). Omit / mismatch ⇒
   *  BSV-refund-only recovery (no USDC claim-backstop). The keyed client OR the keyless brain adapter (claim → signer,
   *  doc 25 E4) both satisfy {@link RecoveryClaimEvm} — so the in-process recovery runs KEY-FREE in the signer path. */
  evm?: RecoveryClaimEvm
  pollMs?: number
  /** A large default (run until terminal); the lock's nLockTime can be hours out. */
  maxPolls?: number
  refundConfs?: number
  /** Optional last-moment ownership fence. The failover daemon uses this to re-check the main heartbeat before send. */
  beforeSend?: () => void | Promise<void>
  /** Enable full validation/consistency checks on every persisted-record reload (failover daemon trust boundary). */
  strictPersistedRecordTrust?: boolean
  /** Optional cancellation fence for a supervisor run superseded by a fresher on-disk state. */
  shouldContinue?: () => boolean
  log: (msg: string) => void
  /** Called with the final record when the watchtower reaches a terminal state — the caller clears its store. */
  onTerminal: (final: SettlementRecord) => void
  /** Called when the watchtower returns NON-terminal (maxPolls exhausted) or THROWS. The record is KEPT; the
   *  supervisor drops it from its armed set so a later `ensure()` can RE-arm it (review 2026-08-31: a kept-but-armed
   *  record would otherwise never be retried within the same process). */
  onNonTerminal?: (final: SettlementRecord) => void
  /** Observe only writes this run durably completed, so its supervisor state follows its own progress. */
  onPersist?: (record: SettlementRecord) => void
  /** Injectable for tests; defaults to the real runWatchtower. */
  _run?: (session: SettlementSession, deps: ReturnType<typeof makeBsvWatchtowerDeps>) => Promise<SettlementRecord>
}

const isTerminal = (s: SettlementState): boolean => s === 'refunded' || s === 'settled' || s === 'aborted'
const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Arm an in-process RESPONDER recovery for one live-lock record, in the BACKGROUND. Returns immediately; the recovery
 * runs to a terminal state (or a bounded surface) and then calls `onTerminal`. Only for `role: 'responder'` records
 * (the caller filters); a non-responder record is skipped with a log.
 */
export function superviseBsvResponderRecovery(opts: SuperviseRecoveryOpts): void {
  const { session, recordPath, bsvRails, log, onTerminal } = opts
  const rec = session.toRecord()
  const id = rec.hashHex.slice(0, 12)

  if (rec.role !== 'responder') {
    log(`in-process recovery SKIPPED for ${id}… — role '${rec.role}' (initiator recovery is the standalone/attended path)`)
    return
  }

  // Fail-safe: the claim-backstop needs a key whose address IS the record's claimAddress. A mismatch (or no key) →
  // recover BSV-refund-only rather than arming a claim that would always revert; the record is still refund-safe.
  let evm = opts.evm
  if (evm && !eqAddr(evm.address(), rec.baseClaimAddress)) {
    log(`⚠️ in-process recovery for ${id}…: claim key ${evm.address()} ≠ record claimAddress ${rec.baseClaimAddress} — running BSV-refund-only (no USDC claim-backstop)`)
    evm = undefined
  }

  const deps = makeBsvWatchtowerDeps(session, {
    persistPath: recordPath,
    persistMode: opts.persistMode,
    dry: false,
    pollMs: opts.pollMs,
    maxPolls: opts.maxPolls ?? 100_000, // run until terminal (nLockTime can be hours out); the process supervisor bounds wall-clock
    refundConfs: opts.refundConfs,
    bsvHeight: () => recoveryHeight(bsvRails),
    // SPV: broadcast the pre-signed refund as a self-contained BEEF (attach the lock's proof) — the same contract as
    // the standalone watchtower + the executor refund; a raw-only rail keeps bare hex.
    broadcastBsv: (refundHex: string) => broadcastHtlcSpendAsBeef(Transaction.fromHex(refundHex), { fetchBeef: bsvRails.fetchBeef, broadcast: (raw, beef) => bsvRails.broadcast(raw, beef) }),
    bsvConfirmations: (txid: string) => bsvRails.txConfirmations(txid),
    bsvFinality: makeValidatedBsvFinality(bsvRails),
    resolveSpender: (txid: string, vout: number) => bsvRails.resolveSpender(txid, vout),
    fetchTx: (txid: string) => bsvRails.fetchTx(txid),
    evm,
    beforeSend: opts.beforeSend,
    strictPersistedRecordTrust: opts.strictPersistedRecordTrust,
  })
  const persist = deps.persist
  deps.persist = async (record): Promise<void> => {
    await persist(record)
    opts.onPersist?.(record)
  }
  deps.shouldContinue = opts.shouldContinue

  log(`in-process recovery ARMED for ${id}… (${evm ? 'BSV refund + USDC claim-backstop' : 'BSV-refund-only'})`)
  const run = opts._run ?? runWatchtower
  void run(session, deps)
    .then((final) => {
      if (isTerminal(final.state)) {
        log(`in-process recovery TERMINAL for ${id}… → ${final.state} (clearing the record)`)
        onTerminal(final)
      } else {
        log(`⚠️ in-process recovery for ${id}… ended NON-terminal (state ${final.state}) — record KEPT; re-armable on the next ensure()`)
        opts.onNonTerminal?.(final)
      }
    })
    .catch((e) => {
      log(`⚠️ in-process recovery for ${id}… errored — record KEPT; re-armable on the next ensure(): ${e instanceof Error ? e.message : String(e)}`)
      opts.onNonTerminal?.(session.toRecord())
    })
}

/**
 * A small idempotent supervisor: track which swapIds are already being recovered so a record is never double-armed
 * (call `ensure` on startup and after every swap result). Returns the arm/forget hooks.
 */
export interface RecoverySupervisor {
  ensure: (records: SettlementRecord[]) => void
  cancel: (swapId: string, reason?: string) => void
  /** Exact-tuple cancellation used by the failover census when one hashlock identifies multiple live records. */
  cancelRecord?: (record: SettlementRecord, reason?: string) => void
  cancelAll: (reason?: string) => void
  /** Current fail-closed recovery proof failure, if one needs operator attention. */
  healthError?: () => string | undefined
}

interface ArmedRecovery {
  hashHex: string
  state: SettlementState
  recordToken: string
  active: boolean
  terminalClearAttempted?: boolean
}

/** A supersede-aware fence must check ownership on BOTH sides of an awaited heartbeat/network fence. */
export async function runSupersedeSafeSendFence(isActive: () => boolean, beforeSend?: () => void | Promise<void>): Promise<void> {
  if (!isActive()) throw new Error('recovery send aborted: session was superseded by a fresher record')
  await beforeSend?.()
  if (!isActive()) throw new Error('recovery send aborted: session was superseded while awaiting the pre-send fence')
}

export function makeRecoverySupervisor(base: Omit<SuperviseRecoveryOpts, 'session' | 'recordPath' | 'onTerminal' | 'onNonTerminal' | 'shouldContinue'> & {
  clearRecord: (swapId: string, expected?: SettlementRecord) => void
  recordPathFor: (swapId: string, record?: SettlementRecord) => string
  /** Resolve an optional late-installed capability only when a fresh run is armed. */
  evmProvider?: () => RecoveryClaimEvm | undefined
}): RecoverySupervisor {
  const armed = new Map<string, ArmedRecovery>()
  const cancelTarget = (swap: string | SettlementRecord, reason = 'cancelled'): void => {
    const keys = typeof swap === 'string'
      ? [...armed].filter(([key, run]) => key === swap || run.hashHex.toLowerCase() === swap.toLowerCase()).map(([key]) => key)
      : [watchtowerRecordKey(swap)]
    for (const key of keys) {
      const current = armed.get(key)
      if (!current) continue
      current.active = false
      armed.delete(key)
      base.log(`in-process recovery STANDING DOWN for ${current.hashHex.slice(0, 12)}… (${reason})`)
    }
  }
  const cancel = (swapId: string, reason?: string): void => cancelTarget(swapId, reason)
  const cancelRecord = (record: SettlementRecord, reason?: string): void => cancelTarget(record, reason)
  const cancelAll = (reason = 'cancelled'): void => {
    for (const swapId of [...armed.keys()]) cancel(swapId, reason)
  }
  const ensure = (records: SettlementRecord[]): void => {
    for (const rec of records) {
      if (rec.competingResolution) {
        cancelRecord(rec, `competing Base ${rec.competingResolution.outcome} resolution needs operator attention`)
        base.log(`⚠️ in-process recovery NEEDS ATTENTION for ${rec.hashHex.slice(0, 12)}…: competing Base ${rec.competingResolution.outcome} ${rec.competingResolution.eventTxid}; record KEPT, NOT re-armed`)
        continue
      }
      if (isTerminal(rec.state)) {
        const key = watchtowerRecordKey(rec)
        const current = armed.get(key)
        cancelRecord(rec, `fresh record is terminal (${rec.state})`)
        if (!current?.terminalClearAttempted) {
          if (current) current.terminalClearAttempted = true
          base.clearRecord(rec.hashHex, rec)
        }
        continue
      }
      const key = watchtowerRecordKey(rec)
      const prior = armed.get(key)
      const recordToken = JSON.stringify(rec)
      if (prior?.state === rec.state && prior.recordToken === recordToken) continue
      if (prior) {
        prior.active = false
        base.log(`in-process recovery SUPERSEDED for ${rec.hashHex.slice(0, 12)}… (${prior.state} → ${rec.state}); re-arming from fresh state`)
      }
      const run: ArmedRecovery = { hashHex: rec.hashHex, state: rec.state, recordToken, active: true }
      armed.set(key, run)
      superviseBsvResponderRecovery({
        ...base,
        // A daemon may acquire its optional EVM capability after this supervisor was constructed. Resolve it only
        // for a NEW arm: an already-running key-free BSV watch remains untouched, while a later/superseding state
        // receives the atomically installed capability.
        evm: base.evmProvider?.() ?? base.evm,
        session: SettlementSession.fromRecord(rec),
        recordPath: base.recordPathFor(rec.hashHex, rec),
        shouldContinue: () => run.active,
        beforeSend: () => runSupersedeSafeSendFence(() => run.active, base.beforeSend),
        onPersist: (persisted) => {
          if (armed.get(key) === run) { run.state = persisted.state; run.recordToken = JSON.stringify(persisted) }
        },
        onTerminal: (final) => {
          if (run.terminalClearAttempted) return
          run.terminalClearAttempted = true
          base.clearRecord(final.hashHex, final)
          if (armed.get(key) === run) armed.delete(key)
        },
        // Non-terminal / errored: KEEP the record (don't clear) but drop it from `armed` so the next ensure()
        // RE-arms a fresh recovery — a stranded record must never be left kept-but-idle (review 2026-08-31).
        onNonTerminal: () => { if (armed.get(key) === run) armed.delete(key) },
      })
    }
  }
  return { ensure, cancel, cancelRecord, cancelAll }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// INITIATOR recovery (doc 25 initiator-recovery, review bf542a12 CRITICAL) — the mirror of everything above for the

// the swap stalls. Structurally identical to the responder supervisor (bounded run to terminal via runWatchtower +
// makeBaseWatchtowerDeps, onTerminal clears the record, onNonTerminal re-arms) — only the chain leg + role differ.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SuperviseInitiatorRecoveryOpts {
  session: SettlementSession
  /** The record's persistence file (the restock-store path) — the watchtower writes the refund txid + terminal state here. */
  recordPath: string
  /** Keyless-safe EVM reads (current block / tx confirmations / canonical isSwapLocked state) driving the height-gated
   *  watch. The SAME `Erc20SwapEvmClient` instance works whether it holds a key (in-process) or not (doc 25 E4 signer
   *  path, keyless-constructed) — every read method works identically either way; only a SEND needs a key, and the
   *  refund send is supplied separately via `evmRefund` below (never via this client in the signer path). Required —
   *  without reads the watch can't even gate the timelock. */
  evm?: Erc20SwapEvmClient
  /** The refund SIGNING surface — the value-moving mirror of the responder's `evm` claim-backstop. Only the `refund`
   *  slice of {@link RecoveryClaimEvm} is needed (never `claim` — the initiator never claims its own lock), so this
   *  is typed as that narrower view: the keyed client OR the keyless brain adapter (`makeBrainInitiatorEvmRails`,
   *  which RE-REGISTERS the EVM binding before routing to the signer's `evmRefund` — durable across a signer
   *  restart) both satisfy it. Absent, or no `refund` provided ⇒ nothing safe to refund with — SKIPPED (logged), not
   *  a silent no-op-forever arm (mirrors the responder's fail-safe key-mismatch downgrade, but here there is no
   *  degraded fallback mode: refunding IS the recovery).
   */
  evmRefund?: Pick<RecoveryClaimEvm, 'address' | 'swapAddress' | 'chainId' | 'refund'>
  /** BR-H3: the same BSV rails used by the initiator executor. Required only for a persisted `revealed` record, whose
   *  safe recovery is re-broadcasting/confirming its BSV claim (never attempting the Base refund). */
  bsvRails?: RecoveryBsvRails
  pollMs?: number
  /** A large default (run until terminal); the Base timelock can be many hours out. */
  maxPolls?: number
  refundConfs?: number
  /** Optional last-moment ownership fence. The failover daemon uses this to re-check the main heartbeat before send. */
  beforeSend?: () => void | Promise<void>
  /** Enable full validation/consistency checks on every persisted-record reload (failover daemon trust boundary). */
  strictPersistedRecordTrust?: boolean
  /** Optional cancellation fence for a supervisor run superseded by a fresher on-disk state. */
  shouldContinue?: () => boolean
  log: (msg: string) => void
  /** Called with the final record when the watchtower reaches a terminal state — the caller clears its store. */
  onTerminal: (final: SettlementRecord) => void
  /** Called when the watchtower returns NON-terminal (maxPolls exhausted) or THROWS. The record is KEPT; the
   *  supervisor drops it from its armed set so a later `ensure()` can RE-arm it. */
  onNonTerminal?: (final: SettlementRecord) => void
  /** Observe only writes this run durably completed, so its supervisor state follows its own progress. */
  onPersist?: (record: SettlementRecord) => void
  /** Observe the latest BSV proof guarding an initiator Base refund. */
  onRefundSafetyResult?: (error?: string) => void
  /** Injectable for tests; defaults to the real runWatchtower. */
  _run?: (session: SettlementSession, deps: WatchtowerDeps) => Promise<SettlementRecord>
}

/**
 * Arm an in-process INITIATOR recovery for one live-lock record, in the BACKGROUND. Returns immediately; the
 * recovery runs to a terminal state (or a bounded surface) and then calls `onTerminal`. Only for `role: 'initiator'`
 * records (the caller filters); a non-initiator record is skipped with a log — the exact mirror of
 * {@link superviseBsvResponderRecovery}'s own role guard, inverted.
 */
export function superviseBaseInitiatorRecovery(opts: SuperviseInitiatorRecoveryOpts): void {
  const { session, recordPath, evm: evmReads, evmRefund, log, onTerminal } = opts
  const rec = session.toRecord()
  const id = rec.hashHex.slice(0, 12)

  if (rec.role !== 'initiator') {
    log(`in-process initiator recovery SKIPPED for ${id}… — role '${rec.role}' (this supervisor only drives the initiator/Base-USDC refund; see superviseBsvResponderRecovery for the responder leg)`)
    return
  }

  const launch = (deps: WatchtowerDeps, description: string): void => {
    log(`in-process initiator recovery ARMED for ${id}… (${description})`)
    const run = opts._run ?? runWatchtower
    void run(session, deps)
      .then((final) => {
        if (isTerminal(final.state)) {
          log(`in-process initiator recovery TERMINAL for ${id}… → ${final.state} (clearing the record)`)
          onTerminal(final)
        } else {
          log(`⚠️ in-process initiator recovery for ${id}… ended NON-terminal (state ${final.state}) — record KEPT; re-armable on the next ensure()`)
          opts.onNonTerminal?.(final)
        }
      })
      .catch((e) => {
        log(`⚠️ in-process initiator recovery for ${id}… errored — record KEPT; re-armable on the next ensure(): ${e instanceof Error ? e.message : String(e)}`)
        opts.onNonTerminal?.(session.toRecord())
      })
  }

  // BR-H3: after reveal, Base refund is categorically unsafe. Route the persisted claim to the BSV watcher using the
  // exact raw/BEEF artifact and wait for burial. This also closes the flagged in-process BR-H3b follow-on cleanly.
  if (rec.state === 'revealed') {
    if (!hasPersistedBsvClaimArtifact(rec)) {
      log(`⚠️ in-process initiator recovery for ${id}…: revealed record has no valid persisted BSV claim artifact — SKIPPING fail-closed (manual recovery required)`)
      opts.onNonTerminal?.(rec)
      return
    }
    if (!opts.bsvRails) {
      log(`⚠️ in-process initiator recovery for ${id}…: no BSV rails wired for the persisted revealed claim — SKIPPING fail-closed`)
      opts.onNonTerminal?.(rec)
      return
    }
    const deps = makeInitiatorClaimRecoveryDeps(session, {
      persistPath: recordPath,
      dry: false,
      pollMs: opts.pollMs,
      maxPolls: opts.maxPolls ?? 100_000,
      refundConfs: opts.refundConfs,
      bsvRails: opts.bsvRails,
      beforeSend: opts.beforeSend,
      strictPersistedRecordTrust: opts.strictPersistedRecordTrust,
    })
    const persist = deps.persist
    deps.persist = async (record): Promise<void> => {
      await persist(record)
      opts.onPersist?.(record)
    }
    deps.shouldContinue = opts.shouldContinue
    launch(deps, `BSV claim re-broadcast + burial target ${rec.claimConfirmationTarget}`)
    return
  }

  // The revealed/BSV-claim route above is deliberately EVM-independent. Every remaining initiator route needs
  // canonical Base reads even before it could sign a refund, so an EVM boot outage must gate it without preventing
  // the key-free BSV supervisor from running.
  if (!evmReads) {
    log(`⚠️ in-process initiator recovery for ${id}…: EVM read/refund capability UNAVAILABLE — SKIPPING this EVM-dependent recovery; record KEPT`)
    opts.onNonTerminal?.(rec)
    return
  }

  // Refunding IS the recovery here (unlike the responder's OPTIONAL claim-backstop on top of a mandatory pre-signed
  // BSV refund) — without a refund-capable surface there is nothing safe to arm. Log + skip rather than run a watch
  // that can only ever throw on every matured poll.
  const refund = evmRefund?.refund
  if (!evmRefund || !refund) {
    log(`⚠️ in-process initiator recovery for ${id}…: no refund capability wired — SKIPPING (recover via the standalone watchtower: WATCH_RECORD=${recordPath} WATCH_DRY=0 node --import tsx scripts/run-watchtower.ts)`)
    return
  }
  // Fail-safe (mirrors the responder's claim-key check): the refund surface's identity MUST be the record's OWN
  
  // mismatch means the wrong signer/key is wired — refuse rather than arm a refund that would only ever be refused.
  if (!eqAddr(evmRefund.address(), rec.baseRefundAddress)) {
    log(`⚠️ in-process initiator recovery for ${id}…: refund key ${evmRefund.address()} ≠ record baseRefundAddress ${rec.baseRefundAddress} — cannot safely refund; SKIPPING`)
    return
  }

  const deps = makeBaseWatchtowerDeps(session, {
    persistPath: recordPath,
    dry: false,
    evm: evmReads, // reads: baseHeight / baseConfirmations / isSwapLocked — keyless-safe (works whether evmReads holds a key or not)
    // Signing: the keyed client OR the keyless brain adapter. Preserve outcome-unknown as an explicit pending
    // broadcast so the watchtower durably records its hash; reject every unknown status instead of collapsing it to
    // a terminal revert.
    baseRefund: async (params, priorBroadcastTxid) => {
      const sent = await refund.call(evmRefund, params, priorBroadcastTxid)
      if (sent.status !== 'success' && sent.status !== 'reverted' && sent.status !== 'pending') {
        throw new Error(`initiator recovery refund returned unknown status '${sent.status}' (fail-closed)`)
      }
      return { hash: sent.hash, status: sent.status, ...(sent.nonce !== undefined ? { nonce: sent.nonce } : {}) }
    },
    pollMs: opts.pollMs,
    maxPolls: opts.maxPolls ?? 100_000, // run until terminal (the Base timelock can be many hours out); the process supervisor bounds wall-clock
    refundConfs: opts.refundConfs,
    beforeSend: opts.beforeSend,
    strictPersistedRecordTrust: opts.strictPersistedRecordTrust,
    assertInitiatorRefundSafe: (record) => assertInitiatorRefundSafeOnBsv(record, opts.bsvRails),
    onInitiatorRefundSafetyResult: opts.onRefundSafetyResult,
  })
  const persist = deps.persist
  deps.persist = async (record): Promise<void> => {
    await persist(record)
    opts.onPersist?.(record)
  }
  deps.shouldContinue = opts.shouldContinue

  launch(deps, `USDC refund at/after Base timelock ${rec.baseTimelockBlock}`)
}

/**
 * A small idempotent supervisor for INITIATOR records — the exact structural mirror of {@link makeRecoverySupervisor},
 * driving {@link superviseBaseInitiatorRecovery} instead of the responder's. A separate factory (rather than a mode
 * flag on the existing one) so the responder wiring stays byte-for-byte unchanged.
 */
export function makeInitiatorRecoverySupervisor(base: Omit<SuperviseInitiatorRecoveryOpts, 'session' | 'recordPath' | 'onTerminal' | 'onNonTerminal' | 'shouldContinue'> & {
  clearRecord: (swapId: string, expected?: SettlementRecord) => void
  recordPathFor: (swapId: string, record?: SettlementRecord) => string
  /** Resolve late-installed read/signing capabilities only when a fresh run is armed. */
  evmProvider?: () => Erc20SwapEvmClient | undefined
  evmRefundProvider?: () => Pick<RecoveryClaimEvm, 'address' | 'swapAddress' | 'chainId' | 'refund'> | undefined
}): RecoverySupervisor {
  const armed = new Map<string, ArmedRecovery>()
  const refundSafetyErrors = new Map<string, string>()
  const cancelTarget = (swap: string | SettlementRecord, reason = 'cancelled'): void => {
    const keys = typeof swap === 'string'
      ? [...armed].filter(([key, run]) => key === swap || run.hashHex.toLowerCase() === swap.toLowerCase()).map(([key]) => key)
      : [watchtowerRecordKey(swap)]
    for (const key of keys) {
      const current = armed.get(key)
      refundSafetyErrors.delete(key)
      if (!current) continue
      current.active = false
      armed.delete(key)
      base.log(`in-process initiator recovery STANDING DOWN for ${current.hashHex.slice(0, 12)}… (${reason})`)
    }
  }
  const cancel = (swapId: string, reason?: string): void => cancelTarget(swapId, reason)
  const cancelRecord = (record: SettlementRecord, reason?: string): void => cancelTarget(record, reason)
  const cancelAll = (reason = 'cancelled'): void => {
    for (const swapId of [...armed.keys()]) cancel(swapId, reason)
    refundSafetyErrors.clear()
  }
  const ensure = (records: SettlementRecord[]): void => {
    for (const rec of records) {
      if (rec.competingResolution) {
        cancelRecord(rec, `competing Base ${rec.competingResolution.outcome} resolution needs operator attention`)
        base.log(`⚠️ in-process initiator recovery NEEDS ATTENTION for ${rec.hashHex.slice(0, 12)}…: competing Base ${rec.competingResolution.outcome} ${rec.competingResolution.eventTxid}; record KEPT, NOT re-armed`)
        continue
      }
      if (isTerminal(rec.state)) {
        const key = watchtowerRecordKey(rec)
        const current = armed.get(key)
        cancelRecord(rec, `fresh record is terminal (${rec.state})`)
        if (!current?.terminalClearAttempted) {
          if (current) current.terminalClearAttempted = true
          base.clearRecord(rec.hashHex, rec)
        }
        continue
      }
      const key = watchtowerRecordKey(rec)
      const prior = armed.get(key)
      const recordToken = JSON.stringify(rec)
      if (prior?.state === rec.state && prior.recordToken === recordToken) continue
      if (prior) {
        prior.active = false
        base.log(`in-process initiator recovery SUPERSEDED for ${rec.hashHex.slice(0, 12)}… (${prior.state} → ${rec.state}); re-arming from fresh state`)
      }
      const run: ArmedRecovery = { hashHex: rec.hashHex, state: rec.state, recordToken, active: true }
      armed.set(key, run)
      superviseBaseInitiatorRecovery({
        ...base,
        evm: base.evmProvider?.() ?? base.evm,
        evmRefund: base.evmRefundProvider?.() ?? base.evmRefund,
        session: SettlementSession.fromRecord(rec),
        recordPath: base.recordPathFor(rec.hashHex, rec),
        shouldContinue: () => run.active,
        beforeSend: () => runSupersedeSafeSendFence(() => run.active, base.beforeSend),
        onRefundSafetyResult: (error) => {
          if (error) refundSafetyErrors.set(key, error)
          else refundSafetyErrors.delete(key)
        },
        onPersist: (persisted) => {
          if (armed.get(key) === run) { run.state = persisted.state; run.recordToken = JSON.stringify(persisted) }
        },
        onTerminal: (final) => {
          if (run.terminalClearAttempted) return
          run.terminalClearAttempted = true
          base.clearRecord(final.hashHex, final)
          if (armed.get(key) === run) armed.delete(key)
        },
        // Non-terminal / errored: KEEP the record (don't clear) but drop it from `armed` so the next ensure()
        // RE-arms a fresh recovery — a stranded record must never be left kept-but-idle.
        onNonTerminal: () => { if (armed.get(key) === run) armed.delete(key) },
      })
    }
  }
  const healthError = (): string | undefined => {
    if (refundSafetyErrors.size === 0) return undefined
    return [...refundSafetyErrors.values()].join('; ')
  }
  return { ensure, cancel, cancelRecord, cancelAll, healthError }
}

/**
 * Drive a recovery supervisor to COMPLETION for a ONE-SHOT (non-daemon) caller — review b3d74696 HIGH #1. A foreground
 * `restock-buy` that locks USDC and then fails post-lock must NOT exit and strand it: under the isolated signer the
 * printed raw-key watchtower CANNOT sign the refund, so the only safe recovery is the signer-routed supervisor — which
 * only makes progress while a process is ALIVE to re-`ensure()` it. This keeps the caller alive, re-arming on every
 * poll until the durable at-risk record(s) drain (refunded at/after the Base timelock — which can be HOURS), the same
 * re-armable loop the serve daemon runs each tick, tightened for a foreground command.
 *
 * `ensure` is fire-and-forget (it arms async recovery and clears a record on a terminal refund), so we poll
 * `listRecords()` after each ensure+sleep and finish when it drains. If nothing is at-risk at entry it returns at once
 * (a clean settle strands nothing). Unbounded by default — we NEVER abandon locked money; the durable record is the
 * backstop if the operator kills the hold (a later serve/restock start re-arms it). `shouldContinue`/`maxCycles` are
 * injected only for tests and a deliberate operator-abort. Returns whether the records cleared and how many cycles ran.
 */
export async function driveRecoveryUntilClear(opts: {
  ensure: (records: SettlementRecord[]) => void
  listRecords: () => RecoveryRecordCensus
  sleep: (ms: number) => Promise<void>
  pollMs: number
  log: (m: string) => void
  shouldContinue?: () => boolean
  maxCycles?: number
}): Promise<{ cleared: boolean; cycles: number }> {
  const shouldContinue = opts.shouldContinue ?? (() => true)
  let cycles = 0
  let pending = opts.listRecords()
  while (pending.records.length + pending.errors.length > 0) {
    if (!shouldContinue()) {
      opts.log(`recovery hold aborted with ${pending.records.length} readable at-risk record(s) and ${pending.errors.length} unreadable record(s) still pending — the durable record persists; a later serve/restock start will re-arm recovery`)
      return { cleared: false, cycles }
    }
    if (opts.maxCycles !== undefined && cycles >= opts.maxCycles) {
      opts.log(`recovery hold hit maxCycles=${opts.maxCycles} with ${pending.records.length} readable at-risk record(s) and ${pending.errors.length} unreadable record(s) still pending — the durable record persists`)
      return { cleared: false, cycles }
    }
    cycles += 1
    opts.log(`recovery cycle ${cycles}: ${pending.records.length} readable at-risk record(s), ${pending.errors.length} unreadable record(s) — re-arming signer-routed refund (holds until the Base timelock elapses)…`)
    opts.ensure(pending.records)
    await opts.sleep(opts.pollMs)
    pending = opts.listRecords()
  }
  opts.log(`recovery complete — no at-risk records remain (${cycles} cycle(s))`)
  return { cleared: true, cycles }
}

/** Local structural view of a recovery-store census; the bridge does not import market-maker storage types. */
interface RecoveryRecordCensus {
  records: SettlementRecord[]
  errors: ReadonlyArray<{ path: string; error: Error }>
}
