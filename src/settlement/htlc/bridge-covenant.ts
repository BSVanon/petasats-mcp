import { LockingScript } from '@bsv/sdk'
import {
  buildCovenantHtlcScript,
  buildCovenantClaimTx,
  buildCovenantRefundTx,
  covenantMatches,
  extractCovenantClaimSecret,
  type BuildCovenantHtlcParams,
  type CovenantUtxo,
  type CovenantRefundFunding,
} from '../covenant/covenant-htlc'
export type { CovenantRefundFunding } from '../covenant/covenant-htlc'
/** The P2PKH dust floor — a forced output below this is unspendable/non-standard, so the fee budget must leave the
 *  payout AND refund at or above it, and the claim's tip must stay spendable too. */
export const BRIDGE_COVENANT_DUST_SATS = 1
/** A covenant claim/refund spend is ~2000 bytes (pushtx preimage + the ~1.7kB covenant scriptCode). Round up so the
 *  fee budget covers the real weight. Measured: claim ≈ 2038 B, refund ≈ 1971 B (red-team agent-3, 2026-09-01). */
export const COVENANT_SPEND_BYTES = 2200
export const DEFAULT_BSV_FEE_RATE_SAT_PER_KB = 500

export function sizeCovenantFeeBudgetSats(feeRateSatPerKb: number, headroom = 4): number {
  if (!(feeRateSatPerKb > 0) || !(headroom > 0)) throw new Error(`sizeCovenantFeeBudgetSats: feeRate + headroom must be > 0 (got ${feeRateSatPerKb}, ${headroom})`)
  const sized = Math.ceil((COVENANT_SPEND_BYTES / 1000) * feeRateSatPerKb * headroom)
  return Math.max(1000, sized) // floor 1000 (== settlement-session's DEFAULT_COVENANT_FEE_BUDGET_SATS); a high fee rate sizes UP
}

export interface BridgeCovenantTerms {
  /** `H = SHA256(s)` (32-byte hex) — the shared hashlock (matches the Base ERC20Swap sha256). */
  hashHex: string
  /** The taker's BSV P2PKH address — the claim is FORCED here (the taker receives the BSV). */
  takerBsvAddress: string
  
  mmBsvAddress: string
  /** The covenant output value = the swap's deliver amount (what the MM funds the lock with). */
  htlcSats: number
  /** T_bsv — the absolute BSV block height before which the refund cannot confirm. */
  bsvRefundLocktime: number
  /** Reserved miner-fee headroom for the taker's CLAIM spend (sats). Both legs agree on it (it is committed). */
  claimFeeBudgetSats: number
  /** Reserved miner-fee headroom for the MM's REFUND spend (sats). Both legs agree on it (it is committed). */
  refundFeeBudgetSats: number
}
function assertTerms(t: BridgeCovenantTerms): void {
  if (!Number.isSafeInteger(t.htlcSats) || t.htlcSats <= 0) throw new Error(`bridge-covenant: htlcSats must be a positive integer; got ${t.htlcSats}`)
  if (!Number.isSafeInteger(t.claimFeeBudgetSats) || t.claimFeeBudgetSats < 0) throw new Error(`bridge-covenant: claimFeeBudgetSats must be a non-negative integer; got ${t.claimFeeBudgetSats}`)
  if (!Number.isSafeInteger(t.refundFeeBudgetSats) || t.refundFeeBudgetSats < 0) throw new Error(`bridge-covenant: refundFeeBudgetSats must be a non-negative integer; got ${t.refundFeeBudgetSats}`)
  // A forced payout/refund must stay at/above the dust floor after its fee budget — else the covenant output is
  // unspendable and the funds are bricked. Fail-closed at construction (never fund a lock that can't be claimed/refunded).
  if (t.htlcSats - t.claimFeeBudgetSats < BRIDGE_COVENANT_DUST_SATS) throw new Error(`bridge-covenant: claim payout ${t.htlcSats - t.claimFeeBudgetSats} < dust ${BRIDGE_COVENANT_DUST_SATS} (htlcSats ${t.htlcSats} − claimFeeBudget ${t.claimFeeBudgetSats})`)
  if (t.htlcSats - t.refundFeeBudgetSats < BRIDGE_COVENANT_DUST_SATS) throw new Error(`bridge-covenant: refund payout ${t.htlcSats - t.refundFeeBudgetSats} < dust ${BRIDGE_COVENANT_DUST_SATS} (htlcSats ${t.htlcSats} − refundFeeBudget ${t.refundFeeBudgetSats})`)
}
/** The taker's guaranteed claim amount (forced at output[0]). */
export function bridgeCovenantPayoutSats(t: BridgeCovenantTerms): number {
  return t.htlcSats - t.claimFeeBudgetSats
}
/** The MM's guaranteed refund amount (forced at output[0]). */
export function bridgeCovenantRefundSats(t: BridgeCovenantTerms): number {
  return t.htlcSats - t.refundFeeBudgetSats
}

/** Map the bridge swap terms → the covenant primitive's committed params. The single source of truth both the
 *  script builder AND the spend builders derive from — so the forced amounts/addresses can never drift apart. */
export function bridgeCovenantParams(t: BridgeCovenantTerms): BuildCovenantHtlcParams {
  assertTerms(t)
  return {
    hashHex: t.hashHex,
    payoutAddress: t.takerBsvAddress,
    payoutSats: bridgeCovenantPayoutSats(t),
    refundAddress: t.mmBsvAddress,
    refundSats: bridgeCovenantRefundSats(t),
    refundLockHeight: t.bsvRefundLocktime,
  }
}

/** The bridge covenant locking script for these terms. */
export function buildBridgeCovenantScript(t: BridgeCovenantTerms): LockingScript {
  return buildCovenantHtlcScript(bridgeCovenantParams(t))
}

export function bridgeCovenantMatches(scriptHex: string, t: BridgeCovenantTerms): boolean {
  return covenantMatches(scriptHex, bridgeCovenantParams(t))
}
export function assertBridgeCovenantMatches(scriptHex: string, t: BridgeCovenantTerms): void {
  if (!bridgeCovenantMatches(scriptHex, t)) {
    throw new Error('bridge-covenant: script does not force the agreed swap terms — do NOT trust this lock')
  }
}

/**
 * The taker's CLAIM: reveal `s`, force `payoutSats → takerBsvAddress` at output[0], sweep the leftover to
 * `tipAddress` (default the taker's own address). Permissionless — anyone with `s` can broadcast it; the covenant
 * guarantees the taker is paid. `s` becomes public on-chain → the MM extracts it and claims the USDC leg.
 */
export function buildBridgeCovenantClaimTx(p: {
  covenant: CovenantUtxo
  secret: number[]
  terms: BridgeCovenantTerms
  /** Where the leftover (output[1]) goes; defaults to the taker's address. */
  tipAddress?: string
  feeRate?: number
}) {
  return buildCovenantClaimTx({
    covenant: p.covenant,
    secret: p.secret,
    payoutAddress: p.terms.takerBsvAddress,
    payoutSats: bridgeCovenantPayoutSats(p.terms),
    tipAddress: p.tipAddress ?? p.terms.takerBsvAddress,
    feeRate: p.feeRate,
  })
}

/**
 * The MM's REFUND: after T_bsv, force `refundSats → mmBsvAddress` at output[0] with nLockTime ≥ T_bsv and a
 * non-final sequence. Permissionless + signature-free — the MM reclaims ALONE (the HIGH#1 fix). `refundLockHeight`
 * defaults to the committed T_bsv; pass a later height to submit past it (still ≥ T_bsv, so the covenant accepts).
 */
export function buildBridgeCovenantRefundTx(p: {
  covenant: CovenantUtxo
  terms: BridgeCovenantTerms
  /** The tx nLockTime; must be ≥ the committed T_bsv (defaults to it). */
  refundLockHeight?: number
  /** Optional fee-bump: an MM UTXO + change address + target rate to raise the refund fee ABOVE the committed budget
   *  (the strand defense for a fee spike beyond the sized headroom). Omit for the plain output[0]-only refund. */
  funding?: CovenantRefundFunding
}) {
  return buildCovenantRefundTx({
    covenant: p.covenant,
    refundAddress: p.terms.mmBsvAddress,
    refundSats: bridgeCovenantRefundSats(p.terms),
    refundLockHeight: p.refundLockHeight ?? p.terms.bsvRefundLocktime,
    funding: p.funding,
  })
}

/** Recover `s` from a broadcast bridge-covenant CLAIM (verifies SHA256(s)==H). null if not a matching claim. */
export function extractBridgeCovenantSecret(claimTx: Parameters<typeof extractCovenantClaimSecret>[0], covenantTxid: string, vout: number, hashHex: string): number[] | null {
  return extractCovenantClaimSecret(claimTx, covenantTxid, vout, hashHex)
}
