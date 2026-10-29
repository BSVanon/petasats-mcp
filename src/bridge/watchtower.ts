import { SettlementSession, type CompetingResolution, type SettlementRecord, type SettlementState, type SwapRole } from './settlement-session'
export type WatchAction =
  | 'idle' // nothing locked yet
  | 'wait' // locked, refund timelock not yet matured (heartbeat)
  | 'reveal-seen' // `s` revealed — happy path completing (claim, don't refund)
  | 'refund-bsv' // responder: BSV refund timelock matured → broadcast pre-signed 2-of-2
  | 'refund-base' // initiator: Base refund timelock matured → ERC20Swap.refund()
  | 'claim-broadcast' // initiator: persisted BSV claim re-broadcast, AWAITING burial
  | 'refund-broadcast' // refund tx broadcast, AWAITING confirmation (not yet recovered)
  | 'refunded' // refund CONFIRMED — funds recovered (terminal)
  | 'settled' // swap settled (terminal)
  | 'needs-attention' // a finalized competing Base resolution won; durable record retained, never retried/deleted
  | 'aborted' // aborted (terminal)
/** The soonest relevant refund gate, with the ETA a human reads. */
export interface WatchGate {
  name: 'bsv-refund' | 'base-refund'
  chain: 'bsv' | 'base'
  atHeight: number
  currentHeight: number
  blocksRemaining: number
  etaSeconds: number
}

export interface WatchHeights {
  bsvHeight: number
  baseHeight: number
}

/** A write mined as a revert, followed by the canonical exact-tuple read proving the swap is no longer locked.
 * This is only a request to classify the finalized Claim/Refund event outcome; tuple absence alone is never terminal. */
export interface SwapAlreadyResolved {
  kind: 'already-resolved'
  operation: 'claim' | 'refund'
  txid: string
}

/** The already-resolved convergence proof is deliberately three-way. Only FAVORABLE permits the pre-existing
 * terminal transition; COMPETING is retained for operator attention; every absence/error/contradiction is UNRESOLVED
 * and stays on the retry path. */
export type ResolutionFinalityClassification =
  | { kind: 'favorable'; eventTxid?: string }
  | { kind: 'competing'; resolution: CompetingResolution }
  | { kind: 'unresolved'; reason?: string }

const ALREADY_RESOLVED_PREFIX = 'watchtower-already-resolved:'

export function swapAlreadyResolvedResult(operation: SwapAlreadyResolved['operation'], txid: string): string {
  return `${ALREADY_RESOLVED_PREFIX}${operation}:${txid}`
}

export function parseSwapAlreadyResolved(value: string): SwapAlreadyResolved | null {
  if (!value.startsWith(ALREADY_RESOLVED_PREFIX)) return null
  const rest = value.slice(ALREADY_RESOLVED_PREFIX.length)
  const split = rest.indexOf(':')
  if (split < 0) return null
  const operation = rest.slice(0, split)
  if (operation !== 'claim' && operation !== 'refund') return null
  return { kind: 'already-resolved', operation, txid: rest.slice(split + 1) }
}

const ADOPTED_CLAIM_PREFIX = 'watchtower-adopted-claim:'

/** A receive-leg claim that some earlier transaction already made (usually the brain's own, through the signer): the
 * watcher sent nothing and only adopts that txid as the claim of record. Finality still binds it before settlement. */
export function adoptedClaimResult(txid: string): string {
  return `${ADOPTED_CLAIM_PREFIX}${txid}`
}

export function parseAdoptedClaim(value: string): string | null {
  return value.startsWith(ADOPTED_CLAIM_PREFIX) ? value.slice(ADOPTED_CLAIM_PREFIX.length) : null
}

export interface SecsPerBlock {
  bsv: number
  base: number
}
/** BSV ~10 min/block, Base ~2 s/block — for ETA rendering only (gates compare heights, not clocks). */
export const DEFAULT_SECS_PER_BLOCK: SecsPerBlock = { bsv: 600, base: 2 }
/** Six BSV blocks (~1 hour) is the minimum terminal burial used by recovery. A persisted producer target may raise
 * this floor but can never lower it back to the unsafe historical 1-confirmation behavior. */
export const DEFAULT_BSV_FINALITY_CONFIRMATIONS = 6

/** The heartbeat emitted every poll — the "read-through" a downstream human/orchestrator sees. */
export interface WatchtowerStatus {
  state: SettlementState
  role: SwapRole
  action: WatchAction
  bsvHeight: number
  baseHeight: number
  gate?: WatchGate
  /** The broadcast refund txid once we've submitted it (recovery is its CONFIRMATION, not this). */
  refundTxid?: string
  /** Confirmations observed on the broadcast refund tx. */
  confirmations?: number
  note: string
  at: number
}

function mkGate(name: WatchGate['name'], chain: WatchGate['chain'], atHeight: number, currentHeight: number, secsPerBlock: number): WatchGate {
  const blocksRemaining = Math.max(0, atHeight - currentHeight)
  return { name, chain, atHeight, currentHeight, blocksRemaining, etaSeconds: blocksRemaining * secsPerBlock }
}

/** A rail answer establishes public visibility only when it identifies the exact requested transaction. */
function isExactFetchedTx(tx: unknown, txid: string): boolean {
  if (!tx || typeof tx !== 'object' || !('id' in tx) || typeof tx.id !== 'function') return false
  try {
    const fetchedId = tx.id('hex')
    return typeof fetchedId === 'string' && fetchedId.toLowerCase() === txid.toLowerCase()
  } catch { return false }
}

export interface WatchDecision {
  action: WatchAction
  gate?: WatchGate
  note: string
}

/**
 * PURE decision — given the record + live heights, what should the watchtower do this tick? Refund
 * only in locked-but-not-revealed states (`base-locked` | `bsv-locked` | `refunding`); once revealed
 * the swap is completing, and terminal states are no-ops. The relevant leg + gate is chosen by role.
 */
export function evaluateWatch(rec: SettlementRecord, heights: WatchHeights, secs: SecsPerBlock = DEFAULT_SECS_PER_BLOCK): WatchDecision {
  if (rec.competingResolution) {
    return {
      action: 'needs-attention',
      note: `COMPETING Base ${rec.competingResolution.outcome} resolution ${rec.competingResolution.eventTxid} won — record retained; operator attention required`,
    }
  }
  switch (rec.state) {
    case 'settled': return { action: 'settled', note: 'swap settled' }
    case 'refunded': return { action: 'refunded', note: 'funds already recovered' }
    case 'aborted': return { action: 'aborted', note: rec.abortReason ?? 'aborted' }
    case 'revealed': return { action: 'reveal-seen', note: '`s` revealed — happy path completing (claim, not refund)' }
    case 'created': return { action: 'idle', note: 'nothing locked yet' }
    default: break // base-locked | bsv-locked | refunding → refund-eligible
  }

  if (rec.role === 'responder') {
    
    const gate = mkGate('bsv-refund', 'bsv', rec.bsvRefundLocktime, heights.bsvHeight, secs.bsv)
    if (!rec.bsvRefundTxHex || !rec.bsvLockOutpoint) {
      return { action: 'wait', gate, note: 'BSV locked; awaiting the pre-signed refund artifact before it can be armed' }
    }
    if (gate.blocksRemaining <= 0) {
      return { action: 'refund-bsv', gate, note: 'BSV refund timelock matured — broadcast the pre-signed 2-of-2 refund' }
    }
    return { action: 'wait', gate, note: `BSV refund matures in ${gate.blocksRemaining} block(s)` }
  }

  // Initiator (machine) refunds the USDC leg via ERC20Swap.refund() at baseTimelockBlock.
  const gate = mkGate('base-refund', 'base', rec.baseTimelockBlock, heights.baseHeight, secs.base)
  if (gate.blocksRemaining <= 0) {
    return { action: 'refund-base', gate, note: 'Base refund timelock matured — call ERC20Swap.refund()' }
  }
  return { action: 'wait', gate, note: `Base refund matures in ${gate.blocksRemaining} block(s)` }
}

export interface WatchtowerDeps {
  /** Live chain heights (real = testnet/mainnet BSV + EVM client; tests inject a sequence). */
  heights: () => Promise<WatchHeights>
  /** BROADCAST the pre-signed BSV 2-of-2 refund; returns the txid. Broadcast ≠ recovered (§12.14/HIGH). */
  refundBsv: (rec: SettlementRecord) => Promise<string>
  /** BROADCAST ERC20Swap.refund() for the USDC leg; returns the tx hash. Broadcast ≠ recovered. */
  refundBase: (rec: SettlementRecord) => Promise<string>
  /** Confirmations of the broadcast refund tx (0 if unconfirmed/unknown/double-spent). Recovery = CONFIRMATION. */
  refundConfirmations: (rec: SettlementRecord, refundTxid: string) => Promise<number>
  /**
   * Prove the confirmed refund hash belongs to this exact swap: the BSV transaction spends the recorded outpoint, or
   * the Base transaction calls refund(exact tuple) and that tuple is no longer locked. Missing/false/error must never
   * terminalise or clear a recovery record.
   */
  refundBelongsToSwap?: (rec: SettlementRecord, refundTxid: string) => Promise<boolean>
  
  refundFinality?: (rec: SettlementRecord, refundTxid: string, confirmations: number) => Promise<boolean>
  /** The adapter's non-lowerable confirmation floor. BSV uses six; Base also requires OP-stack finality. */
  minimumRefundConfs?: number
  /** Has the counterparty revealed `s` on-chain (a competing claim racing our refund)? Secret hex, else null. */
  checkReveal: (rec: SettlementRecord) => Promise<string | null>
  /**
   * Re-read the authoritative durable record from its persistence file immediately before a first
   * refund broadcast. Optional for callers without a file-backed store. MUST throw on any read or
   * parse failure so the watchtower fails closed for that poll rather than acting on stale memory.
   */
  reloadPersistedRecord?: () => Promise<SettlementRecord>
  /** Initiator/Base-only proof that the BSV lock outpoint has not already published the preimage. Production Base
   * recovery must wire this independently of the EVM exact-tuple escrow read; absence is doubt and suppresses send. */
  assertInitiatorRefundSafe?: (rec: SettlementRecord) => Promise<void>
  /** Reports whether the latest initiator refund-safety proof succeeded. The daemon uses failures as service-critical
   * health; standalone callers may omit it. */
  onInitiatorRefundSafetyResult?: (error?: string) => void
  /**
   * DURABLY persist the record (disk/DB/sidecar). Called IMMEDIATELY after every state-affecting
   * mutation — the broadcast txid, a recorded reveal, the confirmed refund — so a crash right after
   * the external side-effect does NOT lose it. This is the explicit durability contract (review
   * 97e33fa6 HIGH): without it, a crash between broadcast and the caller's post-return write would
   * re-broadcast the refund on restart.
   */
  persist: (rec: SettlementRecord) => Promise<void>
  /** The heartbeat sink (log / status endpoint / push to a human-facing UI). */
  emit: (s: WatchtowerStatus) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
  pollMs: number
  /** Backstop so a test/finite run terminates; a real deployment passes a large value. */
  maxPolls: number
  /** Confirmations before a broadcast refund counts as recovered (default 1). */
  refundConfs?: number
  /** While a broadcast refund is unconfirmed, RE-broadcast it every this-many polls (mempool-eviction recovery;
   *  red-team 2026-08-30). Idempotent (same txid). Default 20. */
  refundRebroadcastEveryPolls?: number
  /** RESPONDER post-refund backstop (red-team 2026-08-31): claim the RECEIVE leg (USDC) using the secret `s` that a
   *  counterparty revealed by winning the BSV claim AFTER our refund broadcast (so our refund never confirms and we
   *  are still owed the receive leg). Returns the claim txid. Optional — wired only for a responder watcher that
   *  holds the receive-leg (EVM) claim key; when present, `checkReveal` must detect the on-chain reveal. */
  claimReceiveLegOnReveal?: (rec: SettlementRecord, secretHex: string, priorBroadcastTxid?: `0x${string}`) => Promise<string>
  /** Bind the persisted Base recovery claim hash to claim(exact tuple, recorded secret), then prove its successful
   * receipt (or the legacy already-resolved exact-tuple result) is below the OP-stack finalized head. */
  receiveClaimFinality?: (rec: SettlementRecord, claimTxid: string, alreadyResolved: boolean) => Promise<ResolutionFinalityClassification>
  /** BR-H3 INITIATOR recovery: re-submit the exact persisted BSV claim artifact. Already-known/mined is success. */
  rebroadcastClaim?: (rec: SettlementRecord) => Promise<string>
  /** BR-H3 recovery proof of which transaction, if any, spent the persisted BSV lock outpoint. Absence is doubt:
   * do not publish a write-ahead-only secret without this read. */
  resolveSpender?: (txid: string, vout: number) => Promise<string | null>
  /** BR-H3 recovery lookup for the persisted claim txid. Only an exact-id transaction proves the claim is already
   * public in the network/mempool; an unwired lookup is deliberately treated as unknown, not as a failure. */
  fetchTx?: (txid: string) => Promise<unknown | null>
  /** BR-H3: confirmations of the persisted initiator BSV claim (0 if unconfirmed/unknown/evicted). */
  claimConfirmations?: (rec: SettlementRecord, claimTxid: string) => Promise<number>
  /** Decode every persisted claim artifact, execute-validate it against this record's covenant/outpoint/secret, and
   * return the artifact-derived txid. Confirmation reads must use only this returned identity. */
  claimArtifactTxid?: (rec: SettlementRecord) => Promise<string>
  /** Reorg-safe BSV Merkle/depth proof for the already-bound claim artifact. */
  claimFinality?: (rec: SettlementRecord, claimTxid: string, confirmations: number) => Promise<boolean>
  /** Non-lowerable BSV claim burial floor (default six). */
  minimumClaimConfs?: number
  /** Three-way finalized event outcome for the narrow mined-revert/already-resolved convergence path. */
  alreadyResolvedFinality?: (rec: SettlementRecord, result: SwapAlreadyResolved) => Promise<ResolutionFinalityClassification>
  /** Optional supervisor cancellation fence. Checked at the start of every poll; a superseded in-memory session
   *  returns without another read, write, or send. Irreversible sends have a second, immediate fence in the adapters. */
  shouldContinue?: () => boolean
  secsPerBlock?: SecsPerBlock
}

function validNonNegInt(x: number): boolean {
  return Number.isInteger(x) && x >= 0
}

/**
 * A refundTxid is REAL only if it is txid-shaped — a 64-hex string (BSV) or 0x+64-hex (EVM). A DRY run's
 * refund dep returns a non-txid sentinel (`dry-*-refund-not-sent`); the core must treat that as "not
 * broadcast" so it (a) never persists the sentinel as a real broadcast and (b) self-heals a record a prior
 * dry run already poisoned — otherwise a later LIVE run awaits confirmation of a fake txid forever and the
 * refund never sends (caught 2026-08-20 recovering mature de-minimis locks).
 */
export function isRealRefundTxid(txid: string | undefined): txid is string {
  return !!txid && /^(0x)?[0-9a-fA-F]{64}$/.test(txid)
}

/** A restart can recover an initiator claim only when both its identity and at least one exact wire artifact survived. */
export function hasPersistedBsvClaimArtifact(rec: SettlementRecord): boolean {
  return isRealRefundTxid(rec.bsvClaimTxid)
    && (!!rec.bsvClaimBeefHex || !!rec.bsvClaimTxHex)
}

/**
 * Run the watchtower over one session until a terminal state, a seen reveal, or maxPolls.
 *
 * Refund lifecycle (review 278fc70 HIGH+MEDIUM) — recovery is CONFIRMATION, not broadcast:
 *   • The session stays in its LOCKED state (`base-locked`/`bsv-locked`) all through refund broadcast
 *     + confirmation-wait, so a late counterparty reveal is ALWAYS recordable (`locked→revealed` is
 *     legal; `refunding→revealed` is not). We only commit `refunding→refunded` once the refund tx
 *     buries (`refundConfirmations ≥ refundConfs`).
 *   • Before broadcasting (and on every retry while the broadcast keeps failing) we `checkReveal`: if
 *     the counterparty has revealed `s`, we DON'T refund into a claim we can't beat — we record the
 *     reveal and stop. Once our refund is successfully broadcast we're in the timeout race, so we
 *     stop aborting on new reveals and simply wait for OUR refund to confirm (it never falsely
 *     reports recovery — if the counterparty's claim wins, our refund just never confirms).
 *
 * DURABLE (review 2b41d5f6 + 97e33fa6 HIGH): the broadcast refund txid + the confirmation target in
 * force are recorded (`recordRefundBroadcast`) AND flushed via the explicit `persist` hook the instant
 * they're known — so a crash right after the broadcast side-effect can't lose them (the caller's
 * post-return write is no longer the only durability point). A restarted watcher resumes
 * confirmation-tracking at the ORIGINAL target, never re-broadcasting; malformed confirmation counts
 * (non-finite/negative/fractional) are treated as read failures so they can't satisfy the threshold.
 * FAIL-SAFE (MEDIUM): a refund broadcast that throws is retried next poll; a poll with a malformed
 * height is skipped; and every read-side dep (heights / checkReveal / refundConfirmations) is wrapped
 * so a transient RPC error emits a wait heartbeat and retries rather than killing the loop — and
 * `checkReveal` fails CLOSED (no broadcast that poll if we can't verify
 * the counterparty hasn't revealed). Returns the final record (the caller persists it).
 */
export async function runWatchtower(session: SettlementSession, deps: WatchtowerDeps): Promise<SettlementRecord> {
  const secs = deps.secsPerBlock ?? DEFAULT_SECS_PER_BLOCK
  const minimumRefundConfs = deps.minimumRefundConfs ?? DEFAULT_BSV_FINALITY_CONFIRMATIONS
  const minimumClaimConfs = deps.minimumClaimConfs ?? DEFAULT_BSV_FINALITY_CONFIRMATIONS
  const requestedRefundConfs = deps.refundConfs ?? minimumRefundConfs
  const refundConfs = Math.max(requestedRefundConfs, minimumRefundConfs)
  const refundRebroadcastEvery = deps.refundRebroadcastEveryPolls ?? 20
  // §12.14 LOW: validate the loop inputs — a silent no-heartbeat loop or a distorted ETA defeats the point.
  if (!Number.isInteger(deps.maxPolls) || deps.maxPolls < 1) throw new Error('runWatchtower: maxPolls must be an integer ≥ 1')
  if (!Number.isFinite(deps.pollMs) || deps.pollMs < 0) throw new Error('runWatchtower: pollMs must be a finite number ≥ 0')
  if (!Number.isInteger(requestedRefundConfs) || requestedRefundConfs < 1) throw new Error('runWatchtower: refundConfs must be an integer ≥ 1')
  if (!Number.isInteger(minimumRefundConfs) || minimumRefundConfs < 1) throw new Error('runWatchtower: minimumRefundConfs must be an integer ≥ 1')
  if (!Number.isInteger(minimumClaimConfs) || minimumClaimConfs < 1) throw new Error('runWatchtower: minimumClaimConfs must be an integer ≥ 1')
  if (!Number.isInteger(refundRebroadcastEvery) || refundRebroadcastEvery < 1) throw new Error('runWatchtower: refundRebroadcastEveryPolls must be an integer ≥ 1')
  if (!Number.isFinite(secs.bsv) || secs.bsv < 0 || !Number.isFinite(secs.base) || secs.base < 0) {
    throw new Error('runWatchtower: secsPerBlock must be finite and ≥ 0')
  }

  const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
  let lastHeights: WatchHeights = { bsvHeight: 0, baseHeight: 0 }
  for (let i = 0; i < deps.maxPolls; i++) {
    if (deps.shouldContinue && !deps.shouldContinue()) return session.toRecord()
    const maybeSleep = async (): Promise<void> => { if (i < deps.maxPolls - 1) await deps.sleep(deps.pollMs) }

    // Read-side deps are wrapped: a transient RPC/indexer error → wait heartbeat + retry, never exit.
    let heights: WatchHeights
    try {
      heights = await deps.heights()
    } catch (e) {
      deps.emit({ state: session.state, role: session.role, action: 'wait', bsvHeight: lastHeights.bsvHeight, baseHeight: lastHeights.baseHeight, refundTxid: session.toRecord().refundTxid, note: `heights read failed (will retry): ${msg(e)}`, at: deps.now() })
      await maybeSleep(); continue
    }
    lastHeights = heights
    const rec = session.toRecord()
    const emit = (action: WatchAction, note: string, extra: { gate?: WatchGate; confirmations?: number } = {}): void =>
      deps.emit({ state: session.state, role: rec.role, action, bsvHeight: heights.bsvHeight, baseHeight: heights.baseHeight, gate: extra.gate, refundTxid: session.toRecord().refundTxid, confirmations: extra.confirmations, note, at: deps.now() })

    /** Persist an adverse canonical event without inventing a success state. A competing Claim also publishes `s`;
     * record it through the existing reveal transition/verification so the BSV counter-leg remains recoverable, but
     * deliberately do not auto-claim it here (the Base-initiator watcher has no such capability). */
    const retainCompetingResolution = async (
      resolution: CompetingResolution,
      context: string,
      extra: { gate?: WatchGate; confirmations?: number } = {},
    ): Promise<boolean> => {
      try {
        // Stage on a copy: if the durable write fails, the live session must NOT retain an in-memory marker that
        // would make the next poll stop before persistence is retried.
        const candidate = SettlementSession.fromRecord(session.toRecord())
        if (resolution.outcome === 'claimed') {
          if (!resolution.preimageHex) throw new Error('finalized Claim outcome omitted its revealed preimage')
          if (candidate.state === 'refunding') candidate.noteCompetingRevealWhileRefunding(resolution.preimageHex)
          else if (candidate.state !== 'revealed') candidate.observeReveal(resolution.preimageHex, deps.now())
        }
        candidate.recordCompetingResolution(resolution)
        await deps.persist(candidate.toRecord())
        session = candidate
        emit(
          'needs-attention',
          `COMPETING Base ${resolution.outcome} resolution ${resolution.eventTxid} won during ${context}; market-maker recovery did not succeed — record retained, retries stopped, operator attention required`,
          extra,
        )
        return true
      } catch (e) {
        emit('wait', `competing-resolution proof could not be durably recorded (will retry fail-closed): ${msg(e)}`, extra)
        return false
      }
    }

    // detected in ANY situation — pre-refund, post-refund, OR a resumed already-`revealed` record — a watcher
    // that holds the receive-leg (USDC) claim key MUST claim it (we gave up / lost the BSV and are still owed the
    // USDC) and settle. A BSV-only watcher has no key and correctly stops at `revealed` instead. Shared so all
    // three entry points behave identically. Idempotent on the state machine: observeReveal only from a locked
    // state, markSettled only from `revealed`. Returns 'settled' on a completed claim, 'retry' if the claim threw
    // this poll (caller waits + re-polls — never gives up the claim).
    const claimReceiveAndSettle = async (secretHex: string, gate?: WatchGate): Promise<'settled' | 'competing' | 'retry'> => {
      try {
        // Persist the exact secret binding BEFORE any irreversible claim send. A crash after broadcast must resume with
        // the tuple+secret needed to validate that exact claim, never rediscover or accept caller-supplied identity.
        if (session.state === 'refunding') session.noteCompetingRevealWhileRefunding(secretHex)
        else if (session.state !== 'revealed') session.observeReveal(secretHex, deps.now())
        await deps.persist(session.toRecord())
        let claimTxid = rec.baseRecoveryClaimTxid
        let alreadyResolved = rec.baseRecoveryClaimAlreadyResolved === true
        // Keep an unconfirmed Base claim alive just like a refund. Its durable prior hash is the primary RBF source
        // on OP-stack RPCs that do not expose a pending block; replace it only on the bounded rebroadcast cadence.
        const rebroadcast = !!claimTxid && !alreadyResolved && i > 0 && i % refundRebroadcastEvery === 0
        if (!claimTxid || rebroadcast) {
          const priorBroadcastTxid = claimTxid as `0x${string}` | undefined
          const rebroadcastNotSent = Symbol('rebroadcastNotSent')
          const claimResult = await deps.claimReceiveLegOnReveal!(rec, secretHex, priorBroadcastTxid).catch((e): string | typeof rebroadcastNotSent => {
            if (!rebroadcast) throw e
            emit('wait', `receive-leg claim ${claimTxid} re-broadcast not sent (${msg(e)}) — checking the prior claim's finality`, { gate })
            return rebroadcastNotSent
          })
          if (claimResult !== rebroadcastNotSent) {
            const parsed = parseSwapAlreadyResolved(claimResult)
            const adopted = parseAdoptedClaim(claimResult)
            claimTxid = parsed?.txid ?? adopted ?? claimResult
            alreadyResolved = parsed !== null
            if (!/^0x[0-9a-fA-F]{64}$/.test(claimTxid)) {
              emit('wait', `receive-leg claim produced no real Base tx hash (${claimResult}); nothing terminal was persisted`, { gate })
              return 'retry'
            }
            session.recordBaseRecoveryClaim(claimTxid, alreadyResolved)
            await deps.persist(session.toRecord())
            emit('wait', `receive-leg claim ${claimTxid} ${adopted ? 'already made on Base (adopted, nothing sent)' : rebroadcast ? 'RE-broadcast' : 'broadcast'} — awaiting OP-stack finalized binding before settlement`, { gate })
          }
        }
        if (!deps.receiveClaimFinality) {
          emit('wait', `receive-leg claim ${claimTxid} has no finalized exact-tuple binding rail — refusing to settle (fail-closed)`, { gate })
          return 'retry'
        }
        let classification: ResolutionFinalityClassification
        try { classification = await deps.receiveClaimFinality(session.toRecord(), claimTxid!, alreadyResolved) }
        catch (e) {
          emit('wait', `receive-leg claim ${claimTxid} finality/binding read failed (will retry): ${msg(e)}`, { gate })
          return 'retry'
        }
        if (classification.kind === 'unresolved') {
          emit('wait', `receive-leg claim ${claimTxid} outcome is unresolved${classification.reason ? ` (${classification.reason})` : ''}; finalized claim(exact tuple, recorded secret) proof is absent — record kept`, { gate })
          return 'retry'
        }
        if (classification.kind === 'competing') {
          return await retainCompetingResolution(classification.resolution, 'receive-leg claim convergence', { gate })
            ? 'competing'
            : 'retry'
        }
        if (classification.eventTxid && classification.eventTxid.toLowerCase() !== claimTxid!.toLowerCase()) {
          claimTxid = classification.eventTxid
          session.recordBaseRecoveryClaim(claimTxid, false)
          await deps.persist(session.toRecord())
        }
        session.markSettled(deps.now()) // revealed/refunding → settled
        await deps.persist(session.toRecord())
        const detail = alreadyResolved
          ? `claim reverted, then a finalized Claim event proved the exact swap paid claimAddress (${claimTxid})`
          : `claim(exact tuple, recorded secret) ${claimTxid} reached the finalized head`
        emit('settled', `counterparty revealed \`s\` — recovered it + ${detail}`)
        return 'settled'
      } catch (e) {
        emit('wait', `receive-leg claim failed (will retry): ${msg(e)}`, { gate })
        return 'retry'
      }
    }

    // FAIL-SAFE: never act on a malformed height (a huge/NaN value could false-trigger or miss a refund).
    if (!validNonNegInt(heights.bsvHeight) || !validNonNegInt(heights.baseHeight)) {
      emit('wait', `malformed heights (bsv=${heights.bsvHeight}, base=${heights.baseHeight}) — skipping this poll`)
      await maybeSleep(); continue
    }

    const decision = evaluateWatch(rec, heights, secs)

    if (decision.action === 'settled' || decision.action === 'refunded' || decision.action === 'aborted' || decision.action === 'needs-attention') {
      emit(decision.action, decision.note)
      return session.toRecord()
    }
    if (decision.action === 'reveal-seen') {
      // BR-H3 INITIATOR claim recovery. `s` is already public and the exact BSV claim was durably persisted, so the
      // only safe completion is to keep the SAME claim alive until it buries. Broadcast alone never settles. A
      // malformed target/count or any read error fails closed for this poll and retries.
      if (rec.role === 'initiator' && deps.rebroadcastClaim && hasPersistedBsvClaimArtifact(rec)) {
        const target = rec.claimConfirmationTarget
        if (!Number.isInteger(target) || (target as number) < 1) {
          emit('wait', `persisted claimConfirmationTarget is malformed (${target}) — refusing to mark settled (fail-closed)`, { gate: decision.gate })
          await maybeSleep(); continue
        }
        const claimTarget = Math.max(target as number, minimumClaimConfs)
        if (!deps.claimArtifactTxid) {
          emit('wait', 'persisted claim artifact binding rail is not wired — refusing to read confirmations or settle (fail-closed)', { gate: decision.gate })
          await maybeSleep(); continue
        }
        let artifactTxid: string
        try {
          artifactTxid = await deps.claimArtifactTxid(rec)
        } catch (e) {
          emit('wait', `persisted claim artifact is not canonically bound to this swap (record kept): ${msg(e)}`, { gate: decision.gate })
          await maybeSleep(); continue
        }
        if (artifactTxid.toLowerCase() !== rec.bsvClaimTxid!.toLowerCase()) {
          emit('wait', `persisted claim artifact-derived txid ${artifactTxid} does not match bsvClaimTxid ${rec.bsvClaimTxid} — refusing to settle`, { gate: decision.gate })
          await maybeSleep(); continue
        }
        if (!deps.claimConfirmations) {
          emit('wait', 'claim confirmation rail is not wired — refusing to mark settled or re-broadcast blind (fail-closed)', { gate: decision.gate })
          await maybeSleep(); continue
        }
        let claimConfs: number
        try {
          claimConfs = await deps.claimConfirmations(rec, artifactTxid)
        } catch (e) {
          emit('wait', `claim confirmation read failed (will retry): ${msg(e)}`, { gate: decision.gate })
          await maybeSleep(); continue
        }
        if (!validNonNegInt(claimConfs)) {
          emit('wait', `malformed claim confirmation count (${claimConfs}) — treating as a read failure, will retry`, { gate: decision.gate })
          await maybeSleep(); continue
        }
        if (claimConfs >= claimTarget) {
          if (!deps.claimFinality) {
            emit('wait', `BSV claim ${artifactTxid} reached ${claimConfs} confirmations but no validated-header finality proof rail is wired — refusing to settle`, { confirmations: claimConfs })
            await maybeSleep(); continue
          }
          let final: boolean
          try { final = await deps.claimFinality(rec, artifactTxid, claimConfs) }
          catch (e) {
            emit('wait', `BSV claim ${artifactTxid} finality proof failed (will retry; record kept): ${msg(e)}`, { confirmations: claimConfs })
            await maybeSleep(); continue
          }
          if (!final) {
            emit('wait', `BSV claim ${artifactTxid} lacks a validated-header proof at depth ${claimTarget} — refusing terminal state/delete`, { confirmations: claimConfs })
            await maybeSleep(); continue
          }
          session.markSettled(deps.now())
          await deps.persist(session.toRecord())
          emit('settled', `BSV claim ${artifactTxid} artifact-bound + header-validated (${claimConfs} conf ≥ ${claimTarget}) — swap settled`, { confirmations: claimConfs })
          return session.toRecord()
        }
        // A write-ahead record means the secret MAY still be private: a crash can occur after persistence and before
        // the initial broadcast. Before every due submission (including recovery poll zero), establish whether the
        // BSV lock was spent and whether our exact claim is already public. These reads are deliberately fail-closed.
        const rebroadcastDue = i === 0 || (i > 0 && i % refundRebroadcastEvery === 0)
        if (rebroadcastDue) {
          const manualAttention = (note: string): void => {
            // Keep the record live and audible without flooding a long-running recovery's status sink.
            if (i % 10 === 0) emit('needs-attention', note, { gate: decision.gate, confirmations: claimConfs })
            else emit('wait', 'manual intervention remains active; claim not broadcast', { gate: decision.gate, confirmations: claimConfs })
          }
          if (!deps.resolveSpender) {
            emit('wait', 'BSV lock-spender rail is not wired — refusing to re-broadcast claim blind (fail-closed)', { gate: decision.gate, confirmations: claimConfs })
            await maybeSleep(); continue
          }
          const [lockTxid, voutText] = (rec.bsvLockOutpoint ?? '').split('_')
          const vout = Number(voutText)
          if (!lockTxid || !Number.isSafeInteger(vout) || vout < 0) {
            emit('wait', 'persisted BSV lock outpoint is malformed — refusing to re-broadcast claim blind (fail-closed)', { gate: decision.gate, confirmations: claimConfs })
            await maybeSleep(); continue
          }
          let spenderTxid: string | null
          try {
            const discovered: unknown = await deps.resolveSpender(lockTxid, vout)
            spenderTxid = typeof discovered === 'string' ? discovered : null
          } catch (e) {
            emit('wait', `BSV lock-spender read failed (will retry; claim not broadcast): ${msg(e)}`, { gate: decision.gate, confirmations: claimConfs })
            await maybeSleep(); continue
          }
          if (spenderTxid && spenderTxid.toLowerCase() !== artifactTxid.toLowerCase()) {
            let competingSpend: 'verified' | 'disproven' | 'unverifiable'
            if (!/^[0-9a-f]{64}$/i.test(spenderTxid)) {
              competingSpend = 'disproven'
            } else if (!deps.fetchTx) {
              competingSpend = 'unverifiable'
            } else {
              try {
                const tx = await deps.fetchTx(spenderTxid)
                if (!tx || typeof tx !== 'object' || !('id' in tx) || typeof tx.id !== 'function' || !('inputs' in tx) || !Array.isArray(tx.inputs)) {
                  competingSpend = 'unverifiable'
                } else {
                  const fetched = tx as { id: (encoding: 'hex') => string; inputs: Array<{ sourceTXID?: string; sourceOutputIndex?: number }> }
                  if (!isExactFetchedTx(fetched, spenderTxid)) {
                    competingSpend = 'unverifiable'
                  } else competingSpend = fetched.inputs.some((input) =>
                    input.sourceTXID?.toLowerCase() === lockTxid.toLowerCase() && input.sourceOutputIndex === vout,
                  ) ? 'verified' : 'disproven'
                }
              } catch {
                competingSpend = 'unverifiable'
              }
            }
            if (competingSpend === 'verified') {
              manualAttention(`MANUAL ATTENTION: BSV lock spent by ${spenderTxid.slice(0, 8)} (not our claim); claim not broadcast; check Base`)
              await maybeSleep(); continue
            }
            if (competingSpend === 'disproven') {
              emit('wait', `BSV spender discovery reported non-spender ${spenderTxid.slice(0, 8)}; continuing claim recovery`, { gate: decision.gate, confirmations: claimConfs })
              spenderTxid = null
            } else {
              let claimKnown = false
              if (deps.fetchTx) {
                try { claimKnown = isExactFetchedTx(await deps.fetchTx(artifactTxid), artifactTxid) } catch { /* remains unverifiable */ }
              }
              if (!claimKnown) {
                manualAttention(`MANUAL ATTENTION: BSV spender ${spenderTxid.slice(0, 8)} is unverifiable; claim not broadcast; check Base`)
                await maybeSleep(); continue
              }
              // A fetched copy proves our persisted claim is already public, so replaying it cannot reveal the secret.
              spenderTxid = artifactTxid
            }
          }
          // A discovery answer naming our artifact is still only an unverified assertion. Treat it exactly as an
          // unspent result so the exact-id public-claim check and reveal runway below decide whether replay is safe.
          if (spenderTxid?.toLowerCase() === artifactTxid.toLowerCase()) spenderTxid = null
          if (!spenderTxid) {
            let claimKnown = false
            if (deps.fetchTx) {
              try {
                claimKnown = isExactFetchedTx(await deps.fetchTx(artifactTxid), artifactTxid)
              } catch (e) {
                emit('wait', `BSV claim lookup failed (will retry; claim not broadcast): ${msg(e)}`, { gate: decision.gate, confirmations: claimConfs })
                await maybeSleep(); continue
              }
            }
            if (!claimKnown) {
              const runway = session.guardInitiatorCanReveal(heights.bsvHeight, { recovery: true })
              if (!runway.ok) {
                manualAttention('MANUAL ATTENTION: reveal runway expired before the claim was seen; claim not broadcast; USDC is refundable after the Base timelock once the BSV is refunded')
                await maybeSleep(); continue
              }
            }
          }
          try {
            const again = await deps.rebroadcastClaim(rec)
            emit('claim-broadcast', `BSV claim ${rec.bsvClaimTxid} unconfirmed (${claimConfs}/${claimTarget}) — ${i === 0 ? 'broadcast' : 'RE-broadcast'} for mempool-eviction recovery (${isRealRefundTxid(again) ? again : 'revalidated'})`, { gate: decision.gate, confirmations: claimConfs })
          } catch (e) {
            emit('wait', `claim re-broadcast failed (will retry): ${msg(e)}`, { gate: decision.gate })
          }
        } else {
          emit('claim-broadcast', `BSV claim ${rec.bsvClaimTxid} awaiting confirmation (${claimConfs}/${claimTarget})`, { gate: decision.gate, confirmations: claimConfs })
        }
        await maybeSleep(); continue
      }
      // A resumed record already in `revealed` (a prior poll/run recorded the counterparty reveal but a restart
      
      // resume, not merely re-observe the reveal. The secret is on the record (observeReveal persisted it); fall
      // back to an on-chain re-read if it's somehow absent. A BSV-only watcher (no key) has nothing more to do.
      if (deps.claimReceiveLegOnReveal) {
        let secret: string | null = rec.secretHex ?? null
        if (!secret) {
          try {
            secret = await deps.checkReveal(rec)
          } catch (e) {
            emit('wait', `resumed revealed: reveal re-read failed (will retry): ${msg(e)}`, { gate: decision.gate })
            await maybeSleep(); continue
          }
        }
        if (secret) {
          const res = await claimReceiveAndSettle(secret, decision.gate)
          if (res === 'retry') { await maybeSleep(); continue }
          return session.toRecord()
        }
        emit('wait', 'resumed revealed but the secret is not yet recoverable — will retry', { gate: decision.gate })
        await maybeSleep(); continue
      }
      emit('reveal-seen', decision.note) // BSV-only watcher: session already 'revealed' — nothing more to do
      return session.toRecord()
    }
    if (decision.action === 'idle' || decision.action === 'wait') {
      emit(decision.action, decision.note, { gate: decision.gate }) // heartbeat
      await maybeSleep(); continue
    }

    // Matured (refund-bsv | refund-base). Recovery is confirmation-gated; the session stays LOCKED and
    // the broadcast txid is DURABLE on the record, so a restart resumes here in confirmation mode.
    if (!isRealRefundTxid(rec.refundTxid)) {
      // Another process may have advanced the same durable swap after this watcher was armed from its frozen
      // in-memory snapshot. Re-read immediately before the FIRST broadcast and defer to the authoritative writer
      // when its pure decision no longer calls for this refund. A missing/unreadable record fails CLOSED.
      if (deps.reloadPersistedRecord) {
        let fresh: SettlementRecord
        try {
          fresh = await deps.reloadPersistedRecord()
        } catch (e) {
          emit('wait', `persisted-record re-read failed — NOT refunding this poll (fail-closed): ${msg(e)}`, { gate: decision.gate })
          await maybeSleep(); continue
        }
        const freshDecision = evaluateWatch(fresh, heights, secs)
        if (freshDecision.action !== decision.action) {
          emit(freshDecision.action, `persisted record advanced to '${fresh.state}' in another process — deferring to the authoritative writer, NOT refunding`, { gate: decision.gate })
          return fresh
        }
      }
      // A Base refund after the BSV claim published `s` would take both legs. Every initiator recovery must inspect
      // durable claim evidence plus the exact BSV lock outpoint; a missing rail is itself doubt and fails closed.
      if (decision.action === 'refund-base') {
        if (!deps.assertInitiatorRefundSafe) {
          deps.onInitiatorRefundSafetyResult?.('initiator refund safety rail is missing')
          emit('wait', 'initiator refund safety rail is missing — NOT refunding because BSV claim/preimage status is unknown', { gate: decision.gate })
          await maybeSleep(); continue
        }
        try {
          await deps.assertInitiatorRefundSafe(rec)
          deps.onInitiatorRefundSafetyResult?.()
        } catch (e) {
          const error = msg(e)
          deps.onInitiatorRefundSafetyResult?.(error)
          emit('wait', `initiator BSV claim/preimage check failed — NOT refunding this poll (fail-closed): ${error}`, { gate: decision.gate })
          await maybeSleep(); continue
        }
      }
      // Not yet broadcast (or a dry-sentinel-poisoned record, or retrying a failed broadcast). Check for a
      // counterparty reveal first —
      // if it can't be verified (dep throws), FAIL CLOSED: do NOT refund into a possible live claim.
      let revealed: string | null
      try {
        revealed = await deps.checkReveal(rec)
      } catch (e) {
        emit('wait', `reveal check failed — NOT refunding this poll (fail-closed): ${msg(e)}`, { gate: decision.gate })
        await maybeSleep(); continue
      }
      if (revealed) {
        // The counterparty revealed `s` before our refund broadcast — they're taking the BSV. A keyed responder
        
        // observe and stop); a BSV-only watcher records the reveal + stops.
        if (deps.claimReceiveLegOnReveal) {
          const res = await claimReceiveAndSettle(revealed, decision.gate)
          if (res === 'retry') { await maybeSleep(); continue }
          return session.toRecord()
        }
        if (session.state === 'refunding') session.noteCompetingRevealWhileRefunding(revealed)
        else session.observeReveal(revealed, deps.now()) // legal: locked → revealed
        await deps.persist(session.toRecord()) // durable: the recorded reveal must survive a crash
        emit('reveal-seen', 'counterparty revealed `s` before our refund broadcast — stopping (no receive-leg key wired; their claim is live)')
        return session.toRecord()
      }
      try {
        const txid = decision.action === 'refund-bsv' ? await deps.refundBsv(rec) : await deps.refundBase(rec)
        const alreadyResolved = parseSwapAlreadyResolved(txid)
        if (alreadyResolved) {
          // Only adapters that observed a mined revert AND then proved isSwapLocked(exact tuple)===false may return
          // this sentinel. Tuple absence is still ambiguous: only the finalized Claim/Refund event outcome below can
          // distinguish our favorable duplicate from a counterparty win.
          let classification: ResolutionFinalityClassification = { kind: 'unresolved', reason: 'outcome-classification rail is not wired' }
          try {
            if (deps.alreadyResolvedFinality) classification = await deps.alreadyResolvedFinality(rec, alreadyResolved)
          } catch (e) {
            classification = { kind: 'unresolved', reason: msg(e) }
          }
          if (classification.kind === 'unresolved') {
            emit('wait', `refund reverted and exact tuple appears resolved (${alreadyResolved.txid}), but the finalized outcome is unresolved${classification.reason ? ` (${classification.reason})` : ''} — record kept`, { gate: decision.gate })
            await maybeSleep(); continue
          }
          if (classification.kind === 'competing') {
            if (await retainCompetingResolution(classification.resolution, 'refund convergence', { gate: decision.gate })) return session.toRecord()
            await maybeSleep(); continue
          }
          if (session.state !== 'refunding') session.beginRefund(deps.now())
          session.markRefunded(deps.now())
          await deps.persist(session.toRecord())
          emit('refunded', `refund reverted, then a finalized Refund event proved refundAddress recovered the exact swap (${alreadyResolved.txid}) — terminal`, { gate: decision.gate })
          return session.toRecord()
        }
        if (!isRealRefundTxid(txid)) {
          // DRY (or a dep that didn't send): the refund was revalidated but nothing broadcast — heartbeat
          // only. Do NOT persist the sentinel as a broadcast; the record stays clean/unbroadcast so a later
          // LIVE run actually sends. (The DRY-poison fix.)
          emit('wait', `DRY — refund revalidated, nothing broadcast (${txid})`, { gate: decision.gate })
        } else {
          // DURABLE (review 97e33fa6 HIGH): record the txid + the confirmation target IN FORCE, then
          // persist immediately — so a crash after this point resumes into tracking, never re-broadcast.
          session.recordRefundBroadcast(txid, refundConfs)
          await deps.persist(session.toRecord())
          emit('refund-broadcast', `refund broadcast ${txid} — awaiting ${refundConfs} confirmation(s)`, { gate: decision.gate })
        }
      } catch (e) {
        emit('wait', `refund broadcast FAILED (will retry): ${msg(e)}`, { gate: decision.gate })
      }
    } else {
      // POST-REFUND REVEAL BACKSTOP (responder, red-team 2026-08-31): a counterparty CLAIM can win the race AFTER
      // our refund broadcast — spending the lock + revealing `s` — so our refund never confirms and we are still
      // owed the receive leg. When a claim capability is wired, detect the reveal, recover `s`, claim the receive
      // leg, and settle (instead of waiting for a refund that will never bury). Only fires for a keyed responder
      // watcher; the initiator / BSV-only watchers don't wire it, so their behavior is unchanged.
      if (deps.claimReceiveLegOnReveal) {
        let revealed: string | null = null
        try {
          revealed = await deps.checkReveal(rec)
        } catch (e) {
          emit('wait', `post-refund reveal check failed (will retry): ${msg(e)}`, { gate: decision.gate })
          await maybeSleep(); continue
        }
        if (revealed) {
          const res = await claimReceiveAndSettle(revealed, decision.gate)
          if (res === 'retry') { await maybeSleep(); continue }
          return session.toRecord()
        }
      }
      // Broadcast is out (this run or a prior one) — we're committed to the timeout race; wait for OUR
      // refund to bury. A confirmation-read error retries (never falsely marks recovered). The target
      // is the one PERSISTED at broadcast, so a restart under different config can't lower the bar.
      // FAIL-CLOSED (review 22a7c876 LOW): validate the persisted target — a corrupt record with a 0/
      // negative/fractional target would otherwise let 0 confirmations satisfy it. Fall back to config
      // only when it's ABSENT (not yet persisted this run), never when it's present-but-malformed.
      let target: number
      if (rec.refundConfirmationTarget === undefined) {
        target = refundConfs
      } else if (Number.isInteger(rec.refundConfirmationTarget) && rec.refundConfirmationTarget >= 1) {
        target = Math.max(rec.refundConfirmationTarget, minimumRefundConfs)
      } else {
        emit('wait', `persisted refundConfirmationTarget is malformed (${rec.refundConfirmationTarget}) — refusing to mark recovered (fail-closed)`, { gate: decision.gate })
        await maybeSleep(); continue
      }
      let confs: number
      try {
        confs = await deps.refundConfirmations(rec, rec.refundTxid)
      } catch (e) {
        emit('wait', `confirmation read failed (will retry): ${msg(e)}`, { gate: decision.gate })
        await maybeSleep(); continue
      }
      // FAIL-CLOSED (review 97e33fa6 MEDIUM): a non-finite/negative/fractional count must NOT satisfy
      // the threshold — treat a malformed confirmation count exactly like a read failure.
      if (!validNonNegInt(confs)) {
        emit('wait', `malformed confirmation count (${confs}) — treating as a read failure, will retry`, { gate: decision.gate })
        await maybeSleep(); continue
      }
      if (confs >= target) {
        if (!deps.refundFinality) {
          emit('wait', `refund ${rec.refundTxid} has ${confs} confirmation(s), but no chain-finality proof rail is wired — refusing terminal state/delete`, { confirmations: confs })
          await maybeSleep(); continue
        }
        let final: boolean
        try { final = await deps.refundFinality(rec, rec.refundTxid, confs) }
        catch (e) {
          emit('wait', `refund ${rec.refundTxid} finality proof failed (will retry; record kept): ${msg(e)}`, { confirmations: confs })
          await maybeSleep(); continue
        }
        if (!final) {
          emit('wait', `refund ${rec.refundTxid} has ${confs} confirmation(s) but lacks chain-finality proof — refusing terminal state/delete`, { confirmations: confs })
          await maybeSleep(); continue
        }
        if (!deps.refundBelongsToSwap) {
          emit('wait', `refund ${rec.refundTxid} has ${confs} confirmation(s), but no swap-binding proof rail is wired — refusing to mark recovered (fail-closed)`, { confirmations: confs })
          await maybeSleep(); continue
        }
        let bound: boolean
        try {
          bound = await deps.refundBelongsToSwap(rec, rec.refundTxid)
        } catch (e) {
          emit('wait', `refund ${rec.refundTxid} binding check failed (will retry; record kept): ${msg(e)}`, { confirmations: confs })
          await maybeSleep(); continue
        }
        if (!bound) {
          emit('wait', `refund ${rec.refundTxid} is confirmed but is NOT bound to this swap — refusing terminal state/delete (fail-closed)`, { confirmations: confs })
          await maybeSleep(); continue
        }
        if (session.state !== 'refunding') session.beginRefund(deps.now()) // locked → refunding; recovered refunding already passed this
        session.markRefunded(deps.now()) // refunding → refunded
        await deps.persist(session.toRecord()) // durable: the terminal recovered state
        emit('refunded', `refund ${rec.refundTxid} confirmed (${confs} conf ≥ ${target}) — funds recovered`, { confirmations: confs })
        return session.toRecord()
      }
      // RE-broadcast the pre-signed refund periodically (mempool-eviction recovery) — a relayed-but-evicted refund
      // would otherwise never mine and the watch would spin forever awaiting a tx no longer in any mempool (red-team
      // 2026-08-30). Idempotent (same txid; the ladder treats already-in-mempool as success); a throw retries next
      // poll. We KEEP the original persisted txid/target — never lower the confirmation bar, never re-persist.
      if (i > 0 && i % refundRebroadcastEvery === 0) {
        try {
          const again = decision.action === 'refund-bsv' ? await deps.refundBsv(rec) : await deps.refundBase(rec)
          const alreadyResolved = parseSwapAlreadyResolved(again)
          if (alreadyResolved) {
            let classification: ResolutionFinalityClassification = { kind: 'unresolved', reason: 'outcome-classification rail is not wired' }
            try {
              if (deps.alreadyResolvedFinality) classification = await deps.alreadyResolvedFinality(rec, alreadyResolved)
            } catch (e) {
              classification = { kind: 'unresolved', reason: msg(e) }
            }
            if (classification.kind === 'unresolved') {
              emit('wait', `refund re-broadcast reverted and exact tuple appears resolved (${alreadyResolved.txid}), but the finalized outcome is unresolved${classification.reason ? ` (${classification.reason})` : ''} — record kept`, { confirmations: confs })
              await maybeSleep(); continue
            }
            if (classification.kind === 'competing') {
              if (await retainCompetingResolution(classification.resolution, 'refund re-broadcast convergence', { confirmations: confs })) return session.toRecord()
              await maybeSleep(); continue
            }
            if (session.state !== 'refunding') session.beginRefund(deps.now())
            session.markRefunded(deps.now())
            await deps.persist(session.toRecord())
            emit('refunded', `refund re-broadcast reverted, then a finalized Refund event proved refundAddress recovered the exact swap (${alreadyResolved.txid}) — terminal, no retry`, { confirmations: confs })
            return session.toRecord()
          }
          if (isRealRefundTxid(again) && again.toLowerCase() !== rec.refundTxid.toLowerCase()) {
            session.recordRefundBroadcast(again, target)
            await deps.persist(session.toRecord())
          }
          emit('refund-broadcast', `refund ${rec.refundTxid} unconfirmed (${confs}/${target}) — RE-broadcast for mempool-eviction recovery (${isRealRefundTxid(again) ? again : 'revalidated'})`, { gate: decision.gate, confirmations: confs })
        } catch (e) {
          emit('wait', `refund re-broadcast failed (will retry): ${msg(e)}`, { gate: decision.gate })
        }
      } else {
        emit('refund-broadcast', `refund ${rec.refundTxid} awaiting confirmation (${confs}/${target})`, { gate: decision.gate, confirmations: confs })
      }
    }
    await maybeSleep()
  }
  return session.toRecord()
}
