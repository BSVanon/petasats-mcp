import { PublicKey, Utils, type Transaction, type ChainTracker, type MerklePath } from '@bsv/sdk'
import { isAddress } from 'viem'
import { newHtlcSecret, type BsvHtlcUtxo } from '../settlement/htlc'
import { SettlementSession, DEFAULT_COVENANT_FEE_BUDGET_SATS, type SettlementParams, type SettlementRecord, type ObservedBaseLock, type BsvHtlcKind } from './settlement-session'
import { buildBridgeCovenantClaimTx, sizeCovenantFeeBudgetSats, type BridgeCovenantTerms } from '../settlement/htlc/bridge-covenant'
import { assertTokenAllowedAndDecimals } from './evm/token-allowlist'
import { preimageHashOf, type Erc20SwapParams } from './evm/erc20swap'
import type { BridgeIntent, BridgeQuote } from './settlement-types'
import { assertLockSafeForZeroConf, assertLockSafeForZeroConfMultiArc, watchRevealThroughClaim, watchRevealThroughClaimMultiArc, coverageLabel, type FetchTxStatus, type FetchArcStatuses } from './mainnet-zeroconf'
import { ARC_PROVIDERS, classifyArcStatus, classifyMultiArc, watchLockThroughClaim } from './zeroconf-monitor'
import { DEFAULT_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS } from './initiator-timelocks'
/** The concrete swap the initiator runs: deliver an allowlisted ERC-20, receive BSV. */
export interface BridgeDeliverErc20Spec {
  /** The ERC-20 the initiator delivers (locks on Base). Validated against the allowlist. */
  erc20TokenAddress: `0x${string}`
  /** Atomic units of the ERC-20 delivered (matched to the on-chain lock amount). */
  deliverAmount: bigint
  /** BSV sats the initiator receives (claims from the responder's HTLC). */
  receiveBsvSats: bigint
}

export interface BridgeInitiatorResult {
  ok: boolean
  /** The Base USDC lock (initiator's funds at risk until claim or watchtower refund). */
  baseLockTxid?: string
  /** The BSV claim that reveals the secret + completes the swap for the initiator. */
  bsvClaimTxid?: string
  reason?: string
  /** doc 25 change D: the swap's EVM preimageHash (0x-prefixed — the SAME hex `makeBrainInitiatorEvmRails.lock`
   *  registers as the signer's EVM-binding key; NOT the bare BSV-side `hashHex` used elsewhere), once known (set as
   *  soon as the secret/hashlock is generated). Lets a signer-routed caller release that binding at completion
   *  (review 220d1ef7 MED). Absent only if the swap never got as far as generating a secret. */
  hashHex?: `0x${string}`
}

/** SentTx-shaped subset the initiator needs from `Erc20SwapEvmClient`. */
interface SentTx { hash: string; status: 'success' | 'reverted' | 'pending'; blockNumber?: bigint }
type LockAttempt = { hash: `0x${string}`; signedTx: `0x${string}`; nonce: number }

export const DEFAULT_EVM_LOCK_LAND_DEADLINE_MS = 120_000
const EVM_LOCK_LAND_POLL_MS = 2_000

/** A double-spend is the one 0-conf refusal that must never take the confirmation fallback. */
class ZeroConfDoubleSpendSignal extends Error {
  constructor() {
    super('0-conf monitor: DOUBLE-SPEND detected on the BSV lock — refusing to reveal')
    this.name = 'ZeroConfDoubleSpendSignal'
  }
}

/** EVM rails the initiator swap needs (`Erc20SwapEvmClient` satisfies this structurally). */
export interface BridgeInitiatorEvmRails {
  address(): string
  readonly swapAddress: string
  readonly chainId: number
  tokenDecimals(token: `0x${string}`): Promise<number>
  allowance(token: `0x${string}`): Promise<bigint>
  approve(token: `0x${string}`, amount: bigint): Promise<SentTx>
  lock(p: Erc20SwapParams, authorizeNewBroadcast?: unknown, onRecorded?: (attempt: LockAttempt) => void | Promise<void>): Promise<SentTx>
  currentBlockNumber(): Promise<bigint>
  /** Exact-tuple escrow read; `blockNumber` pins it to that block (a node lacking the block must error). */
  isSwapLocked(p: Erc20SwapParams, opts?: { blockNumber?: bigint }): Promise<boolean>
}

/** BSV rails the initiator swap needs. */
export interface BridgeInitiatorBsvRails {
  /** Broadcast via the mainnet ladder — the RAW tx (raw-only tiers) + optional ATOMIC BEEF (BEEF-capable tiers carry
   *  the 0-conf lock ancestry). Returns the txid. */
  broadcast(rawTx: string, atomicBeefHex?: string): Promise<string>
  chainHeight(): Promise<number>
  /** Existing-lock/deadline reads may continue with one independent source. */
  readBsvHeight?(purpose: 'recovery'): Promise<number>
  /** Confirmations on the responder's BSV lock (the initiator waits before revealing). */
  txConfirmations(txid: string): Promise<number>
  /**
   * Fetch a tx so the initiator can VERIFY the responder's BSV lock OUTPUT on-chain before revealing the secret
   * (review 772f17b8 HIGH). A `bsv-locked` MESSAGE + a confirmed txid are NOT proof the negotiated HTLC output exists
   * — a lying/buggy responder could name any confirmed txid. This fetch lets the executor prove vout 0 has the exact
   * expected script + satoshis before it builds/broadcasts a claim carrying `s`. null ⇒ not found ⇒ do NOT reveal.
   */
  fetchTx(txid: string): Promise<Transaction | null>
  
  fetchBeef?(txid: string): Promise<Transaction | null>
}

/**
 * The post-selection handshake with the responder — the MIRROR of the responder coordinator (where it
 * recvs, the initiator sends). File-mailbox in the runner, Anvil messagebox in production (Phase 5), a fake
 * in tests. No message carries value: the USDC lock + BSV lock + reveal are all OBSERVED on-chain.
 */
export interface BridgeInitiatorCoordinator {
  sendIntent(intent: BridgeIntent): Promise<void>
  recvQuote(): Promise<BridgeQuote>
  sendBaseLocked(m: { txHash: `0x${string}`; blockNumber: number }): Promise<void>
  recvRefundSkeleton(): Promise<{ htlc: BsvHtlcUtxo; refundLocktime: number; toAddress: string; feeRate: number }>
  sendRefundSigA(m: { sigA: number[] }): Promise<void>
  recvBsvLocked(): Promise<{ bsvLockTxid: string; htlcScriptHex: string }>
  /** OPTIONAL 0-conf fast hint to the responder: a pointer to our BSV claim tx (still verified on-chain). */
  sendRevealHint?(m: { bsvClaimTxid: string }): Promise<void>
}
export interface BridgeInitiatorConfig {
  erc20SwapAddress: `0x${string}`
  baseChainId: number
  /** Blocks added to the current Base height for the USDC refund timelock. */
  baseTimelockBlocks: number
  /** Blocks added to the current BSV height for the responder's BSV refund nLockTime. */
  bsvRefundBlocks: number
  bsvFeeRate: number
  /** Confirmations required on the responder's BSV lock before revealing. Default 1. */
  bsvConfirmations?: number
  
  requireLockMerkleProof?: boolean
  /** Bounds on the merkle-proof fetch (the proof can lag the confirmation slightly). Defaults 10 tries / 3s. */
  lockProofMaxTries?: number
  lockProofRetryMs?: number
  /** Bounds on fetching the responder's announced BSV lock before the pre-reveal output check. The responder announces
   *  the lock the moment it broadcasts it, and a discovery source can lag the mempool (or throttle) for seconds, so a
   *  miss is re-checked instead of refusing at once. Defaults 40 tries / 3s (≈2 min); at most 1,000 tries, 60s apart. */
  lockTxFetchMaxTries?: number
  lockTxFetchRetryMs?: number
  capUsdPerSwap?: number
  /** 0-conf fast path (LEVER B #3/#4): a swap whose USDC value-at-risk ≤ this reveals against an UNCONFIRMED BSV lock,
   *  gated by the ARC double-spend monitor instead of a confirmation + merkle proof. 0 (default) ⇒ DISABLED — every swap
   *  waits ≥1 conf + SPV-verifies (the current safe posture). Above 0 REQUIRES `deps.zeroConfStatus` (else construction
   *  throws). Raised deliberately only after the red-team blesses the 1/3/6 set (B#4). */
  zeroConfCapUsd?: number
  /** LEVER B #3 — the pre-reveal ARC double-spend watch (assertLockSafeForZeroConf): how many status polls / the gap
   *  between them. The lock must stay ARC-accepted with NO double-spend across the whole window. Defaults 4 polls / 5s. */
  zeroConfPolls?: number
  zeroConfSleepMs?: number
  /** LEVER B #3 — the post-reveal §12.12 detection watch (watchRevealThroughClaim): max rounds to wait for OUR claim to
   *  bury (≥1 conf) before concluding a ≤cap loss. Default 240 → 240 × zeroConfSleepMs(5s) = 1200s ≈ 2 BSV blocks, so an
   *  HONEST claim has time to mine (red-team 2026-09-04: 40 polls = 200s ≪ a ~600s BSV block → the watch gave up before
   *  the first-seen claim could confirm, false-reporting completed swaps as failures + false-nuking reputation). */
  zeroConfClaimMaxPolls?: number
  zeroConfClaimMaxBlocks?: number
  /** LEVER B #3 — require the 0-conf clear to be witnessed by at least this many DISTINCT ARC-class providers (vantage
   *  points). Default 1 (the mainnet-proven floor — assertLockSafeForZeroConf already needs ≥1 ARC 'accepted'); set 2
   *  for the pilot to demand corroboration. */
  zeroConfMinArcProviders?: number
  claimBudgetBaseBlocks?: number
  /** Vestigial (Step E): the swap is COVENANT-ONLY — the taker DEFERS to `quote.htlcKind` (CVN-6) and refuses any
   *  non-covenant quote. The covenant claim is a forced payout with NO refund round-trip (the responder's refund is
   *  MM-alone, committed in-script — HIGH#1). Field retained until E-3 removes it fleet-wide. */
  htlcKind?: BsvHtlcKind
  bsvClaimFeeBudgetSats?: number
  bsvRefundFeeBudgetSats?: number
  /** Bounded same-operation retry window for an outcome-unknown Base lock. Default 120 seconds. */
  lockLandDeadlineMs?: number
  
  approveOnlyBelowAllowance?: boolean
  
  recordLockAttempts?: boolean
}

export interface BridgeInitiatorDeps {
  /** The initiator's BSV reserve PUBLIC key. doc 25 change B: the initiator never signs BSV — the covenant claim is
   *  KEYLESS (a script-forced payout to `bsvReservePub.toAddress()`; see buildBridgeCovenantClaimTx), so only the
   *  public key is needed here, never a private key. Was `bsvKey: PrivateKey`. */
  bsvReservePub: PublicKey
  evm: BridgeInitiatorEvmRails
  bsv: BridgeInitiatorBsvRails
  coordinator: BridgeInitiatorCoordinator
  config: BridgeInitiatorConfig
  chainTracker?: ChainTracker
  zeroConfStatus?: FetchTxStatus
  /** Seam 4a (full pilot): the MULTI-provider ARC status rail (`getMultiArcTxStatuses`) — REQUIRED when
   *  `config.zeroConfMinArcProviders ≥ 2`. Each poll queries every configured ARC provider so the reveal needs ≥N
   *  DISTINCT ARC providers to ACCEPT, not just Anvil (which the single `zeroConfStatus` rail can never corroborate). */
  zeroConfArcStatuses?: FetchArcStatuses
  /** Persist the at-risk USDC session so the Base watchtower can refund at the timelock. */
  persist?(rec: SettlementRecord): void
  /**
   * Durably link an application row to the hashlock before the first settlement record is written.  This closes the
   * crash window between an admitted request and its write-ahead recovery record.
   */
  onHashlockCreated?(hashHex: string): Promise<void>
  /** M-4 (red-team): clear the at-risk record on a CLEAN settle. Without it the initiator re-persists on settle, so
   *  every completed swap leaves a stale 'at-risk' record that masks a genuinely stranded one on the next startup. */
  clearRecord?(swapId: string): void
  
  clearNeverSentLock?(hashHex: string, reason: string): void
  now?(): number
  /** Millisecond wall clock for the Base lock landing deadline (separate from SettlementSession's seconds clock). */
  nowMs?(): number
  sleep?(ms: number): Promise<void>
  log?(tag: string, msg: string): void
  /** Restock-only signer arbitration: acquire reveal before the irreversible write-ahead and BSV broadcast. */
  acquireRevealSide?(hashHex: string): Promise<void>
}
const MAX_SAFE_SATS = BigInt(Number.MAX_SAFE_INTEGER)

/** Reject an untrusted settlement reply before it can cause an EVM or BSV action. */
function validateResponderQuote(quote: BridgeQuote): void {
  const fail = (): never => { throw new Error('market maker settlement reply has missing or invalid fields; nothing was locked') }
  if (typeof quote.responderEvmAddr !== 'string' || !isAddress(quote.responderEvmAddr) || /^0x0{40}$/i.test(quote.responderEvmAddr)) fail()
  if (typeof quote.responderBsvPubKeyHex !== 'string' || !/^(?:02|03)[0-9a-fA-F]{64}$/.test(quote.responderBsvPubKeyHex) || typeof quote.responderBsvAddress !== 'string') fail()
  try {
    if (PublicKey.fromString(quote.responderBsvPubKeyHex).toAddress().toString() !== quote.responderBsvAddress) fail()
  } catch { fail() }
}

// The BSV claim reveals the secret — the money-critical broadcast. Anvil is an SPV node with no UTXO set: it verifies
// the spend from the lock's merkle proof carried in a BEEF, and REJECTS a bare tx (HTTP 422, BEEF parse-fail at byte 0;
// block. The reveal-safety gate is re-read from a FRESH BSV height before every attempt, so the retry/backoff window
// cannot carry a once-safe claim past its margin. `revealed` + the exact raw claim are persisted write-ahead before
// broadcast; an all-fail/ambiguous attempt therefore remains claim-recoverable and never becomes Base-refundable.
// LEVER-B HIGH-2: the max responder-set claim-fee budget the taker accepts, as a multiple of its OWN sized estimate.
// 4× covers a genuine fee-rate divergence / spike between the parties while still bounding the covenant's forced-payout
// skim to a real-fee scale (a few thousand sats vs the millions in htlcSats).
const MAX_QUOTE_FEE_BUDGET_HEADROOM = 4
const CLAIM_BROADCAST_ATTEMPTS = 6
const CLAIM_BROADCAST_BACKOFF_MS = 10_000
// LEVER B #3 (B#4): the absolute backstop on the initiator's 0-conf cap. Even a fat-fingered `zeroConfCapUsd` env can
// never enable a 0-conf reveal above this — it mirrors the responder's `DEFAULT_SAFETY_CONFIG.zeroConfHardCeilingUsd`
// ($35). Enforced fail-closed at construction (a mis-set cap refuses to START rather than 0-conf a larger swap).
export const ZEROCONF_HARD_CEILING_USD = 35

/** Build the SettlementParams both sessions agree on (identical to the responder's — describes the swap). */
function paramsFrom(intent: BridgeIntent, quote: BridgeQuote, decimals: number, cfg: BridgeInitiatorConfig, now: number): SettlementParams {
  return {
    hashHex: intent.hashHex,
    amountUsdc: intent.usdcAmount,
    amountBsvSats: intent.bsvAmount,
    quoteRef: 'convert-initiator',
    baseRefundTs: now + 12 * 3600,
    bsvRefundTs: now + 6 * 3600,
    claimBudgetBaseSecs: 2 * 3600,
    baseTimelockBlock: intent.baseTimelockBlock,
    bsvRefundLocktime: intent.bsvRefundLocktime,
    claimBudgetBaseBlocks: cfg.claimBudgetBaseBlocks ?? DEFAULT_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS,
    bsvClaimPubKeyHex: intent.machineBsvPubKeyHex, // the initiator claims BSV
    bsvRefundPubKeyHex: quote.responderBsvPubKeyHex, // 2-of-2 refund {initiator, responder}
    baseChainId: intent.baseChainId,
    erc20SwapAddress: intent.erc20SwapAddress,
    usdcTokenAddress: intent.usdcTokenAddress,
    usdcDecimals: decimals,
    baseClaimAddress: quote.responderEvmAddr, // the responder claims USDC
    baseRefundAddress: intent.machineEvmAddr, // the initiator refunds USDC
    capUsdPerSwap: cfg.capUsdPerSwap ?? 50,
    zeroConfCapUsd: cfg.zeroConfCapUsd ?? 0, // review 578efb16 LOW: default 0 (0-conf DISABLED) — the recorded cap must
    // match the executor runtime (which also defaults 0), else a persisted record misreports the 0-conf posture.
    
    // then verifies the on-chain lock matches, so a lying quote fails-closed). No per-leg local-config divergence.
    htlcKind: quote.htlcKind,
    bsvClaimFeeBudgetSats: quote.bsvClaimFeeBudgetSats,
    bsvRefundFeeBudgetSats: quote.bsvRefundFeeBudgetSats,
  }
}

/**
 * Build the initiator executor. `execute(spec)` runs the deliver-USDC/claim-BSV swap end-to-end and returns
 * `{ ok:true, baseLockTxid, bsvClaimTxid }` on a completed claim, or `{ ok:false, reason, baseLockTxid }` if
 * the responder never locked BSV / a guard refused — in which case the locked USDC is watchtower-recoverable.
 */
export function makeBridgeInitiatorExecutor(deps: BridgeInitiatorDeps): {
  execute(spec: BridgeDeliverErc20Spec): Promise<BridgeInitiatorResult>
} {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const nowMs = deps.nowMs ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = deps.log ?? (() => {})
  const { bsvReservePub, evm, bsv, coordinator: coord, config: cfg } = deps
  const bsvPub = bsvReservePub
  const recoveryHeight = (): Promise<number> => bsv.readBsvHeight ? bsv.readBsvHeight('recovery') : bsv.chainHeight()
  const confs = cfg.bsvConfirmations ?? 1
  // The claim recovery record pins the burial bar in force at first broadcast. One confirmation matches the
  // watchtower refund default and the executor's existing claim-burial success condition.
  const claimConfs = 1
  // A proof discovery source can index a newly-mined block a few seconds before the independent header source does.
  // Keep this state per executor so a prolonged header lag emits one useful line per proof height, not one per poll.
  const headerLagLoggedAt = new Set<number>()
  const verifyMerkleProof = async (txid: string, mp: MerklePath, label: string): Promise<'valid' | 'header-behind' | 'invalid'> => {
    let verifyError: unknown
    try {
      if (await mp.verify(txid, deps.chainTracker!)) return 'valid'
    } catch (e) {
      verifyError = e
    }
    let tip: number | undefined
    try {
      tip = await deps.chainTracker!.currentHeight()
    } catch {
      // A failed tip read cannot distinguish a bad proof from a just-not-yet-known header. The caller's existing
      // bounded retry/window remains the fail-closed decision point.
    }
    if (tip === undefined || tip < mp.blockHeight) {
      if (!headerLagLoggedAt.has(mp.blockHeight)) {
        headerLagLoggedAt.add(mp.blockHeight)
        log('bsv', `${label}: header source is behind proof block ${mp.blockHeight}${tip === undefined ? ' (tip unavailable)' : ` (tip ${tip})`} — waiting to verify`)
      }
      return 'header-behind'
    }
    if (verifyError !== undefined) throw verifyError
    return 'invalid'
  }

  // Fail-closed (review 609bd7b2): the timelock deltas + confirmation target must be positive integers.
  // A zero/negative baseTimelockBlocks makes the USDC lock instantly "refundable" (a nonsensical timelock);
  // a non-positive bsvRefundBlocks collapses the reveal window; confs < 1 would reveal against an
  // unconfirmed BSV lock (a double-spend loss). Same fail-open class as the responder's baseFinality≤0 guard.
  const posInt = (n: number): boolean => Number.isInteger(n) && n >= 1
  if (!posInt(cfg.baseTimelockBlocks)) throw new Error(`initiator-executor: baseTimelockBlocks must be a positive integer ≥ 1 (got ${cfg.baseTimelockBlocks})`)
  if (!posInt(cfg.bsvRefundBlocks)) throw new Error(`initiator-executor: bsvRefundBlocks must be a positive integer ≥ 1 (got ${cfg.bsvRefundBlocks})`)
  if (!posInt(confs)) throw new Error(`initiator-executor: bsvConfirmations must be a positive integer ≥ 1 (got ${confs})`)
  const lockLandDeadlineMs = cfg.lockLandDeadlineMs ?? DEFAULT_EVM_LOCK_LAND_DEADLINE_MS
  if (!Number.isSafeInteger(lockLandDeadlineMs) || lockLandDeadlineMs < 1_000 || lockLandDeadlineMs > 600_000) {
    throw new Error(`initiator-executor: lockLandDeadlineMs must be a safe integer in [1000, 600000] (got ${String(lockLandDeadlineMs)})`)
  }
  // LEVER B #1: a runner that DEMANDS the SPV gate must be wired for it — fail at construction, not mid-swap after the
  // USDC is already locked. requireLockMerkleProof ⇒ both a ChainTracker (the header root-of-trust) and a fetchBeef rail
  // (to obtain the proof) must be present.
  if (cfg.requireLockMerkleProof && (!deps.chainTracker || typeof bsv.fetchBeef !== 'function')) {
    throw new Error('initiator-executor: requireLockMerkleProof is set but no chainTracker dep and/or fetchBeef rail is wired — refusing to run without the SPV lock-proof gate')
  }
  // LEVER B #1 (review 85decdb MED): the proof-fetch knobs govern the post-USDC-lock retry loop — a bad value can't
  // steal funds but can fail EVERY swap after the lock (or, negative/NaN, spin) → capital stranded for the watchtower.
  // Validate like the other money-path timing knobs (fail-closed at construction, not mid-swap). Undefined ⇒ defaults.
  if (cfg.lockProofMaxTries !== undefined && !posInt(cfg.lockProofMaxTries)) throw new Error(`initiator-executor: lockProofMaxTries must be a positive integer ≥ 1 (got ${cfg.lockProofMaxTries})`)
  if (cfg.lockProofRetryMs !== undefined && !posInt(cfg.lockProofRetryMs)) throw new Error(`initiator-executor: lockProofRetryMs must be a positive integer ≥ 1 (got ${cfg.lockProofRetryMs})`)
  // Capped: an interval past setTimeout's 2^31-1 ms limit collapses to 1 ms, and an unbounded try count would then
  // hammer the discovery source while our USDC is locked.
  if (cfg.lockTxFetchMaxTries !== undefined && !(Number.isSafeInteger(cfg.lockTxFetchMaxTries) && cfg.lockTxFetchMaxTries >= 1 && cfg.lockTxFetchMaxTries <= 1_000)) {
    throw new Error(`initiator-executor: lockTxFetchMaxTries must be an integer in [1, 1000] (got ${cfg.lockTxFetchMaxTries})`)
  }
  if (cfg.lockTxFetchRetryMs !== undefined && !(Number.isSafeInteger(cfg.lockTxFetchRetryMs) && cfg.lockTxFetchRetryMs >= 1 && cfg.lockTxFetchRetryMs <= 60_000)) {
    throw new Error(`initiator-executor: lockTxFetchRetryMs must be an integer in [1, 60000] (got ${cfg.lockTxFetchRetryMs})`)
  }
  // LEVER B #3: enabling 0-conf (zeroConfCapUsd > 0) is a money-safety decision — the swap reveals against an
  // UNCONFIRMED lock, so it MUST have the ARC double-spend rail + sane watch knobs. Fail-closed at construction (never
  // discover a missing DS monitor on the first sub-cap swap, AFTER the USDC is locked).
  const zeroConfCap = cfg.zeroConfCapUsd ?? 0
  if (!(Number.isFinite(zeroConfCap) && zeroConfCap >= 0)) throw new Error(`initiator-executor: zeroConfCapUsd must be a finite number ≥ 0 (got ${cfg.zeroConfCapUsd})`)
  if (zeroConfCap > ZEROCONF_HARD_CEILING_USD) throw new Error(`initiator-executor: zeroConfCapUsd=${zeroConfCap} exceeds the 0-conf hard ceiling $${ZEROCONF_HARD_CEILING_USD} — refusing (a fat-fingered cap must never enable 0-conf above the ceiling; keep it ≤ $${ZEROCONF_HARD_CEILING_USD})`)
  if (zeroConfCap > 0) {
    if (typeof deps.zeroConfStatus !== 'function') throw new Error('initiator-executor: zeroConfCapUsd > 0 (0-conf enabled) but no zeroConfStatus (ARC tx-status rail) is wired — refusing to run the 0-conf reveal without the double-spend monitor')
    // Seam 4a (full pilot): a ≥2 quorum is UNSATISFIABLE on the single rail (it can only ever surface Anvil), so
    // minArc≥2 REQUIRES the multi-provider ARC rail — fail-closed at construction, never a silently-unmeetable gate.
    if ((cfg.zeroConfMinArcProviders ?? 1) >= 2 && typeof deps.zeroConfArcStatuses !== 'function') throw new Error(`initiator-executor: zeroConfMinArcProviders=${cfg.zeroConfMinArcProviders} (≥2) but no zeroConfArcStatuses (multi-provider ARC rail) is wired — the single rail surfaces only one ARC vantage; refusing an unsatisfiable 0-conf quorum`)
    // LEVER B #2 (Boltz confirmed-inputs): the 0-conf gate verifies the lock's INPUTS are mined + merkle-proven (so
    // only the lock tx itself can be replaced) using the ChainTracker + fetchBeef — and reuses those parent proofs to
    // build a complete claim BEEF the SPV node accepts. Both are MANDATORY for 0-conf (fail-closed at construction).
    if (!deps.chainTracker) throw new Error('initiator-executor: zeroConfCapUsd > 0 (0-conf enabled) but no chainTracker — refusing 0-conf without the confirmed-inputs (Boltz) merkle gate (LEVER B #2)')
    if (typeof bsv.fetchBeef !== 'function') throw new Error('initiator-executor: zeroConfCapUsd > 0 (0-conf enabled) but no fetchBeef rail — cannot obtain the lock inputs’ proofs for the confirmed-inputs gate (LEVER B #2)')
    // COUNT knobs must be integers ≥ 1 (a 0/negative poll count would skip the watch or spin); the SLEEP gap may be ≥ 0.
    for (const [k, v] of [['zeroConfPolls', cfg.zeroConfPolls], ['zeroConfClaimMaxPolls', cfg.zeroConfClaimMaxPolls], ['zeroConfClaimMaxBlocks', cfg.zeroConfClaimMaxBlocks], ['zeroConfMinArcProviders', cfg.zeroConfMinArcProviders]] as [string, number | undefined][]) {
      if (v !== undefined && !posInt(v)) throw new Error(`initiator-executor: ${k} must be a positive integer ≥ 1 (got ${v})`)
    }
    if (cfg.zeroConfSleepMs !== undefined && !(Number.isFinite(cfg.zeroConfSleepMs) && cfg.zeroConfSleepMs >= 0)) throw new Error(`initiator-executor: zeroConfSleepMs must be a finite number ≥ 0 (got ${cfg.zeroConfSleepMs})`)
  }

  return {
    async execute(spec: BridgeDeliverErc20Spec): Promise<BridgeInitiatorResult> {
      // Bounds: fail-closed on absurd amounts before any negotiation.
      if (spec.deliverAmount < 1n) return { ok: false, reason: `deliverAmount ${spec.deliverAmount} must be >= 1` }
      if (spec.receiveBsvSats < 1n || spec.receiveBsvSats > MAX_SAFE_SATS) return { ok: false, reason: `receiveBsvSats ${spec.receiveBsvSats} out of range` }

      let baseLockTxid: string | undefined
      // doc 25 change D: the swap's EVM preimageHash (0x-prefixed), surfaced in the result so a signer-routed caller
      // can release the signer's per-swap EVM binding at completion (review 220d1ef7 MED). Set right after step 2
      // generates the secret/hashlock; stays undefined if the swap never gets that far (nothing to release).
      let evmPreimageHash: `0x${string}` | undefined
      // Set at the durable write-ahead point before the first BSV claim attempt. From then on the raw claim may have
      // escaped, so every failure result carries it and no caller can mistake an ambiguous attempt for a refund path.
      let durableClaimTxid: string | undefined
      try {
        // 1. Allowlist + LIVE decimals cross-check on the token we're about to lock (fail-closed).
        const token = await assertTokenAllowedAndDecimals(cfg.baseChainId, spec.erc20TokenAddress, (a) => evm.tokenDecimals(a), true) // LEVER-B HIGH-1: bridge = $1-pegged only
        log('nego', `delivering ${token.symbol} (${token.decimals}dp) — allowlisted + on-chain decimals verified ✅`)

        // 2. Fresh per-swap secret (we HOLD it until reveal) + hashlock binding both legs.
        const { secret, hashHex } = newHtlcSecret()
        await deps.onHashlockCreated?.(hashHex)
        const H = preimageHashOf(secret)
        evmPreimageHash = H // doc 25 change D: surfaced in the result once known

        // 3. On-chain timelock heights (block-native, both legs) from the negotiated deltas.
        const baseNow = Number(await evm.currentBlockNumber())
        const bsvNow = await bsv.chainHeight()
        const intent: BridgeIntent = {
          hashHex,
          usdcAmount: spec.deliverAmount.toString(),
          bsvAmount: Number(spec.receiveBsvSats),
          baseTimelockBlock: baseNow + cfg.baseTimelockBlocks,
          bsvRefundLocktime: bsvNow + cfg.bsvRefundBlocks,
          machineEvmAddr: evm.address() as `0x${string}`,
          machineBsvPubKeyHex: bsvPub.toString(),
          erc20SwapAddress: cfg.erc20SwapAddress,
          usdcTokenAddress: spec.erc20TokenAddress,
          baseChainId: cfg.baseChainId,
        }

        // 4. Publish the intent; receive the responder's bridge addresses; build the initiator session.
        await coord.sendIntent(intent)
        const quote = await coord.recvQuote()
        validateResponderQuote(quote)
        // COVENANT-ONLY (Step E): the taker refuses any non-covenant quote. The responder's BSV refund is MM-alone +
        // committed in-script (no 2-of-2 round-trip), so a legacy/undefined quote can never originate a swap here.
        if (quote.htlcKind !== 'covenant') throw new Error(`initiator-executor is COVENANT-ONLY — quote.htlcKind=${quote.htlcKind ?? 'legacy(default)'} refused (Step E)`)
        // LEVER-B HIGH-2 (red-team 2026-09-04, symmetric floor added by the 2026-09-05 re-red-team): the covenant claim
        // FORCES output[0] = htlcSats - bsvClaimFeeBudgetSats to the taker and returns the unused budget as the taker's
        // own tip at output[1]. The responder SETS bsvClaimFeeBudgetSats in the quote, and it is committed in the script
        // both legs verify — so the taker must BOUND it on BOTH sides BEFORE it locks USDC:
        //   • UPPER (≤ 4× the taker's sized estimate): a budget ≈ htlcSats shrinks the forced payout to dust — the taker
        //     gets ~1 sat for its USDC. (The unused budget returns as the output[1] tip, so a budget within band costs
        //     the taker nothing; only a bloated one eats the principal.)
        //   • LOWER (≥ the taker's OWN sized claim fee): the mirror hole the first fold missed. A budget BELOW the
        //     taker's real claim fee forces the taker to reveal `s` in an UNDER-FEE'D claim (the SDK collapses output[1]
        //     into the fee, e.g. 1 sat total) that may never confirm before T_bsv — then the responder claims the USDC
        //     with the now-public `s` and, after T_bsv, also refunds the BSV → the taker loses BOTH legs. Flooring at the
        //     sized budget (which the honest responder sends by default, and which carries the designed headroom over the
        //     ~real fee) guarantees the committed budget can always pay a claim fee at cfg.bsvFeeRate.
        // Fail-closed (refuse) on EITHER side. The honest default sits exactly at the floor (both = 1000 at pilot rates).
        const quoteClaimBudget = quote.bsvClaimFeeBudgetSats ?? DEFAULT_COVENANT_FEE_BUDGET_SATS
        const sizedClaimBudget = sizeCovenantFeeBudgetSats(cfg.bsvFeeRate)
        const maxClaimBudget = sizedClaimBudget * MAX_QUOTE_FEE_BUDGET_HEADROOM
        if (!Number.isInteger(quoteClaimBudget) || quoteClaimBudget < sizedClaimBudget || quoteClaimBudget > maxClaimBudget) {
          throw new Error(`quote bsvClaimFeeBudgetSats=${quoteClaimBudget} outside [${sizedClaimBudget}, ${maxClaimBudget}] (the taker's own sized claim fee … ${MAX_QUOTE_FEE_BUDGET_HEADROOM}× it) — refusing: a budget BELOW the floor starves the covenant claim (it may never confirm before T_bsv → both-leg loss); ABOVE the ceiling shrinks the FORCED payout to the taker (LEVER-B HIGH-2, symmetric bound)`)
        }
        const session = SettlementSession.create(paramsFrom(intent, quote, token.decimals, cfg, now()), 'initiator', now())
        session.holdSecret(Utils.toHex(secret))

        // 5. Lock USDC on Base (approve → wait allowance → lock).
        const evmParams: Erc20SwapParams = {
          preimageHash: H,
          amount: spec.deliverAmount,
          tokenAddress: spec.erc20TokenAddress,
          claimAddress: quote.responderEvmAddr,
          refundAddress: evm.address() as `0x${string}`,
          timelock: BigInt(intent.baseTimelockBlock),
        }
        if (!cfg.approveOnlyBelowAllowance || (await evm.allowance(spec.erc20TokenAddress)) < spec.deliverAmount) {
          const approval = await evm.approve(spec.erc20TokenAddress, spec.deliverAmount)
          if (approval.status === 'reverted') throw new Error(`USDC approve reverted (${approval.hash})`)
          if (approval.status === 'pending') log('evm', `USDC approve outcome pending (${approval.hash.slice(0, 12)}…) — waiting for allowance propagation`)
          for (let i = 0; (await evm.allowance(spec.erc20TokenAddress)) < spec.deliverAmount; i++) {
            if (i > 20) throw new Error('allowance did not propagate')
            await sleep(3000)
          }
        }
        // review fde1afe HIGH (M-1 redone): observe 'base-locked' with a PLACEHOLDER txHash BEFORE evm.lock() returns —
        // so a crash during its receipt-wait leaves an ACTIONABLE 'base-locked' record. (The earlier fix persisted a
        // 'created' record, which the watchtower treats as idle/nothing-locked → it never refunded it.) The Base refund
        // is PARAMS-keyed (baseRefundParamsFromRecord — NOT the txHash), so the placeholder is irrelevant to recovery;
        // if the lock never lands, the refund simply reverts on-chain (harmless — the params match no swap). On a clean
        // settle the record is cleared (M-4). The real txid goes to the responder via sendBaseLocked below + the logs.
        const observed: ObservedBaseLock = {
          txHash: `0x${'0'.repeat(64)}`, logIndex: -1, preimageHash: H, amount: spec.deliverAmount,
          tokenAddress: spec.erc20TokenAddress, claimAddress: quote.responderEvmAddr, refundAddress: evm.address(),
          timelock: BigInt(intent.baseTimelockBlock), contractAddress: cfg.erc20SwapAddress, chainId: cfg.baseChainId, blockNumber: 0,
        }
        session.observeBaseLock(observed, now())
        // Presence, even while empty, is a capability marker: this kit records every locally signed lock before it
        // broadcasts. Older records omit the field and need the conservative nonce-burn recovery path.
        if (cfg.recordLockAttempts) session.beginBaseLockAttempts()
        deps.persist?.(session.toRecord()) // ACTIONABLE at-risk record BEFORE the lock lands → the watchtower refunds at the timelock
        const lockDeadlineAt = nowMs() + lockLandDeadlineMs
        let lockAttemptRecorded = false
        const recordLockAttempt = cfg.recordLockAttempts ? async (attempt: LockAttempt): Promise<void> => {
          lockAttemptRecorded = true // first: a failed persist below must never read as "never sent"
          session.noteBaseLockAttempt({ txHash: attempt.hash, nonce: attempt.nonce })
          deps.persist?.(session.toRecord())
        } : undefined
        // The buyer's rails record every signed lock before broadcasting it, so a lock call that failed before any
        // attempt was recorded sent nothing and nothing can land (e.g. a write-boundary safety refusal once a covered
        // allowance skips the approve). Clear the placeholder rather than block the kit until the timelock.
        const lockOnce = async (): Promise<SentTx> => {
          try {
            return await evm.lock(evmParams, undefined, recordLockAttempt)
          } catch (error) {
            if (!recordLockAttempt || lockAttemptRecorded || !deps.clearNeverSentLock) throw error
            const cause = error instanceof Error ? error.message : String(error)
            deps.clearNeverSentLock(hashHex, `the USDC lock was never sent (${cause}); nothing was locked`)
            throw new Error(`USDC lock not sent (${cause}) — cleared the pre-lock record (nothing locked)`)
          }
        }
        let lk = await lockOnce()
        while (lk.status === 'pending' && nowMs() < lockDeadlineAt) {
          const remaining = lockDeadlineAt - nowMs()
          await sleep(Math.min(EVM_LOCK_LAND_POLL_MS, Math.max(1, remaining)))
          if (nowMs() >= lockDeadlineAt) break
          lk = await lockOnce()
        }
        // A REVERTED receipt may be a duplicate of this lock while an earlier broadcast holds the USDC. Clear the
        // pre-lock record ONLY on a confirmed false for the exact tuple AT the reverted receipt's block (a lagging
        // node's latest could still say absent). No block, a true, or any read error keeps the record.
        if (lk.status === 'reverted') {
          const kept = (why: string): Error => {
            deps.persist?.(session.toRecord())
            return new Error(`USDC lock reverted (${lk.hash}) ${why}; record kept, the watchtower refunds at the timelock`)
          }
          if (!lk.blockNumber || lk.blockNumber <= 0n) throw kept('without a receipt block to check the tuple at')
          let locked: boolean
          try { locked = await evm.isSwapLocked(evmParams, { blockNumber: lk.blockNumber }) }
          catch (error) { throw kept(`and the tuple check at block ${lk.blockNumber} failed (${error instanceof Error ? error.message : String(error)})`) }
          if (locked) throw kept('but the exact tuple is locked on-chain — an earlier broadcast landed')
          deps.clearRecord?.(hashHex)
          throw new Error(`USDC lock reverted (${lk.hash}) — cleared the pre-lock record (nothing locked)`)
        }
        if (lk.status === 'pending') {
          deps.persist?.(session.toRecord())
          throw new Error(`USDC lock outcome unknown (${lk.hash}) — record kept; the watchtower refunds at the timelock if it landed`)
        }
        baseLockTxid = lk.hash
        session.noteBaseLockLanded(lk.hash, Number(lk.blockNumber ?? 0)) // MED (review 4576b3): record the REAL txid/block (the pre-lock observe used a placeholder)
        deps.persist?.(session.toRecord()) // re-persist post-lock with the real txid/block (state unchanged; refund is params-keyed)
        await coord.sendBaseLocked({ txHash: lk.hash as `0x${string}`, blockNumber: Number(lk.blockNumber ?? 0) })
        log('evm', `USDC LOCKED ${lk.hash.slice(0, 12)}… — recoverable at Base block ${intent.baseTimelockBlock}`)

        // 6. The expected on-chain BSV HTLC script — rebuilt from the SESSION (covenant: forced payout→taker on the
        //    secret reveal, refund→MM@T_bsv committed in-script). COVENANT-ONLY (Step E): there is NO refund round-trip
        //    — the taker signs NOTHING; the responder's refund is MM-alone (HIGH#1). Used below to bind the responder's
        //    advertised + on-chain BSV lock to the negotiated hashlock/keys before revealing.
        const expectScript = session.bsvHtlcScriptHex()

        // 7. Observe the responder's BSV lock, then VERIFY IT ON-CHAIN before touching the secret (review 772f17b8
        //    HIGH). A `bsv-locked` MESSAGE + a confirmed txid are NOT proof: a lying/buggy responder could name any
        //    confirmed txid with the right advertised script. We FETCH the named tx and prove vout 0 is EXACTLY the
        //    negotiated HTLC (our claim key + amount) BEFORE building/broadcasting a claim that reveals `s` — else we
        //    could leak `s` against a non-existent output (a broadcaster/relay echoing the claim), letting the
        //    responder claim our USDC for nothing, or strand our USDC until the Base refund.
        const bsvLocked = await coord.recvBsvLocked()
        // The responder's HTLC must pay OUR claim key (else the claim we build can't spend it). Fail-closed.
        // (expectScript was computed + used to bind the refund skeleton in step 6.)
        if (bsvLocked.htlcScriptHex !== expectScript) throw new Error("responder's BSV HTLC script does not match the negotiated hashlock/keys")
        // The responder announces the lock the moment it broadcasts it; the discovery source can lag the mempool or
        // throttle for seconds (2026-09-27 D1c: a real, later-mined lock missed on the one immediate fetch). A miss or a
        // fetch error is therefore re-checked for a bounded window; everything below still verifies what is fetched.
        const fetchTries = cfg.lockTxFetchMaxTries ?? 40
        const fetchRetryMs = cfg.lockTxFetchRetryMs ?? 3_000
        let lockTx: Transaction | null = null
        let lastFetchError = ''
        for (let i = 0; i < fetchTries && !lockTx; i++) {
          if (i > 0) {
            if (i === 1) log('bsv', `responder's BSV lock ${bsvLocked.bsvLockTxid.slice(0, 12)}… not visible yet — re-checking every ${fetchRetryMs}ms (up to ${fetchTries} tries)…`)
            await sleep(fetchRetryMs)
          }
          lockTx = await bsv.fetchTx(bsvLocked.bsvLockTxid).catch((e: unknown) => { lastFetchError = e instanceof Error ? e.message : String(e); return null })
        }
        if (!lockTx) throw new Error(`responder's BSV lock tx ${bsvLocked.bsvLockTxid} not found on-chain after ${fetchTries} tries${lastFetchError ? ` (last error: ${lastFetchError})` : ''} — refusing to reveal`)
        if (lockTx.id('hex') !== bsvLocked.bsvLockTxid) throw new Error(`fetched tx id ${lockTx.id('hex')} ≠ named BSV lock ${bsvLocked.bsvLockTxid} — refusing to reveal`)
        const out0 = lockTx.outputs[0]
        if (!out0) throw new Error(`BSV lock ${bsvLocked.bsvLockTxid} has no output 0 — refusing to reveal`)
        if (out0.lockingScript?.toHex() !== expectScript) throw new Error(`BSV lock ${bsvLocked.bsvLockTxid} vout 0 script ≠ the negotiated HTLC — refusing to reveal`)
        if (out0.satoshis !== Number(spec.receiveBsvSats)) throw new Error(`BSV lock ${bsvLocked.bsvLockTxid} vout 0 = ${String(out0.satoshis)} sat ≠ negotiated ${Number(spec.receiveBsvSats)} — refusing to reveal`)
        // The claim spends the VERIFIED on-chain outpoint (its proven script + satoshis), never the advertised values.
        const htlc: BsvHtlcUtxo = { txid: bsvLocked.bsvLockTxid, vout: 0, satoshis: out0.satoshis, scriptHex: expectScript }
        session.observeBsvLock({ outpoint: `${bsvLocked.bsvLockTxid}_0` }, now())
        
        // (reveal against an UNCONFIRMED lock, gated by the ARC double-spend monitor); everything else waits ≥1 conf +
        // SPV-verifies (B#1). zeroConfCap=0 ⇒ ALWAYS the confirmed path — the current safe posture (0-conf DORMANT).
        const amountUsd = Number(spec.deliverAmount) / 10 ** token.decimals
        const zeroConfEligible = zeroConfCap > 0 && Number.isFinite(amountUsd) && amountUsd > 0 && amountUsd <= zeroConfCap
        // This may switch to false when an otherwise-safe 0-conf gate cannot decide. Keep it separate from
        // eligibility: the latter is the amount policy, while this controls the path actually taken below.
        let useZeroConfFastPath = zeroConfEligible
        const confirmLockAndVerify = async (): Promise<void> => {
          for (let i = 0; ; i++) {
            // A lock that never confirms must not strand this executor (or its restock tick) indefinitely. The same
            // reveal runway applies before every confirmation poll, whether this is the direct confirmed path or a
            // 0-conf fallback.
            const waitGate = session.guardInitiatorCanReveal(await bsv.chainHeight())
            if (!waitGate.ok) throw new Error(`confirmed-path lock wait stopped: reveal gate refused: ${waitGate.reason}`)
            if ((await bsv.txConfirmations(bsvLocked.bsvLockTxid)) >= confs) break
            log('bsv', `waiting BSV lock conf ${i + 1}/${confs}…`)
            await sleep(15_000)
          }
          
          //     above is a TRUSTED rail read; this replaces "the rail says N confs" with "a merkle path to a block header
          //     whose PoW my ChainTracker validated" — a lying/compromised discovery source cannot forge that (the exact
          //     token-leg gate, BSV21 provenance MerklePath.verify). Runs whenever a ChainTracker is wired; MANDATORY under
          //     requireLockMerkleProof. Fail-closed: an absent/invalid proof ⇒ never reveal (USDC stays refund-eligible).
          if (deps.chainTracker) {
            if (typeof bsv.fetchBeef !== 'function') throw new Error('LEVER B #1: a chainTracker is wired but no fetchBeef rail — cannot obtain the lock proof; refusing to reveal')
            const maxTries = cfg.lockProofMaxTries ?? 10
            const retryMs = cfg.lockProofRetryMs ?? 3_000
            let proven = false
            for (let i = 0; i < maxTries && !proven; i++) {
              const beefTx = await bsv.fetchBeef(bsvLocked.bsvLockTxid).catch(() => null)
              const mp = beefTx?.merklePath
              if (mp) {
                // A valid path must be FOR this txid AND its root must sit under a header the ChainTracker accepts.
                const proof = await verifyMerkleProof(bsvLocked.bsvLockTxid, mp, `LEVER B #1: responder's BSV lock ${bsvLocked.bsvLockTxid}`)
                if (proof === 'invalid') {
                  throw new Error(`LEVER B #1: responder's BSV lock ${bsvLocked.bsvLockTxid} FAILED merkle-proof verification against the ChainTracker — refusing to reveal`)
                }
                if (proof === 'valid') {
                  proven = true
                  log('bsv', `SPV ✅ lock ${bsvLocked.bsvLockTxid.slice(0, 12)}… merkle-proof VERIFIED vs ChainTracker (block ${mp.blockHeight})`)
                } else if (i < maxTries - 1) {
                  await sleep(retryMs)
                }
              } else {
                log('bsv', `waiting for the lock's merkle proof to be servable (${i + 1}/${maxTries})…`)
                await sleep(retryMs)
              }
            }
            if (!proven) throw new Error(`LEVER B #1: no servable merkle proof for the responder's BSV lock ${bsvLocked.bsvLockTxid} after ${maxTries} tries — refusing to reveal (fail-closed)`)
          }
        }
        const fallBackToConfirmedPath = (reason: unknown): void => {
          const detail = reason instanceof Error ? reason.message : String(reason)
          log('bsv', `0-conf fallback: ${detail} — waiting for a confirmed BSV lock instead`)
          useZeroConfFastPath = false
        }
        if (useZeroConfFastPath) {
          // §12.11 pre-reveal gate: the lock must be ARC-ACCEPTED with NO double-spend across the whole watch. A
          // DOUBLE_SPEND_ATTEMPTED / REJECTED / orphan signal (from ANY provider) or a transport error ABORTS BEFORE the
          // reveal (fail-closed — USDC stays watchtower-refundable). A non-ARC "seen" downgrades to unknown, so a WoC
          // fallback can't fake safety. (deps.zeroConfStatus is guaranteed present — construction requires it when cap>0.)
          const minArc = cfg.zeroConfMinArcProviders ?? 1
          const zcOpts = { polls: cfg.zeroConfPolls ?? 4, sleepMs: cfg.zeroConfSleepMs ?? 5_000, sleep }
          // minArc≥2 ⇒ the MULTI-ARC QUORUM gate (seam 4a): each poll queries EVERY configured ARC provider and the
          // clear requires ≥minArc DISTINCT ARC providers to ACCEPT on the final poll (construction guarantees the
          // rail). minArc=1 ⇒ the mainnet-proven single-provider gate. EITHER aborts on any DS witness across the watch.
          // monitorZeroConf deliberately wraps source errors, so preserve the DS distinction with an out-of-band flag
          // set from each structured provider report. This never infers a double-spend from an error message.
          let zeroConfDoubleSpendObserved = false
          const trackSingleStatus: FetchTxStatus = async (txid) => {
            const report = await deps.zeroConfStatus!(txid)
            if (classifyArcStatus(report.status, report.provider) === 'double-spend') zeroConfDoubleSpendObserved = true
            return report
          }
          const trackMultiStatuses: FetchArcStatuses = async (txid) => {
            const reports = await deps.zeroConfArcStatuses!(txid)
            if (classifyMultiArc(reports, minArc) === 'double-spend') zeroConfDoubleSpendObserved = true
            return reports
          }
          try {
            const cov = minArc >= 2
              ? await assertLockSafeForZeroConfMultiArc(bsvLocked.bsvLockTxid, minArc, zcOpts, trackMultiStatuses)
              : await assertLockSafeForZeroConf(bsvLocked.bsvLockTxid, zcOpts, trackSingleStatus)
            // Belt: coverage must show ≥minArc DISTINCT ARC vantages. The multi gate already enforces an ACCEPT-quorum
            // (accepted ⇒ answered, so a met quorum always passes this); this also guards the minArc=1 path's ≥1-ARC floor.
            const arcSeen = [...cov.providers].filter((p) => ARC_PROVIDERS.has(p)).length
            if (arcSeen < minArc) throw new Error(`LEVER B #3: 0-conf clear witnessed by only ${arcSeen} ARC provider(s) < required ${minArc} (coverage ${coverageLabel(cov)}) — refusing to reveal`)
            log('bsv', `0-conf ✅ lock ${bsvLocked.bsvLockTxid.slice(0, 12)}… ARC-accepted, no double-spend (coverage ${coverageLabel(cov)}, $${amountUsd} ≤ $${zeroConfCap} cap)`)
            // LEVER B #2 (Boltz confirmed-inputs): the lock is UNMINED, so its safety hinges on its INPUTS being buried —
            // if every input is a mined, merkle-proven coin then ONLY the lock tx itself can be replaced, and BSV
            // first-seen (no RBF) + the DS monitor above fence that. Verify EACH lock input's parent has a valid merkle
            // proof against the ChainTracker (the exact B#1 gate, applied to the parents), and ATTACH the proven parent as
            // that input's sourceTransaction — so the SAME verified ancestry builds a complete claim BEEF the SPV node
            // accepts (no separate fetch, no trust). Fail-closed: a missing/invalid parent proof ⇒ refuse (an input that
            // is itself unconfirmed re-opens the inherited-ancestor RBF risk Boltz closes). chainTracker + fetchBeef are
            // guaranteed present (construction requires them when cap>0).
            for (let vin = 0; vin < lockTx.inputs.length; vin++) {
              const parentTxid = lockTx.inputs[vin].sourceTXID
              if (!parentTxid) throw new Error(`LEVER B #2: lock ${bsvLocked.bsvLockTxid} input ${vin} has no sourceTXID — cannot prove it spends a confirmed coin; refusing to reveal`)
              const maxTries = cfg.lockProofMaxTries ?? 10
              const retryMs = cfg.lockProofRetryMs ?? 3_000
              let parentProven = false
              for (let i = 0; i < maxTries && !parentProven; i++) {
                const parent: Transaction | null = await bsv.fetchBeef!(parentTxid).catch(() => null)
                const pmp = parent?.merklePath
                if (!parent || !pmp) throw new Error(`LEVER B #2: lock input ${vin} parent ${parentTxid} is not mined/servable (unconfirmed input) — refusing 0-conf reveal (Boltz confirmed-inputs)`)
                if (parent.id('hex') !== parentTxid) throw new Error(`LEVER B #2: fetched parent ${parent.id('hex')} ≠ requested ${parentTxid} — refusing to attach a mismatched ancestor`)
                const proof = await verifyMerkleProof(parentTxid, pmp, `LEVER B #2: lock input ${vin} parent ${parentTxid}`)
                if (proof === 'invalid') throw new Error(`LEVER B #2: lock input ${vin} parent ${parentTxid} FAILED merkle-proof verification against the ChainTracker — refusing to reveal`)
                if (proof === 'valid') {
                  lockTx.inputs[vin].sourceTransaction = parent // proven confirmed ancestry → completes the claim BEEF below
                  parentProven = true
                } else if (i < maxTries - 1) {
                  await sleep(retryMs)
                }
              }
              if (!parentProven) throw new Error(`LEVER B #2: lock input ${vin} parent ${parentTxid} header source did not catch up after ${maxTries} tries — refusing 0-conf reveal`)
            }
            log('bsv', `0-conf ✅ confirmed-inputs: all ${lockTx.inputs.length} lock input(s) mined + merkle-proven (Boltz — only the lock tx itself is replaceable)`)
          } catch (e) {
            if (zeroConfDoubleSpendObserved) throw new ZeroConfDoubleSpendSignal()
            fallBackToConfirmedPath(e)
          }
        }
        if (!useZeroConfFastPath) await confirmLockAndVerify()
        const gate = session.guardInitiatorCanReveal(await bsv.chainHeight())
        if (!gate.ok) throw new Error(`reveal gate refused: ${gate.reason}`)

        // 8. Reveal: claim the BSV (publishes `s` on-chain). The instant the claim BROADCASTS the swap is WON from our
        //    side — `s` is public, so the responder will claim our USDC; a Base REFUND of that USDC would now double-dip
        //    us AND short the responder. Before the claim broadcasts we advance to `revealed` and PERSIST its raw bytes:
        //    `revealed` record is NOT refund-eligible (evaluateWatch → 'reveal-seen'), so a crash OR a reveal-hint
        //    failure here can never resurface a Base-refund path. review 845a1252 HIGH: the tail previously `await`ed the
        //    hint BEFORE settling, so a hint throw fell to the catch → ok:false with the record still `base-locked` →
        //    surfaced as refundable + reported the buy FAILED even though the BSV was already taken. The reveal-hint is
        //    a BEST-EFFORT courtesy (the responder discovers `s` on-chain regardless) — it must never un-settle a claim.
        // COVENANT-ONLY (Step E): a forced-output claim (payout→taker, s revealed via `<preimage> <s> OP_1`). The
        // covenant terms MUST match the committed script (same htlcSats/addresses/fee budgets the session derived) or
        // the forced-output byte-compare rejects it — fail-closed.
        const covTerms: BridgeCovenantTerms = {
          hashHex, takerBsvAddress: bsvPub.toAddress(), mmBsvAddress: PublicKey.fromString(quote.responderBsvPubKeyHex).toAddress(),
          htlcSats: intent.bsvAmount, bsvRefundLocktime: intent.bsvRefundLocktime,
          
          claimFeeBudgetSats: quote.bsvClaimFeeBudgetSats ?? DEFAULT_COVENANT_FEE_BUDGET_SATS,
          refundFeeBudgetSats: quote.bsvRefundFeeBudgetSats ?? DEFAULT_COVENANT_FEE_BUDGET_SATS,
        }
        const claimTx: Transaction = await buildBridgeCovenantClaimTx({ covenant: { txid: htlc.txid, vout: htlc.vout, satoshis: htlc.satoshis, scriptHex: htlc.scriptHex }, secret, terms: covTerms, feeRate: cfg.bsvFeeRate })
        const claimTxid = claimTx.id('hex')
        // The claim input's prev-tx is a SURROGATE (output-only, no proof) as built. Anvil (SPV, no UTXO set) verifies a
        
        // lock tx (with its merkle path, from /tx/{txid}/beef) as the input's sourceTransaction and broadcast a SELF-
        // CONTAINED BEEF. The lock's vout 0 (script+sats) was verified above, so swapping the surrogate for the real tx
        // leaves the signature valid. /beef has proof-fetch latency after the block, so fetch INSIDE the retry. Idempotency:
        // a broadcast that errored on the RESPONSE but landed leaves the claim on-chain → fetchTx detects it. All-fail →
        // throw → {ok:false}, `s` never on-chain, USDC refund-eligible (845a1252). Legacy rails without fetchBeef send the
        // bare tx (rejected by an SPV node, accepted by non-SPV broadcasters).
        const htlcInIdx = claimTx.inputs.findIndex((i) => i.sourceTXID === bsvLocked.bsvLockTxid && i.sourceOutputIndex === 0)
        // LEVER B #3 (review 250d669 MED + red-team 2026-09-04): the pre-reveal DS watch + the B#2 parent-proof IO happen
        // BEFORE this irreversible broadcast, so their verdict is stale. FAIL-CLOSED freshness gate at the LAST moment,
        // re-run before EACH broadcast attempt: the lock must return a FRESH ARC 'accepted' — a double-spend OR the loss
        // of ARC-class visibility (unknown, e.g. our Anvil unreachable) BOTH abort before `s` is public (a self-abort is
        // strictly safer than revealing blind; the USDC stays watchtower-refundable). Mirrors the pre-reveal monitor's
        // discipline (monitorZeroConf requires a final 'accepted').
        const freshDsRecheckBeforeBroadcast = async (): Promise<void> => {
          if (!useZeroConfFastPath) return
          // CRITICAL (2026-09-10 red-team): the LAST pre-reveal DS recheck — the check gating the IRREVERSIBLE reveal
          // broadcast — must use the SAME minArc≥2 QUORUM as the pre-reveal gate. A single-vantage recheck here silently
          // reopens the exact single-provider blind spot the quorum feature closes, at the highest-stakes moment.
          const recheckMinArc = cfg.zeroConfMinArcProviders ?? 1
          try {
            if (recheckMinArc >= 2 && deps.zeroConfArcStatuses) {
              const reports = await deps.zeroConfArcStatuses(bsvLocked.bsvLockTxid)
              const verdict = classifyMultiArc(reports, recheckMinArc)
              if (verdict === 'double-spend') throw new ZeroConfDoubleSpendSignal()
              if (verdict !== 'accepted') {
                throw new Error(`LEVER B #3: pre-broadcast MULTI-ARC recheck did not return a fresh quorum 'accepted' (verdict ${verdict}, ${reports.length} provider(s), need ≥${recheckMinArc} distinct ARC accepts) — refusing to reveal (fail-closed on loss of ARC-class quorum)`)
              }
              log('bsv', `0-conf ✅ fresh multi-ARC quorum 'accepted' at broadcast (≥${recheckMinArc} distinct ARC providers)`)
              return
            }
            if (!deps.zeroConfStatus) return
            const fresh = await deps.zeroConfStatus(bsvLocked.bsvLockTxid)
            const verdict = classifyArcStatus(fresh.status, fresh.provider)
            if (verdict === 'double-spend') throw new ZeroConfDoubleSpendSignal()
            if (verdict !== 'accepted') {
              throw new Error(`LEVER B #3: pre-broadcast recheck did not return a fresh ARC 'accepted' (${fresh.provider}:${fresh.status} → ${verdict}) — refusing to reveal (fail-closed on loss of ARC-class visibility)`)
            }
            log('bsv', `0-conf ✅ fresh ARC 'accepted' at broadcast (${fresh.provider}:${fresh.status})`)
          } catch (e) {
            if (e instanceof ZeroConfDoubleSpendSignal) throw e
            fallBackToConfirmedPath(e)
            await confirmLockAndVerify()
            // The confirmation and proof waits can span blocks, and the retry gate above was read before them. Re-read
            // the runway before this attempt goes on to the reveal.
            const provenGate = session.guardInitiatorCanReveal(await bsv.chainHeight())
            if (!provenGate.ok) throw new Error(`reveal-safety margin expired while waiting for a confirmed lock: ${provenGate.reason}`)
          }
        }
        const claimRawHex = claimTx.toHex()
        let bsvClaimTxid: string | undefined
        // Keep an immutable pre-reveal gate subject. The live session becomes `revealed` at the write-ahead point
        // before the first broadcast, but every later retry must still re-evaluate the height margin.
        const preRevealSession = SettlementSession.fromRecord(session.toRecord())
        let revealSideAcquired = false
        for (let attempt = 1; attempt <= CLAIM_BROADCAST_ATTEMPTS; attempt++) {
          // HTLC-H1: retries/backoff can span new BSV blocks. The gate above protects entry into the reveal path, but
          // its height becomes stale while a broadcaster or /beef indexer is failing. Re-read the live height before
          // EVERY irreversible broadcast attempt and abort outside the retryable-error catch once the safety margin is
          // gone. In particular, never let the responder's at-maturity refund race a later claim carrying public `s`.
          const retryGate = preRevealSession.guardInitiatorCanReveal(await bsv.chainHeight())
          if (!retryGate.ok) {
            throw new Error(`reveal-safety margin expired mid-retry — aborting to avoid disclosing s past the safe window: ${retryGate.reason}`)
          }
          await freshDsRecheckBeforeBroadcast() // OUTSIDE the try: a DS/visibility-loss throw ABORTS, never a retryable broadcast error
          let revealIntentFailure = false
          try {
            let atomicBeefHex: string | undefined
            if (useZeroConfFastPath) {
              // LEVER B #3/#2: the 0-conf lock is UNMINED — no merkle proof exists (fetchBeef is mined-only → 404).
              // Attach the already-verified lock (its vout-0 script+sats checked above) as the claim input's ancestor.
              // B#2 already set the lock's OWN inputs' sourceTransactions to their PROVEN (mined) parents, so
              // `claimTx.toAtomicBEEF()` here emits a COMPLETE chain — claim → lock(unmined) → parents(merkle-proven) —
              // that the SPV node accepts (the proven parents anchor the ancestry; only the lock tx itself is unconfirmed).
              if (htlcInIdx >= 0) claimTx.inputs[htlcInIdx].sourceTransaction = lockTx
              atomicBeefHex = Utils.toHex(claimTx.toAtomicBEEF())
            } else if (bsv.fetchBeef) {
              const lockWithProof = await bsv.fetchBeef(bsvLocked.bsvLockTxid)
              if (!lockWithProof || lockWithProof.id('hex') !== bsvLocked.bsvLockTxid) throw new Error(`lock merkle proof (BEEF) not yet servable for ${bsvLocked.bsvLockTxid}`)
              if (htlcInIdx >= 0) claimTx.inputs[htlcInIdx].sourceTransaction = lockWithProof
              atomicBeefHex = Utils.toHex(claimTx.toAtomicBEEF())
            }
            // The signer decision is deliberately taken at the write-ahead boundary, not at entry to this retry
            // loop.  /beef indexing is routinely transient; if it never becomes available, no irreversible choice
            // has been made and the Base lock remains refundable.  Keep this inside the attempt only after every
            // proof/ancestor byte is ready, but mark its failure so the broadcast retry catch cannot swallow it.
            if (!revealSideAcquired && deps.acquireRevealSide && session.state !== 'revealed') {
              try {
                await deps.acquireRevealSide(intent.hashHex)
                revealSideAcquired = true
              } catch (e) {
                revealIntentFailure = true
                const reason = e instanceof Error ? e.message : String(e)
                log('bsv', `restock reveal intent refused/unreachable — NOT persisting or broadcasting the BSV claim; Base refund remains the recovery path: ${reason}`)
                throw new Error(`restock reveal intent unavailable: ${reason}`)
              }
            }
            // WRITE-AHEAD: the exact raw claim (and BEEF when available), its deterministic txid, and `revealed`
            // state are durable before bytes leave this process. A crash or ambiguous broadcaster response can only
            // resume the BSV-claim path; it can never resurrect the Base-refund path.
            if (session.state !== 'revealed') session.observeReveal(Utils.toHex(secret), now())
            session.recordClaimBroadcast(claimTxid, claimRawHex, atomicBeefHex, claimConfs)
            deps.persist?.(session.toRecord())
            durableClaimTxid = claimTxid
            const submittedTxid = await bsv.broadcast(claimRawHex, atomicBeefHex) // ladder: raw + BEEF → Anvil→ARC→WoC→Bitails
            // Production broadcasters return the deterministic raw-tx id. Retain the returned identity for legacy
            // injected rails/tests; durable recovery always derives and validates identity from the persisted bytes.
            bsvClaimTxid = submittedTxid
            durableClaimTxid = submittedTxid
            break
          } catch (e) {
            if (revealIntentFailure) throw e
            const landed = await bsv.fetchTx(claimTxid).catch(() => null)
            if (landed) { bsvClaimTxid = claimTxid; log('bsv', `claim ${claimTxid.slice(0, 12)}… already on-chain — treating as accepted`); break }
            if (attempt >= CLAIM_BROADCAST_ATTEMPTS) throw e
            log('bsv', `claim broadcast attempt ${attempt}/${CLAIM_BROADCAST_ATTEMPTS} failed (${e instanceof Error ? e.message : String(e)}) — retrying in ${Math.round(CLAIM_BROADCAST_BACKOFF_MS / 1000)}s (SPV BEEF; /beef proof may still be indexing)`)
            await sleep(CLAIM_BROADCAST_BACKOFF_MS)
          }
        }
        if (bsvClaimTxid === undefined) throw new Error('bsv claim broadcast failed after all retries (SPV BEEF path)')
        try {
          await coord.sendRevealHint?.({ bsvClaimTxid })
        } catch (e) {
          log('bsv', `reveal-hint send failed — NON-FATAL, s is already on-chain (review 845a1252): ${e instanceof Error ? e.message : String(e)}`)
        }
        // LEVER B #3 (§12.12 detection, 0-conf ONLY): the reveal is irreversible (`s` is public + the record is
        // `revealed` → NOT refund-eligible, preserving 845a1252). For a 0-conf swap we now WATCH the unconfirmed lock for
        // a funding double-spend until OUR claim buries. A clean burial ⇒ the lock is necessarily mined ⇒ a definitive
        // WIN. A lock double-spend, transport error, or the claim never burying ⇒ a bounded (≤cap) LOSS/unresolved: do
        // NOT markSettled — return {ok:false} + KEEP the `revealed` record for the watchtower + a counterparty-reputation
        // nuke. Handled EXPLICITLY here (not via the generic catch) so a post-reveal throw can never un-persist the win
        // or resurface a Base refund. The confirmed path skips this (its lock was already ≥1-conf + merkle-proven).
        if (useZeroConfFastPath && deps.zeroConfStatus) {
          try {
            const claimMaxBlocks = cfg.zeroConfClaimMaxBlocks ?? 3
            const watchOpts = {
              // Block-cadence (BSVanon 2026-09-09): give up only after the chain advances `maxBlocks` REAL blocks; the
              // maxPolls cap is the absolute failsafe (stalled chain), NOT the give-up — so a slow BSV block extends
              
              maxPolls: cfg.zeroConfClaimMaxPolls ?? 4320, sleepMs: cfg.zeroConfSleepMs ?? 5_000, sleep,
              chainHeight: recoveryHeight, maxBlocks: claimMaxBlocks,
              onPoll: ({ blocksElapsed }: { poll: number; blocksElapsed: number }) => { if (blocksElapsed > 0) log('bsv', `0-conf claim-watch: ${blocksElapsed}/${claimMaxBlocks} new block(s) elapsed, claim ${bsvClaimTxid.slice(0, 12)}… not yet buried…`) },
            }
            // CRITICAL (2026-09-10 red-team): the post-reveal §12.12 lock-DS watch must ALSO use the minArc≥2 quorum, not
            // a single vantage — else the whole post-reveal loss-detection window trusts Anvil alone (the exact blind spot).
            const watchMinArc = cfg.zeroConfMinArcProviders ?? 1
            const cov = watchMinArc >= 2 && deps.zeroConfArcStatuses
              ? await watchRevealThroughClaimMultiArc(bsvLocked.bsvLockTxid, bsvClaimTxid, watchMinArc, watchOpts, deps.zeroConfArcStatuses, deps.zeroConfStatus)
              : await watchRevealThroughClaim(bsvLocked.bsvLockTxid, bsvClaimTxid, watchOpts, deps.zeroConfStatus)
            log('bsv', `0-conf reveal WON — claim ${bsvClaimTxid.slice(0, 12)}… buried, no lock double-spend (coverage ${coverageLabel(cov)})`)
          } catch (e) {
            log('alert', `0-conf reveal UNDER ATTACK — s is public, claim ${bsvClaimTxid.slice(0, 12)}… did NOT cleanly bury: ${e instanceof Error ? e.message : String(e)}`)
            return { ok: false, baseLockTxid, bsvClaimTxid, hashHex: evmPreimageHash, reason: `0-conf claim-watch failed after reveal (≤$${zeroConfCap} at risk, s public, record kept for watchtower): ${e instanceof Error ? e.message : String(e)}` }
          }
        } else {
          // CONFIRMED-PATH claim-burial watch (re-red-team 2026-09-05 + review f2ed788b MED). The lock was mined +
          // merkle-proven (B#1), but the CLAIM we just broadcast is 0-conf — and until now the confirmed path
          // FIRE-AND-FORGOT it (markSettled + clearRecord immediately). A stuck/evicted claim then leaves `s` public with
          // the BSV unclaimed: the responder claims the USDC with `s` and, after T_bsv, refunds the BSV → the taker loses
          // BOTH legs, having ALREADY dropped its recovery record. So watch OUR claim until it is PROVABLY mined; on
          // non-burial KEEP the `revealed` record (recoverable — re-broadcast the claim, NEVER refund) + return {ok:false}.
          // review MED: `bsv.txConfirmations` on the live rails is a TRUSTED WoC discovery read (not SPV / own-node) — a
          // false-positive AFTER `s` is public would clearRecord an unmined claim and RESTORE the both-leg loss. So on the
          // prod money path (a ChainTracker is wired — requireLockMerkleProof forces it) require a MERKLE-PROVEN claim BEEF
          // verified against the ChainTracker (the exact B#1 gate, applied to the claim). Only the legacy no-tracker path
          // (drills/tests) falls back to the trusted conf count. The /beef proof isn't servable until the claim mines, so
          // poll for it — a valid proof ⇒ mined; a proof that FAILS verification ⇒ throw (fail-closed, record kept).
          // BLOCK-CADENCE (BSVanon 2026-09-09): the give-up is measured in NEW blocks, not wall-clock polls — the same fix
          // as the 0-conf path, via the shared watchLockThroughClaim primitive. The lock is already mined+proven (B#1) so
          // lockStatus is a no-op 'accepted' (no funding-DS watch). A valid claim proof ⇒ buried; a proof that FAILS
          // verification THROWS (fail-closed, record kept); `zeroConfClaimMaxPolls` is only the absolute failsafe cap.
          const claimMaxBlocks = cfg.zeroConfClaimMaxBlocks ?? 3
          const proveClaimByMerkle = !!deps.chainTracker && typeof bsv.fetchBeef === 'function'
          const claimBuriedCheck = async (): Promise<boolean> => {
            if (proveClaimByMerkle) {
              const beefTx = await bsv.fetchBeef!(bsvClaimTxid).catch(() => null)
              const mp = beefTx?.merklePath
              if (!mp) return false
              const proof = await verifyMerkleProof(bsvClaimTxid, mp, `confirmed-path: claim ${bsvClaimTxid.slice(0, 12)}…`)
              if (proof === 'invalid') throw new Error(`confirmed-path: claim ${bsvClaimTxid.slice(0, 12)}… merkle proof FAILED ChainTracker verification — refusing to declare it settled (s public, record kept)`)
              return proof === 'valid'
            }
            const confs = await bsv.txConfirmations(bsvClaimTxid).catch(() => 0)
            return confs >= 1
          }
          try {
            await watchLockThroughClaim(
              async () => 'accepted' as const,
              claimBuriedCheck,
              {
                maxPolls: cfg.zeroConfClaimMaxPolls ?? 4320, sleepMs: cfg.zeroConfSleepMs ?? 5_000, sleep,
                chainHeight: recoveryHeight, maxBlocks: claimMaxBlocks,
                onPoll: ({ blocksElapsed }) => log('bsv', `confirmed-path: awaiting claim ${bsvClaimTxid.slice(0, 12)}… ${proveClaimByMerkle ? 'merkle proof' : 'burial'} (${blocksElapsed}/${claimMaxBlocks} new block(s))…`),
              },
            )
          } catch (e) {
            log('alert', `confirmed-path: claim ${bsvClaimTxid.slice(0, 12)}… NOT provably mined within the block-cadence window — s public, BSV unclaimed; record KEPT for watchtower/re-broadcast (do NOT refund): ${e instanceof Error ? e.message : String(e)}`)
            return { ok: false, baseLockTxid, bsvClaimTxid, hashHex: evmPreimageHash, reason: `confirmed-path claim ${bsvClaimTxid.slice(0, 12)}… not provably mined within the burial window (s public, record kept for recovery — re-broadcast the claim, do NOT refund): ${e instanceof Error ? e.message : String(e)}` }
          }
          log('bsv', `confirmed-path: claim ${bsvClaimTxid.slice(0, 12)}… ${proveClaimByMerkle ? 'merkle-proven mined' : 'buried'} ✅`)
        }
        session.markSettled(now())
        deps.clearRecord?.(hashHex) // M-4: settled → DROP the at-risk record (was re-persisting it → stale masks accumulate)
        log('done', `BSV CLAIMED ${bsvClaimTxid.slice(0, 12)}… — s revealed on-chain, swap settled ✅`)
        return { ok: true, baseLockTxid, bsvClaimTxid, hashHex: evmPreimageHash }
      } catch (e) {
        // Before write-ahead, failure remains Base-refund eligible. At/after write-ahead the exact claim may have
        // escaped even when every broadcaster response was an error, so return its id and keep claim recovery alive.
        return { ok: false, baseLockTxid, bsvClaimTxid: durableClaimTxid, hashHex: evmPreimageHash, reason: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
