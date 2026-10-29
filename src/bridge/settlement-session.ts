import { Hash, LockingScript, P2PKH, PublicKey, Spend, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { CLTV_TIMESTAMP_THRESHOLD, type BsvHtlcUtxo } from '../settlement/htlc'
// COVENANT-ONLY (Step E) — the CLTV self-enforcing refund (HIGH#1). Legacy 2-of-2 origination was deleted: the
// session ALWAYS builds/validates the covenant HTLC (refund committed in-script → the MM reclaims ALONE, no taker
// signature). Recovery of any pre-existing legacy lock lives in the narrow standalone surface (`scripts/recover-bsv-2of2-refund.ts`
// + `assertRefundArtifactValid`), NOT here. The `htlcKind` field is retained (vestigial, always covenant) until E-3.
import { buildBridgeCovenantScript, bridgeCovenantRefundSats, extractBridgeCovenantSecret, type BridgeCovenantTerms } from '../settlement/htlc/bridge-covenant'
import {
  MIN_REVEAL_CONFIRM_BUDGET_BLOCKS,
  checkResponderRunwayAndOrdering,
  isChainHeight,
} from './responder-ordering'
export {
  BASE_BLOCK_SECS_EST,
  BSV_BLOCK_SECS_EST,
  CROSS_CHAIN_MARGIN_SECS,
  MAX_RESPONDER_WINDOW_BLOCKS,
  MIN_RESPONDER_BASE_MARGIN_BLOCKS,
  MIN_RESPONDER_WINDOW_BLOCKS,
  MIN_REVEAL_CONFIRM_BUDGET_BLOCKS,
  bsvRefundGammaUpperBoundSecs,
  checkResponderRunwayAndOrdering,
  isChainHeight,
  type ResponderOrderingInputs,
} from './responder-ordering'

export const MAX_REFUND_FEE_SATS = 5000

/** Which BSV HTLC the swap uses. `legacy2of2` = signature-claim + 2-of-2 {taker,MM} refund (needs the taker's
 *  post-lock signature). `covenant` = forced-output claim + an MM-alone CLTV refund committed in the script
 *  (`bridge-covenant.ts`) — the HIGH#1 fix (a compromised MM can never strand a co-signed lock). */
export type BsvHtlcKind = 'legacy2of2' | 'covenant'

/** Default reserved miner-fee headroom (sats) for a covenant claim / refund spend, when the params don't pin one.
 *  Both legs derive the SAME script, so both must use the same budget (it is committed) — this default keeps a swap
 *  that omits the fields deterministic. The executor overrides it from the live fee rate × the covenant-spend size. */
export const DEFAULT_COVENANT_FEE_BUDGET_SATS = 1000

export type SwapRole = 'initiator' | 'responder'

export type SettlementState =
  | 'created' // params set, nothing locked yet
  | 'base-locked' // initiator's USDC locked on Base
  | 'bsv-locked' // responder's BSV locked — both legs up
  | 'revealed' // secret revealed on-chain (normally the machine's BSV claim; recovery can also observe Base Claim)
  | 'settled' // both legs claimed — success (terminal)
  | 'refunding' // a timeout hit; refund in flight
  | 'refunded' // funds recovered (terminal)
  | 'aborted' // pre-lock guard refused / never started (terminal)

const TERMINAL: ReadonlySet<SettlementState> = new Set(['settled', 'refunded', 'aborted'])

/** Allowed transitions — fail-closed for a money machine (illegal moves throw). */
const ALLOWED: Record<SettlementState, ReadonlySet<SettlementState>> = {
  created: new Set(['base-locked', 'aborted']),
  'base-locked': new Set(['bsv-locked', 'revealed', 'refunding', 'aborted']), // a finalized Base Claim can reveal s even if the local BSV-lock observation was lost
  'bsv-locked': new Set(['revealed', 'refunding']),
  revealed: new Set(['settled', 'refunding']),
  refunding: new Set(['settled', 'refunded']), // a competing reveal can win while a recovered refund is in flight
  settled: new Set(),
  refunded: new Set(),
  aborted: new Set(),
}

export interface SettlementParams {
  // ── cross-chain core ──
  /** `H = SHA256(s)` (32-byte hex) — the shared hashlock. */
  hashHex: string
  /** USDC amount in base units (string for precision). */
  amountUsdc: string
  /** BSV amount (sats) locked on the BSV side. */
  amountBsvSats: number
  /** Quote/bond transcript reference (RFQ) — audit trail. */
  quoteRef: string

  // ── timeouts (§12.8: on-chain gates are BLOCK HEIGHTS; the height-native guards use them) ──
  /** The EVM lock's on-chain timelock — a Base BLOCK HEIGHT (what `refund()` gates on). */
  baseTimelockBlock: number
  /** The BSV refund's on-chain `nLockTime` — a BSV BLOCK HEIGHT (like P2.5). */
  bsvRefundLocktime: number
  
  claimBudgetBaseBlocks: number
  // Wall-clock PLAN metadata — only for the cross-chain structural-gap check + logging.
  baseRefundTs: number // T_base wall-clock (Unix ts)
  bsvRefundTs: number // T_bsv wall-clock (Unix ts, < baseRefundTs)
  claimBudgetBaseSecs: number // required T_base − T_bsv wall-clock floor

  // ── BSV leg ──
  bsvClaimPubKeyHex: string // machine's claim pubkey (compressed hex)
  bsvRefundPubKeyHex: string 
  /** Which BSV HTLC this swap uses (default `legacy2of2`). `covenant` = the MM-alone CLTV refund (HIGH#1 fix). */
  htlcKind?: BsvHtlcKind
  /** Covenant only — reserved miner-fee headroom (sats) for the taker's CLAIM spend (committed in the script). */
  bsvClaimFeeBudgetSats?: number
  /** Covenant only — reserved miner-fee headroom (sats) for the MM's REFUND spend (committed in the script). */
  bsvRefundFeeBudgetSats?: number

  // ── Base leg (ERC20Swap, standard mode — §12.4) ──
  baseChainId: number
  erc20SwapAddress: string
  usdcTokenAddress: string
  usdcDecimals: number
  baseClaimAddress: string 
  baseRefundAddress: string // machine's Base address (refund)

  // ── caps (§12.5) ──
  capUsdPerSwap: number
  /**
   * §12.11 SPEED: swaps strictly BELOW this USD value are 0-conf-eligible — the machine
   * may reveal `s` against a broadly-propagated, double-spend-monitored (ARC) 0-conf BSV
   * lock instead of waiting a ~10-min confirmation. Sized to the merchant risk model: the
   * swap must be worth less than the cost of attacking it. Above it → require a confirmation.
   */
  zeroConfCapUsd: number
}

export interface SettlementRecord extends SettlementParams {
  role: SwapRole
  state: SettlementState
  /** Records created by builds with initiator claim write-ahead carry this durable capability marker. When true,
   *  absence of both a BSV lock outpoint and claim/reveal evidence proves no claim bytes were ever broadcast. Older
   *  records omit it and require a chain-history lookup before their Base refund can be considered safe. */
  bsvClaimWriteAhead?: true
  /** The preimage `s` (hex) — only the holder persists it. */
  secretHex?: string
  /** BSV HTLC outpoint once locked. */
  bsvLockOutpoint?: string
  /** Base lock event coordinates (to derive claim/refund calldata). */
  baseLockTxHash?: string
  /** Presence is the buyer-kit write-ahead capability marker (including an empty array before the first lock).
   *  Entries are locally signed lock attempts or nonce-consuming zero-value self-transfers, written before submit. */
  baseLockAttempts?: Array<{ txHash: `0x${string}`; nonce: number; kind?: 'lock' | 'burn'; at?: number }>
  baseLockLogIndex?: number
  /** The Base block the USDC lock mined in — BOUNDS the watcher's Claim-event scan (a Claim can't
   *  precede the lock), so `eth_getLogs` never queries from block 0 and blows a public-RPC range cap. */
  baseLockBlock?: number
  /** Unix timestamp of the Base lock block, when the observing rail can provide it. */
  baseLockTimestamp?: number
  /** Pre-signed BSV refund tx hex (§12.3 — the BSV side IS pre-signable). */
  bsvRefundTxHex?: string
  /** BR-H3: the initiator's already-broadcast BSV claim txid. The raw transaction is persisted below so a
   *  restarted watcher can submit the exact same spend again after a mempool eviction. */
  bsvClaimTxid?: string
  /** BR-H3: the bare claim transaction. This is the fallback for rails that do not accept Atomic BEEF. */
  bsvClaimTxHex?: string
  /** BR-H3: the self-contained Atomic BEEF originally submitted to the SPV rail (preferred on re-broadcast). */
  bsvClaimBeefHex?: string
  /** BR-H3: the burial target in force when the claim was first broadcast. */
  claimConfirmationTarget?: number
  /** Phase 2c-A: the responder watcher's Base receive-leg recovery claim. It is persisted immediately after the
   *  irreversible send so a restart tracks this exact transaction to OP-stack finality instead of sending again. */
  baseRecoveryClaimTxid?: string
  /** A mined revert may only converge through the legacy already-resolved path after the exact tuple is observed gone
   *  at the finalized head. This flag distinguishes that path from our own successful claim transaction. */
  baseRecoveryClaimAlreadyResolved?: boolean
  /** A finalized COUNTERPARTY resolution won the Base race. This is deliberately a durable marker rather than a
   * success state: the record must remain operator-visible and must never enter terminal compare-and-delete. */
  competingResolution?: CompetingResolution
  /** §12.14: the BROADCAST refund txid, persisted so a restarted watchtower RESUMES confirmation
   *  tracking instead of re-broadcasting. The leg is derivable from `role`. */
  refundTxid?: string
  /** §12.14: the confirmation target in force WHEN the refund was broadcast — persisted so a restart
   *  under different config can't LOWER the bar and mark recovered early. */
  refundConfirmationTarget?: number
  /** Why the session aborted, if it did. */
  abortReason?: string
  /** Transition log (`at` from the injected clock). */
  history: Array<{ state: SettlementState; at: number }>
}

export interface CompetingResolution {
  /** `claimed` paid baseClaimAddress; `refunded` paid baseRefundAddress. Which one is adverse depends on our role. */
  outcome: 'claimed' | 'refunded'
  /** Transaction that emitted the finalized canonical Claim/Refund event. */
  eventTxid: string
  /** Bare 32-byte preimage revealed by a competing Claim. */
  preimageHex?: string
}

export interface GuardResult {
  ok: boolean
  reason?: string
}

/**
 * The FULL ERC20Swap lockup a responder actually observes on Base — every field the
 * contract commits to, plus the emitter + chain. The responder MUST validate this
 * against the negotiated params BEFORE locking BSV; matching `H` alone is not enough
 * (a malicious initiator can publish any `H` with wrong economics). §12.2.
 */
export interface ObservedBaseLock {
  txHash: string
  logIndex: number
  preimageHash: string // H (0x-hex or bare) from the Lockup event
  amount: bigint // USDC base units actually locked
  tokenAddress: string // token actually locked
  claimAddress: string 
  refundAddress: string // who may refund (must be the machine)
  timelock: bigint // T_base actually committed on-chain
  contractAddress: string // the ERC20Swap that emitted it
  chainId: number // the chain it was observed on
  blockNumber?: number // the block the lock mined in (bounds the watcher's Claim-event scan; metadata, not identity)
}

const HEX32 = /^[0-9a-fA-F]{64}$/
const NON_EMPTY_BYTE_HEX = /^(?:[0-9a-fA-F]{2})+$/
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/
const COMPRESSED_PUBKEY = /^(?:02|03)[0-9a-fA-F]{64}$/
const BSV_OUTPOINT = /^([0-9a-fA-F]{64})_(0|[1-9][0-9]*)$/
const SETTLEMENT_STATES: ReadonlySet<string> = new Set([
  'created', 'base-locked', 'bsv-locked', 'revealed', 'settled', 'refunding', 'refunded', 'aborted',
])
/** Persisted claim artifacts cross a JSON trust boundary. Reject malformed hex before an adapter can hand it to a
 *  BSV broadcaster/parser; partial legacy records remain loadable but are deliberately not actionable. The persisted
 *  confirmation target is validated at the confirmation gate so a corrupt value can never falsely settle. */
function validateOptionalClaimArtifactHex(rec: SettlementRecord): void {
  if (rec.bsvClaimTxid !== undefined && !HEX32.test(rec.bsvClaimTxid)) {
    throw new Error('SettlementRecord: bsvClaimTxid must be a 32-byte hex txid when set')
  }
  for (const [name, value] of [['bsvClaimTxHex', rec.bsvClaimTxHex], ['bsvClaimBeefHex', rec.bsvClaimBeefHex]] as const) {
    if (value !== undefined && !NON_EMPTY_BYTE_HEX.test(value)) {
      throw new Error(`SettlementRecord: ${name} must be non-empty byte-aligned hex when set`)
    }
  }
}

function validateCompetingResolution(rec: SettlementRecord): void {
  const resolution = rec.competingResolution
  if (resolution === undefined) return
  if (typeof resolution !== 'object' || resolution === null ||
      (resolution.outcome !== 'claimed' && resolution.outcome !== 'refunded')) {
    throw new Error('SettlementRecord: competingResolution must identify a claimed/refunded outcome')
  }
  if (!EVM_TX_HASH.test(resolution.eventTxid)) {
    throw new Error('SettlementRecord: competingResolution.eventTxid must be a 0x-prefixed 32-byte EVM tx hash')
  }
  const expectedOutcome = rec.role === 'initiator' ? 'claimed' : 'refunded'
  if (resolution.outcome !== expectedOutcome) {
    throw new Error(`SettlementRecord: competingResolution '${resolution.outcome}' is not competing for role '${rec.role}'`)
  }
  if (TERMINAL.has(rec.state)) {
    throw new Error('SettlementRecord: a competingResolution record must remain non-terminal for operator attention')
  }
  if (resolution.outcome === 'claimed') {
    if (!resolution.preimageHex || !HEX32.test(resolution.preimageHex)) {
      throw new Error('SettlementRecord: a claimed competingResolution must carry its 32-byte preimageHex')
    }
    const digest = Utils.toHex(Hash.sha256(Utils.toArray(resolution.preimageHex, 'hex') as number[]))
    if (digest.toLowerCase() !== rec.hashHex.toLowerCase()) {
      throw new Error('SettlementRecord: competingResolution.preimageHex does not hash to hashHex')
    }
    if (rec.secretHex?.toLowerCase() !== resolution.preimageHex.toLowerCase()) {
      throw new Error('SettlementRecord: a claimed competingResolution must also persist the revealed secretHex')
    }
  } else if (resolution.preimageHex !== undefined) {
    throw new Error('SettlementRecord: a refunded competingResolution must not carry preimageHex')
  }
}

/**
 * Validate the complete persisted-record trust boundary using the same parameter invariants as fresh session
 * creation. This deliberately checks shape/economics only: whether a terminal label contradicts live chain state is
 * a daemon classification that needs rails and therefore lives at that layer.
 */
export function validateSettlementRecord(rec: SettlementRecord): void {
  validateParams(rec)
  if (rec.role !== 'initiator' && rec.role !== 'responder') throw new Error(`SettlementRecord: invalid role '${String(rec.role)}'`)
  if (!SETTLEMENT_STATES.has(rec.state)) throw new Error(`SettlementRecord: invalid state '${String(rec.state)}'`)
  if (rec.bsvClaimWriteAhead !== undefined && rec.bsvClaimWriteAhead !== true) {
    throw new Error('SettlementRecord: bsvClaimWriteAhead must be true when set')
  }
  if (!Array.isArray(rec.history)) throw new Error('SettlementRecord: history must be an array')
  if (rec.history.length === 0) throw new Error('SettlementRecord: history must be non-empty')
  for (let i = 0; i < rec.history.length; i++) {
    const item = rec.history[i] as { state?: unknown; at?: unknown } | null
    if (typeof item !== 'object' || item === null || !SETTLEMENT_STATES.has(String(item.state)) ||
        !Number.isSafeInteger(item.at) || (item.at as number) < 0) {
      throw new Error(`SettlementRecord: history[${i}] must be {state, at} with a valid state and non-negative safe-integer timestamp`)
    }
    if (i === 0 && item.state !== 'created') {
      throw new Error("SettlementRecord: history must begin at the legal 'created' origin")
    }
    if (i > 0) {
      const prior = rec.history[i - 1]
      if ((item.at as number) < prior.at) throw new Error(`SettlementRecord: history timestamps must be non-decreasing (history[${i - 1}] → history[${i}])`)
      if (!ALLOWED[prior.state].has(item.state as SettlementState)) {
        throw new Error(`SettlementRecord: illegal history transition ${prior.state} → ${String(item.state)}`)
      }
    }
  }
  if (rec.history[rec.history.length - 1].state !== rec.state) {
    throw new Error(`SettlementRecord: last history state '${rec.history[rec.history.length - 1].state}' does not equal current state '${rec.state}'`)
  }

  if (rec.secretHex !== undefined) {
    if (!HEX32.test(rec.secretHex)) throw new Error('SettlementRecord: secretHex must be 32-byte hex when set')
    const digest = Utils.toHex(Hash.sha256(Utils.toArray(rec.secretHex, 'hex') as number[]))
    if (digest.toLowerCase() !== rec.hashHex.toLowerCase()) throw new Error('SettlementRecord: SHA256(secretHex) does not equal hashHex')
  }
  if (rec.state === 'revealed' && rec.secretHex === undefined) {
    throw new Error('SettlementRecord: a revealed record must carry its 32-byte secretHex')
  }

  if (rec.bsvLockOutpoint !== undefined) {
    const match = BSV_OUTPOINT.exec(rec.bsvLockOutpoint)
    const vout = match ? Number(match[2]) : NaN
    if (!match || !Number.isSafeInteger(vout) || vout < 0 || vout > 0xffff_ffff) {
      throw new Error('SettlementRecord: bsvLockOutpoint must be <32-byte txid>_<uint32 vout>')
    }
  }
  if (rec.baseLockTxHash !== undefined && !EVM_TX_HASH.test(rec.baseLockTxHash)) {
    throw new Error('SettlementRecord: baseLockTxHash must be a 0x-prefixed 32-byte EVM tx hash')
  }
  if (rec.baseLockAttempts !== undefined) {
    if (!Array.isArray(rec.baseLockAttempts) || rec.baseLockAttempts.some((attempt) =>
      typeof attempt !== 'object' || attempt === null || !EVM_TX_HASH.test(attempt.txHash) ||
      !Number.isSafeInteger(attempt.nonce) || attempt.nonce < 0 ||
      (attempt.kind !== undefined && attempt.kind !== 'lock' && attempt.kind !== 'burn') ||
      (attempt.at !== undefined && (!Number.isSafeInteger(attempt.at) || attempt.at < 0)) ||
      (attempt.kind === 'burn' && attempt.at === undefined),
    )) {
      throw new Error('SettlementRecord: baseLockAttempts must contain 0x-prefixed 32-byte tx hashes, non-negative safe-integer nonces, optional lock/burn kinds, and non-negative safe-integer timestamps (required for burns)')
    }
  }
  if (rec.baseRecoveryClaimTxid !== undefined && !EVM_TX_HASH.test(rec.baseRecoveryClaimTxid)) {
    throw new Error('SettlementRecord: baseRecoveryClaimTxid must be a 0x-prefixed 32-byte EVM tx hash')
  }
  if (rec.baseRecoveryClaimAlreadyResolved !== undefined && typeof rec.baseRecoveryClaimAlreadyResolved !== 'boolean') {
    throw new Error('SettlementRecord: baseRecoveryClaimAlreadyResolved must be boolean when set')
  }
  if (rec.baseRecoveryClaimAlreadyResolved !== undefined && rec.baseRecoveryClaimTxid === undefined) {
    throw new Error('SettlementRecord: baseRecoveryClaimAlreadyResolved requires baseRecoveryClaimTxid')
  }
  // The initiator persists its own Base lock before it has an event coordinate or a receipt block.  It deliberately
  // keeps logIndex -1 even after landing because its lock submission rail does not track the emitted log index.
  // A responder always learns an observed event, so it keeps the strict event-coordinate rule.
  const initiatorOwnLockLogIndex = rec.role === 'initiator' && rec.baseLockLogIndex === -1
  if (rec.baseLockLogIndex !== undefined && (!Number.isSafeInteger(rec.baseLockLogIndex) ||
      (rec.baseLockLogIndex < 0 && !initiatorOwnLockLogIndex))) {
    throw new Error('SettlementRecord: baseLockLogIndex must be a non-negative safe integer, except -1 for an initiator own lock')
  }
  const initiatorOwnLockUnknownBlock = rec.role === 'initiator' && rec.baseLockBlock === 0
  if (rec.baseLockBlock !== undefined && (!Number.isSafeInteger(rec.baseLockBlock) ||
      (rec.baseLockBlock <= 0 && !initiatorOwnLockUnknownBlock))) {
    throw new Error('SettlementRecord: baseLockBlock must be positive, except 0 for an initiator own lock')
  }
  if (rec.baseLockTimestamp !== undefined && (!Number.isSafeInteger(rec.baseLockTimestamp) || rec.baseLockTimestamp < 0)) {
    throw new Error('SettlementRecord: baseLockTimestamp must be a non-negative safe integer when set')
  }
  if (rec.bsvRefundTxHex !== undefined && !NON_EMPTY_BYTE_HEX.test(rec.bsvRefundTxHex)) {
    throw new Error('SettlementRecord: bsvRefundTxHex must be non-empty byte-aligned hex when set')
  }
  validateOptionalClaimArtifactHex(rec)
  for (const [name, value] of [
    ['claimConfirmationTarget', rec.claimConfirmationTarget],
    ['refundConfirmationTarget', rec.refundConfirmationTarget],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`SettlementRecord: ${name} must be a positive safe integer when set`)
    }
  }
  if (rec.refundTxid !== undefined) {
    const valid = rec.role === 'initiator' ? EVM_TX_HASH.test(rec.refundTxid) : HEX32.test(rec.refundTxid)
    if (!valid) throw new Error(`SettlementRecord: refundTxid has the wrong format for role '${rec.role}'`)
  }
  if (rec.abortReason !== undefined && typeof rec.abortReason !== 'string') {
    throw new Error('SettlementRecord: abortReason must be a string when set')
  }
  validateCompetingResolution(rec)
}

/** Bare lowercase hex (strip an optional `0x`) — for hash + address equality. */
const normHex = (s: string): string => s.trim().toLowerCase().replace(/^0x/, '')
/** EVM addresses compare case-insensitively (no checksum semantics). */
const eqAddr = (a: string, b: string): boolean => normHex(a) === normHex(b)

export class SettlementSession {
  private rec: SettlementRecord

  private constructor(rec: SettlementRecord) {
    this.rec = rec
  }

  /** Start a fresh session (state `created`). Validates the structural invariants. */
  static create(params: SettlementParams, role: SwapRole, now: number): SettlementSession {
    validateParams(params, now)
    return new SettlementSession({
      ...params,
      role,
      state: 'created',
      bsvClaimWriteAhead: true,
      history: [{ state: 'created', at: now }],
    })
  }

  /** Rehydrate from a persisted record (watcher restart / handoff). */
  static fromRecord(rec: SettlementRecord): SettlementSession {
    // General in-process callers may intentionally exercise a partially populated legacy/fault record. The daemon
    // trust boundary calls validateSettlementRecord before rehydration; retain the existing wire-artifact guard here.
    // The competing marker itself controls whether recovery stops, so validate that new control field everywhere.
    validateOptionalClaimArtifactHex(rec)
    validateCompetingResolution(rec)
    return new SettlementSession({ ...rec, history: [...rec.history] })
  }

  toRecord(): SettlementRecord {
    return { ...this.rec, history: [...this.rec.history] }
  }

  get state(): SettlementState {
    return this.rec.state
  }
  get role(): SwapRole {
    return this.rec.role
  }
  get isTerminal(): boolean {
    return TERMINAL.has(this.rec.state)
  }

  // ── §12.2 mechanical guards (the invariant as code, not prose) ──

  guardResponderCanLock(heights: { bsvHeight: number; baseHeight: number }): GuardResult {
    if (this.rec.role !== 'responder') return { ok: false, reason: 'only the responder locks BSV' }
    if (this.rec.state !== 'base-locked') return { ok: false, reason: `must observe the Base lock first (state=${this.rec.state})` }
    if (!isChainHeight(heights.bsvHeight) || !isChainHeight(heights.baseHeight)) {
      return { ok: false, reason: `invalid live height(s) bsv=${heights.bsvHeight} base=${heights.baseHeight} — must be finite non-negative integers (fail-closed; a NaN/Infinity would silently pass every runway/ordering check)` }
    }
    if (this.rec.baseRefundTs - this.rec.bsvRefundTs < this.rec.claimBudgetBaseSecs) {
      return { ok: false, reason: 'structural gap T_base−T_bsv < claim budget (wall-clock plan)' }
    }
    
    return checkResponderRunwayAndOrdering(
      { bsvRefundLocktime: this.rec.bsvRefundLocktime, baseTimelockBlock: this.rec.baseTimelockBlock, claimBudgetBaseBlocks: this.rec.claimBudgetBaseBlocks },
      heights,
    )
  }

  /** The machine's BSV claim is only relayable before the BSV refund height. */
  bsvClaimExpired(bsvHeight: number): boolean {
    return bsvHeight >= this.rec.bsvRefundLocktime
  }
  latestSafeClaimPassed(baseHeight: number): boolean {
    return baseHeight >= this.rec.baseTimelockBlock - this.rec.claimBudgetBaseBlocks
  }

  /**
   * §12.11/§12.12 SIZE predicate: is the swap strictly below the (negotiated) 0-conf cap? Pure size,
   * NO trust — used for routing + logging. Path A additionally requires `reputationOk`; see
   * `zeroConfEligible`. "Strictly below" (`<`) is deliberate: a swap exactly at the cap takes path B.
   */
  sizeEligible(): boolean {
    const usd = Number(BigInt(this.rec.amountUsdc)) / 10 ** this.rec.usdcDecimals
    return usd < this.rec.zeroConfCapUsd
  }

  zeroConfEligible(reputationOk: boolean): boolean {
    return this.sizeEligible() && reputationOk
  }

  /**
   * The INITIATOR (machine) reveal gate: only reveal `s` (by claiming BSV) when the BSV
   * lock is up AND the LIVE BSV height is far enough below the refund height for the claim
   * to CONFIRM first — not merely below it. Revealing inside the budget risks the claim not
   * burying in time, the responder refunding, then also taking USDC with the public `s`.
   * Takes the live BSV block height.
   */
  guardInitiatorCanReveal(bsvHeight: number, opts: { recovery?: boolean } = {}): GuardResult {
    if (this.rec.role !== 'initiator') return { ok: false, reason: 'only the initiator reveals by claiming BSV' }
    // Recovery may resume after the write-ahead has durably recorded the reveal. It is still subject to the
    // identical live runway check before it may publish those persisted claim bytes for the first time.
    if (this.rec.state !== 'bsv-locked' && !(opts.recovery === true && this.rec.state === 'revealed')) {
      return { ok: false, reason: `BSV must be locked first (state=${this.rec.state})` }
    }
    if (!isChainHeight(bsvHeight)) return { ok: false, reason: `invalid live BSV height ${bsvHeight} — must be a finite non-negative integer (fail-closed)` }
    const revealWindow = this.rec.bsvRefundLocktime - bsvHeight
    if (revealWindow < MIN_REVEAL_CONFIRM_BUDGET_BLOCKS) {
      return { ok: false, reason: `reveal window ${revealWindow} block(s) < ${MIN_REVEAL_CONFIRM_BUDGET_BLOCKS} — too close to the BSV refund height; the claim may not confirm before the responder can refund` }
    }
    return { ok: true }
  }
  // ── event-driven transitions (fail-closed) ──
  /**
   * Compare a full observed Base lockup against the negotiated params — the §12.2
   * money guard. Fail-closed: EVERY committed field (amount, token, the claim and refund
   * addresses, timelock, contract, chain, H) must match, else the responder must not
   * lock BSV. Pure (no transition) so a watcher/test can check without advancing.
   */
  validateObservedBaseLock(obs: ObservedBaseLock): GuardResult {
    const r = this.rec
    if (normHex(obs.preimageHash) !== normHex(r.hashHex)) {
      return { ok: false, reason: `H mismatch: got ${obs.preimageHash} want ${r.hashHex}` }
    }
    if (obs.amount !== BigInt(r.amountUsdc)) {
      return { ok: false, reason: `amount mismatch: got ${obs.amount} want ${r.amountUsdc}` }
    }
    if (!eqAddr(obs.tokenAddress, r.usdcTokenAddress)) {
      return { ok: false, reason: `token mismatch: got ${obs.tokenAddress} want ${r.usdcTokenAddress}` }
    }
    if (!eqAddr(obs.claimAddress, r.baseClaimAddress)) {
      return { ok: false, reason: `claimAddress mismatch: got ${obs.claimAddress} want ${r.baseClaimAddress}` }
    }
    if (!eqAddr(obs.refundAddress, r.baseRefundAddress)) {
      return { ok: false, reason: `refundAddress mismatch: got ${obs.refundAddress} want ${r.baseRefundAddress}` }
    }
    if (obs.timelock !== BigInt(r.baseTimelockBlock)) {
      return { ok: false, reason: `timelock (block) mismatch: got ${obs.timelock} want ${r.baseTimelockBlock}` }
    }
    if (!eqAddr(obs.contractAddress, r.erc20SwapAddress)) {
      return { ok: false, reason: `contract mismatch: got ${obs.contractAddress} want ${r.erc20SwapAddress}` }
    }
    if (obs.chainId !== r.baseChainId) {
      return { ok: false, reason: `chainId mismatch: got ${obs.chainId} want ${r.baseChainId}` }
    }
    return { ok: true }
  }

  /**
   * Initiator's USDC lock observed on Base. Fail-closed: the FULL on-chain tuple must
   * match the negotiated params (via `validateObservedBaseLock`) — this is the choke
   * point that stops a responder from locking BSV against a lock with wrong economics.
   */
  observeBaseLock(obs: ObservedBaseLock, now: number): void {
    const v = this.validateObservedBaseLock(obs)
    if (!v.ok) throw new Error(`observeBaseLock: ${v.reason}`)
    this.transition('base-locked', now)
    this.rec.baseLockTxHash = obs.txHash
    this.rec.baseLockLogIndex = obs.logIndex
    if (obs.blockNumber !== undefined) this.rec.baseLockBlock = obs.blockNumber
  }

  /** After the lock's receipt returns, record the REAL txid + block (review 4576b3 MED). The pre-lock observe (review
   *  fde1afe HIGH-1) uses a PLACEHOLDER txid so a receipt-wait crash still leaves an actionable 'base-locked' record;
   *  this restores the true txid + the Claim-scan lower bound once the receipt lands. Refund is params-keyed, so this
   *  is forensics/scan-bound, not identity. No-op outside 'base-locked' (never re-transitions). */
  noteBaseLockLanded(txHash: string, blockNumber: number): void {
    if (this.rec.state !== 'base-locked') return
    this.rec.baseLockTxHash = txHash
    if (Number.isFinite(blockNumber) && blockNumber > 0) this.rec.baseLockBlock = blockNumber
  }

  /** Mark this placeholder as produced by a kit that durably records every signed lock before broadcast. */
  beginBaseLockAttempts(): void {
    if (this.rec.state === 'base-locked') this.rec.baseLockAttempts = []
  }

  /** Write-ahead forensic record for a locally signed Base lock.  The caller persists immediately before raw submit. */
  noteBaseLockAttempt(attempt: { txHash: `0x${string}`; nonce: number; kind?: 'lock'; at?: number }): void {
    if (this.rec.state !== 'base-locked') return
    this.rec.baseLockAttempts = [...(this.rec.baseLockAttempts ?? []), attempt]
  }

  observeBsvLock(evt: { outpoint: string; refundTxHex?: string }, now: number): void {
    if (this.rec.role === 'responder' && evt.refundTxHex) {
      
      // co-sign), so recovery needs NO pre-signed artifact and NO taker cooperation — a compromised MM can never
      // strand it. If the responder still supplies a (rebuildable) covenant refund for the watchtower, validate it.
      this.assertRefundRecovers(evt.outpoint, evt.refundTxHex)
    }
    this.transition('bsv-locked', now)
    this.rec.bsvLockOutpoint = evt.outpoint
    if (evt.refundTxHex) this.rec.bsvRefundTxHex = evt.refundTxHex
  }

  assertRefundRecovers(outpoint: string, refundTxHex: string): void {
    let tx: Transaction
    try {
      tx = Transaction.fromHex(refundTxHex)
    } catch {
      throw new Error('observeBsvLock: refundTxHex is not a decodable transaction')
    }
    const [txid0, voutStr0] = outpoint.split('_')
    const vout0 = Number(voutStr0)
    // COVENANT-ONLY (Step E) EXECUTION proof (the recurring lesson: interpreter-valid, not shape-only): the covenant
    // refund must actually spend THIS outpoint AND validate against the covenant lock — which self-enforces
    // {output[0]=MM refund, nLockTime ≥ T_bsv, non-final sequence}. Any deviation (early, redirected, mis-indexed) is
    // refused by Spend. (Value-conservation / no-stray-output are ENFORCED IN-SCRIPT by the covenant's forced output.)
    const input = tx.inputs.find((i) => i.sourceTXID === txid0 && i.sourceOutputIndex === vout0)
    if (!input || !input.unlockingScript) throw new Error('observeBsvLock: covenant refund does not spend the lock outpoint')
    const spend = new Spend({
      sourceTXID: txid0, sourceOutputIndex: vout0, sourceSatoshis: this.rec.amountBsvSats,
      lockingScript: LockingScript.fromHex(this.bsvHtlcScriptHex()), transactionVersion: tx.version, otherInputs: [],
      outputs: tx.outputs, inputIndex: tx.inputs.indexOf(input), unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff, lockTime: tx.lockTime,
    })
    let ok = false
    try { ok = spend.validate() } catch { ok = false }
    if (!ok) throw new Error('observeBsvLock: covenant refund does not validate against the lock (fail-closed)')
  }

  /** Secret revealed on BSV (machine claimed) — `s` is now public. Fail-closed:
   *  the revealed `s` MUST satisfy `SHA256(s) == H` (else it's not our swap's secret). */
  observeReveal(secretHex: string, now: number): void {
    const computed = Utils.toHex(Hash.sha256(Utils.toArray(secretHex, 'hex') as number[]))
    if (computed.toLowerCase() !== this.rec.hashHex.toLowerCase()) {
      throw new Error('observeReveal: SHA256(secret) does not equal H — wrong secret')
    }
    this.transition('revealed', now)
    this.rec.secretHex = secretHex
  }
  /** Record a competing reveal observed after a legacy/manual record already entered `refunding`. The refunding
   * state has already passed beginRefund and must not make the illegal refunding→revealed move; if the receive-leg
   * claim completes, the legitimate convergence is refunding→settled. */
  noteCompetingRevealWhileRefunding(secretHex: string): void {
    if (this.rec.state !== 'refunding') throw new Error('noteCompetingRevealWhileRefunding: state must be refunding')
    const computed = Utils.toHex(Hash.sha256(Utils.toArray(secretHex, 'hex') as number[]))
    if (computed.toLowerCase() !== this.rec.hashHex.toLowerCase()) {
      throw new Error('noteCompetingRevealWhileRefunding: SHA256(secret) does not equal H — wrong secret')
    }
    this.rec.secretHex = secretHex
  }

  /**
   * The INITIATOR persists the fresh secret it generated (verifies `SHA256(s) == H`
   * so a mismatched secret can never be stored). Held privately until reveal; lets a
   * restarted initiator re-drive its BSV claim. No-op-safe to call once, pre-reveal.
   */
  holdSecret(secretHex: string): void {
    if (this.rec.role !== 'initiator') throw new Error('holdSecret: only the initiator holds the secret pre-reveal')
    const computed = Utils.toHex(Hash.sha256(Utils.toArray(secretHex, 'hex') as number[]))
    if (computed.toLowerCase() !== this.rec.hashHex.toLowerCase()) {
      throw new Error('holdSecret: SHA256(secret) does not equal H — wrong secret')
    }
    this.rec.secretHex = secretHex
  }

  markSettled(now: number): void {
    this.transition('settled', now)
  }

  /**
   * §13 broadcast-side last gate: revalidate the STORED refund artifact (`bsvRefundTxHex` vs
   * `bsvLockOutpoint`) via the single validator, immediately before a watcher/drill broadcasts it —
   * so a corrupted / imported / stale persisted record can never spend. Throws if it no longer recovers.
   */
  assertPersistedRefundValid(): void {
    if (!this.rec.bsvLockOutpoint || !this.rec.bsvRefundTxHex) {
      throw new Error('assertPersistedRefundValid: no persisted BSV lock outpoint / refund to validate')
    }
    this.assertRefundRecovers(this.rec.bsvLockOutpoint, this.rec.bsvRefundTxHex)
  }

  /**
   * Phase 2c-A P3-01: execution-level proof for the persisted initiator claim. This deliberately reuses the same SDK
   * `Spend` interpreter and record-derived covenant script as the refund validator above. A matching-looking txid or
   * unlocking-script shape is not enough: the artifact must spend THIS outpoint through the covenant CLAIM branch with
   * THIS record's secret, and the covenant execution must accept its forced output[0] payout.
   */
  assertPersistedClaimValid(claimTx: Transaction): void {
    if (this.rec.role !== 'initiator') throw new Error('assertPersistedClaimValid: only an initiator owns the BSV claim artifact')
    if (!this.rec.bsvClaimTxid || !this.rec.bsvLockOutpoint || !this.rec.secretHex) {
      throw new Error('assertPersistedClaimValid: claim txid, BSV lock outpoint, and secret are required')
    }
    if (claimTx.id('hex').toLowerCase() !== this.rec.bsvClaimTxid.toLowerCase()) {
      throw new Error('assertPersistedClaimValid: artifact-derived txid does not match bsvClaimTxid')
    }
    const [lockTxid, voutText] = this.rec.bsvLockOutpoint.split('_')
    const vout = Number(voutText)
    const secret = extractBridgeCovenantSecret(claimTx, lockTxid, vout, this.rec.hashHex)
    if (!secret || Utils.toHex(secret).toLowerCase() !== this.rec.secretHex.toLowerCase()) {
      throw new Error('assertPersistedClaimValid: transaction does not use the recorded secret through this covenant claim path')
    }
    const inputIndex = claimTx.inputs.findIndex((input) => input.sourceTXID === lockTxid && input.sourceOutputIndex === vout)
    const input = claimTx.inputs[inputIndex]
    if (inputIndex !== 0 || !input?.unlockingScript) {
      throw new Error('assertPersistedClaimValid: covenant claim must spend the recorded outpoint at input[0]')
    }
    const spend = new Spend({
      sourceTXID: lockTxid,
      sourceOutputIndex: vout,
      sourceSatoshis: this.rec.amountBsvSats,
      lockingScript: LockingScript.fromHex(this.bsvHtlcScriptHex()),
      transactionVersion: claimTx.version,
      otherInputs: claimTx.inputs.filter((_candidate, index) => index !== inputIndex),
      outputs: claimTx.outputs,
      inputIndex,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: claimTx.lockTime,
    })
    let valid = false
    try { valid = spend.validate() } catch { valid = false }
    if (!valid) throw new Error('assertPersistedClaimValid: covenant claim does not validate against this swap lock (fail-closed)')
  }

  /**
   * §12.14 durability: persist the BROADCAST refund txid + the confirmation target in force at
   * broadcast. NO state change — the session stays in its LOCKED state (so a late reveal is still
   * recordable) until the refund CONFIRMS. A restarted watchtower reads these and resumes
   * confirmation-tracking (at the ORIGINAL target) instead of re-broadcasting. The CALLER must
   * durably persist `toRecord()` immediately after this (the watchtower's `persist` hook).
   */
  recordRefundBroadcast(refundTxid: string, confirmationTarget: number): void {
    this.rec.refundTxid = refundTxid
    this.rec.refundConfirmationTarget = confirmationTarget
  }

  /**
   * BR-H3 durability: persist the EXACT already-broadcast BSV claim + its burial target. NO state change — callers
   * invoke this immediately after `observeReveal`, and the session remains `revealed` through every re-broadcast and
   * confirmation read. Only a confirmation-gated watcher may advance it to `settled`.
   */
  recordClaimBroadcast(claimTxid: string, rawHex: string, beefHex: string | undefined, confirmationTarget: number): void {
    this.rec.bsvClaimTxid = claimTxid
    this.rec.bsvClaimTxHex = rawHex
    this.rec.bsvClaimBeefHex = beefHex
    this.rec.claimConfirmationTarget = confirmationTarget
  }

  /** Persist the responder daemon's exact Base claim hash before waiting for OP-stack finality. */
  recordBaseRecoveryClaim(txid: string, alreadyResolved: boolean): void {
    this.rec.baseRecoveryClaimTxid = txid
    this.rec.baseRecoveryClaimAlreadyResolved = alreadyResolved || undefined
  }

  /** Persist an adverse finalized Base outcome without pretending settlement/refund succeeded. Idempotent for the
   * same canonical event; a conflicting second observation is a hard contradiction and fails closed. */
  recordCompetingResolution(resolution: CompetingResolution): void {
    const prior = this.rec.competingResolution
    if (prior && (prior.outcome !== resolution.outcome || prior.eventTxid.toLowerCase() !== resolution.eventTxid.toLowerCase() ||
        prior.preimageHex?.toLowerCase() !== resolution.preimageHex?.toLowerCase())) {
      throw new Error('recordCompetingResolution: conflicting durable resolution already exists')
    }
    const candidate: SettlementRecord = { ...this.rec, competingResolution: { ...resolution }, history: [...this.rec.history] }
    validateCompetingResolution(candidate)
    this.rec.competingResolution = { ...resolution }
  }

  /** Begin the refund path (a timeout hit). */
  beginRefund(now: number): void {
    this.transition('refunding', now)
  }

  markRefunded(now: number): void {
    this.transition('refunded', now)
  }

  /**
   * Phase 2c-A reorg observation: a terminal recovery record is deliberately retained on disk. If its canonical
   * finality proof later disappears during that window, restore only the immediately-preceding recovery state while
   * keeping every tx artifact/txid. This is not a general terminal rollback: aborted sessions are never re-opened,
   * and the prior state/artifacts must identify one of the two recovery paths exactly.
   */
  rearmAfterTerminalReorg(now: number): void {
    const terminal = this.rec.state
    if (terminal !== 'settled' && terminal !== 'refunded') {
      throw new Error(`rearmAfterTerminalReorg: state '${terminal}' is not a reorg-observable recovery terminal`)
    }
    const terminalIndex = this.rec.history.map((entry) => entry.state).lastIndexOf(terminal)
    if (terminalIndex !== this.rec.history.length - 1) {
      throw new Error('rearmAfterTerminalReorg: terminal state is not the latest history entry')
    }
    const prior = terminalIndex > 0 ? this.rec.history[terminalIndex - 1]?.state : undefined
    if (terminal === 'refunded') {
      if (prior !== 'refunding' || !this.rec.refundTxid) {
        throw new Error('rearmAfterTerminalReorg: refunded record lacks its immediately-prior refunding state/txid')
      }
    } else {
      if (prior !== 'revealed' && prior !== 'refunding') {
        throw new Error('rearmAfterTerminalReorg: settled recovery lacks its immediately-prior revealed/refunding state')
      }
      const hasBsvClaim = this.rec.role === 'initiator' && !!this.rec.bsvClaimTxid &&
        (!!this.rec.bsvClaimTxHex || !!this.rec.bsvClaimBeefHex) && !!this.rec.secretHex
      const hasBaseClaim = this.rec.role === 'responder' && !!this.rec.baseRecoveryClaimTxid && !!this.rec.secretHex
      if (!hasBsvClaim && !hasBaseClaim) {
        throw new Error('rearmAfterTerminalReorg: settled record lacks a persisted recovery claim artifact')
      }
    }
    this.rec.state = prior
    // Remove the now-invalid terminal edge. Appending terminal→prior would manufacture a transition forbidden by
    // the state table and make the durable record fail its own complete history validation on the next scan.
    this.rec.history.pop()
    void now
  }

  /** Abort before locking (guard refusal / never started). */
  abort(reason: string, now: number): void {
    this.transition('aborted', now)
    this.rec.abortReason = reason
  }

  /** Build the BSV HTLC lock script from the session's params (delegates to the primitive). */
  
  /** The covenant terms this session commits. PUBLIC (non-secret) so the Half-2 isolated signer can RE-DERIVE the
   *  script from these with its OWN reserve address (doc 19: re-derive what you sign, don't trust the caller's bytes). */
  covenantTerms(): BridgeCovenantTerms {
    return {
      hashHex: this.rec.hashHex,
      takerBsvAddress: PublicKey.fromString(this.rec.bsvClaimPubKeyHex).toAddress(),
      mmBsvAddress: PublicKey.fromString(this.rec.bsvRefundPubKeyHex).toAddress(),
      htlcSats: this.rec.amountBsvSats,
      bsvRefundLocktime: this.rec.bsvRefundLocktime,
      claimFeeBudgetSats: this.rec.bsvClaimFeeBudgetSats ?? DEFAULT_COVENANT_FEE_BUDGET_SATS,
      refundFeeBudgetSats: this.rec.bsvRefundFeeBudgetSats ?? DEFAULT_COVENANT_FEE_BUDGET_SATS,
    }
  }

  bsvHtlcScriptHex(): string {
    // COVENANT-ONLY (Step E): the CLTV self-enforcing HTLC (HIGH#1) — claim FORCES payout→taker on reveal; refund
    // FORCES payout→MM after T_bsv, MM-alone (no taker signature). The refund recovery is committed here, in the
    
    return buildBridgeCovenantScript(this.covenantTerms()).toHex()
  }

  /** The BSV HTLC UTXO once locked (for building claim/refund via the primitive). */
  bsvHtlcUtxo(satoshis: number): BsvHtlcUtxo {
    if (!this.rec.bsvLockOutpoint) throw new Error('SettlementSession: BSV not locked yet')
    const [txid, vout] = this.rec.bsvLockOutpoint.split('_')
    return { txid, vout: Number(vout), satoshis, scriptHex: this.bsvHtlcScriptHex() }
  }

  private transition(to: SettlementState, now: number): void {
    const from = this.rec.state
    if (!ALLOWED[from].has(to)) {
      throw new Error(`SettlementSession: illegal transition ${from} → ${to}`)
    }
    this.rec.state = to
    this.rec.history.push({ state: to, at: now })
  }
}

/**
 * §12.12 — the 0-conf cap is NEGOTIATED, not hardcoded. Each party declares the max USD it will
 * transact at 0-conf against this counterparty (its risk tolerance); the effective cap is the MOST
 * CONSERVATIVE of the two (the min), clamped to `[0, capUsdPerSwap]`. In production the two
 * tolerances ride (authenticated) in the requester's intent + the provider's quote envelope; this is
 * the pure resolver the caller feeds them into. FAIL-CLOSED: any non-finite/negative input collapses
 * that side to 0 (0-conf disabled) rather than widening the fast path.
 */
export function negotiateZeroConfCap(initiatorToleranceUsd: number, responderToleranceUsd: number, capUsdPerSwap: number): number {
  const clean = (x: number): number => (Number.isFinite(x) && x >= 0 ? x : 0)
  return Math.min(clean(initiatorToleranceUsd), clean(responderToleranceUsd), clean(capUsdPerSwap))
}

// ─── param validation (fail-closed) ──────────────────────────────────

function validateParams(p: SettlementParams, now?: number): void {
  if (!HEX32.test(p.hashHex)) throw new Error('SettlementParams: hashHex must be 32-byte hex')
  if (!Number.isSafeInteger(p.bsvRefundTs) || !Number.isSafeInteger(p.baseRefundTs) ||
      p.bsvRefundTs < CLTV_TIMESTAMP_THRESHOLD || p.baseRefundTs < CLTV_TIMESTAMP_THRESHOLD) {
    throw new Error(`SettlementParams: timeouts must be Unix timestamps ≥ ${CLTV_TIMESTAMP_THRESHOLD}`)
  }
  if (!Number.isSafeInteger(p.claimBudgetBaseSecs) || p.claimBudgetBaseSecs <= 0) {
    throw new Error('SettlementParams: claimBudgetBaseSecs must be a positive safe integer')
  }
  if (p.bsvRefundTs >= p.baseRefundTs) {
    throw new Error('SettlementParams: T_bsv (short) must be < T_base (long)')
  }
  if (p.baseRefundTs - p.bsvRefundTs < p.claimBudgetBaseSecs) {
    throw new Error('SettlementParams: T_base − T_bsv must be ≥ claimBudgetBaseSecs (the claim gap)')
  }
  if (now !== undefined && p.bsvRefundTs <= now) throw new Error('SettlementParams: T_bsv already in the past')
  if (!Number.isSafeInteger(p.baseTimelockBlock) || p.baseTimelockBlock <= 0) {
    throw new Error('SettlementParams: baseTimelockBlock must be a positive Base block height (§12.8)')
  }
  if (!Number.isSafeInteger(p.bsvRefundLocktime) || p.bsvRefundLocktime <= 0) {
    throw new Error('SettlementParams: bsvRefundLocktime must be a positive BSV block height (§12.8)')
  }
  if (!Number.isSafeInteger(p.claimBudgetBaseBlocks) || p.claimBudgetBaseBlocks <= 0) {
    throw new Error('SettlementParams: claimBudgetBaseBlocks must be a positive number of Base blocks')
  }
  if (p.baseTimelockBlock - p.claimBudgetBaseBlocks <= 0) {
    throw new Error('SettlementParams: claimBudgetBaseBlocks must be < baseTimelockBlock (a valid safe-claim cutoff)')
  }
  if (!Number.isSafeInteger(p.amountBsvSats) || p.amountBsvSats <= 0) throw new Error('SettlementParams: amountBsvSats must be a positive safe integer')
  if (typeof p.quoteRef !== 'string' || p.quoteRef.trim().length === 0) throw new Error('SettlementParams: quoteRef must be a non-empty string')
  if (!COMPRESSED_PUBKEY.test(p.bsvClaimPubKeyHex) || !COMPRESSED_PUBKEY.test(p.bsvRefundPubKeyHex)) {
    throw new Error('SettlementParams: BSV claim/refund pubkeys must be compressed 33-byte hex')
  }
  // COVENANT-ONLY (Step E): legacy 2-of-2 origination was removed, so the only accepted kind is 'covenant' (unset ⇒
  // covenant). Reject any other value fail-closed — never silently mis-select the money-critical refund path.
  if (p.htlcKind !== undefined && p.htlcKind !== 'covenant') {
    throw new Error(`SettlementParams: htlcKind must be 'covenant' (legacy 2-of-2 origination removed in Step E; got '${String(p.htlcKind)}')`)
  }
  for (const [name, v] of [['bsvClaimFeeBudgetSats', p.bsvClaimFeeBudgetSats], ['bsvRefundFeeBudgetSats', p.bsvRefundFeeBudgetSats]] as const) {
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 0)) throw new Error(`SettlementParams: ${name} must be a non-negative integer when set (got ${String(v)})`)
  }
  // Covenant VIABILITY at session creation (review e3d1d3fb MED) — ALWAYS runs now (covenant is the only kind): the
  // payout/refund stay above dust after the fee budget, AND bsvRefundLocktime is a BLOCK HEIGHT (< LOCKTIME_THRESHOLD,
  // the CRITICAL domain guard) — must fire NOW, before EITHER leg locks funds. Reuse the ONE covenant builder (it runs
  // assertTerms + the locktime range) so there's a single source of truth.
  try {
    buildBridgeCovenantScript({
      hashHex: p.hashHex,
      takerBsvAddress: PublicKey.fromString(p.bsvClaimPubKeyHex).toAddress(),
      mmBsvAddress: PublicKey.fromString(p.bsvRefundPubKeyHex).toAddress(),
      htlcSats: p.amountBsvSats,
      bsvRefundLocktime: p.bsvRefundLocktime,
      claimFeeBudgetSats: p.bsvClaimFeeBudgetSats ?? DEFAULT_COVENANT_FEE_BUDGET_SATS,
      refundFeeBudgetSats: p.bsvRefundFeeBudgetSats ?? DEFAULT_COVENANT_FEE_BUDGET_SATS,
    })
  } catch (e) {
    throw new Error(`SettlementParams: invalid covenant terms (fail-closed BEFORE any lock): ${e instanceof Error ? e.message : String(e)}`)
  }
  if (typeof p.amountUsdc !== 'string' || !/^\d+$/.test(p.amountUsdc) || BigInt(p.amountUsdc) <= 0n) {
    throw new Error('SettlementParams: amountUsdc must be a positive integer string (base units)')
  }
  if (!Number.isSafeInteger(p.baseChainId) || p.baseChainId <= 0) {
    throw new Error('SettlementParams: baseChainId must be a positive safe integer')
  }
  for (const [name, value] of [
    ['erc20SwapAddress', p.erc20SwapAddress],
    ['usdcTokenAddress', p.usdcTokenAddress],
    ['baseClaimAddress', p.baseClaimAddress],
    ['baseRefundAddress', p.baseRefundAddress],
  ] as const) {
    if (typeof value !== 'string' || !EVM_ADDRESS.test(value)) throw new Error(`SettlementParams: ${name} must be a 20-byte 0x EVM address`)
  }
  // Fail-closed (review 6943edb1 MEDIUM): validate the cap + decimals BEFORE deriving usd — else an
  // Infinity/NaN capUsdPerSwap or a NaN/oversized usdcDecimals slips an over-cap swap past the check.
  if (!Number.isFinite(p.capUsdPerSwap) || p.capUsdPerSwap <= 0) {
    throw new Error('SettlementParams: capUsdPerSwap must be a finite positive USD amount (§12.5)')
  }
  if (!Number.isInteger(p.usdcDecimals) || p.usdcDecimals < 0 || p.usdcDecimals > 36) {
    throw new Error('SettlementParams: usdcDecimals must be an integer in [0, 36]')
  }
  // Cap check (§12.5) — usdc base units → USD via decimals.
  const usd = Number(BigInt(p.amountUsdc)) / 10 ** p.usdcDecimals
  if (usd > p.capUsdPerSwap) {
    throw new Error(`SettlementParams: swap ${usd} USD exceeds cap ${p.capUsdPerSwap} (§12.5)`)
  }
  // Fail-closed (§12.11 cycle-1): finite and within [0, capUsdPerSwap] — an Infinite or
  // over-cap value would silently make a FULL-cap swap 0-conf-eligible on the irreversible path.
  if (!Number.isFinite(p.zeroConfCapUsd) || p.zeroConfCapUsd < 0 || p.zeroConfCapUsd > p.capUsdPerSwap) {
    throw new Error(`SettlementParams: zeroConfCapUsd must be finite and in [0, capUsdPerSwap=${p.capUsdPerSwap}] (§12.11; 0 disables the 0-conf fast-path)`)
  }
}
