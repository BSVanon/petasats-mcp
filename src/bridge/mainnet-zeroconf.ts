/**
 * §12.11 MAINNET 0-conf monitor — the REAL double-spend gate for a mainnet-pilot 0-conf reveal.
 * Wires the pure fail-closed primitives (`zeroconf-monitor.ts`) to the live ARC/Anvil status rail
 * (`wallet/broadcast.ts` `getTxStatus`, which carries GorillaPool / TAAL / Anvil
 * `DOUBLE_SPEND_ATTEMPTED`). The testnet runner's WoC "still-seen" stand-in CANNOT observe a
 * double-spend — THIS is what a mainnet 0-conf swap must use (review ecb0de3 HIGH).
 *
 * Two phases wrap the irreversible reveal:
 *   1. `assertLockSafeForZeroConf` — BEFORE revealing `s`: the lock is ARC-accepted with no DS
 *      across the watch. A non-ARC "seen" is downgraded to unknown (fail-closed), so a WoC fallback
 *      can't fake safety.
 *   2. `watchRevealThroughClaim` — AFTER revealing: watch the lock for a DS until the initiator's
 *      OWN claim buries (the loss window). Fail-closed throughout; records provider coverage.
 */

import { getTxStatus, type TxStatus } from '../wallet/broadcast'
import {
  classifyArcStatus, classifyMultiArc, monitorZeroConf, watchLockThroughClaim,
  type ZeroConfVerdict, type ZeroConfMonitorOpts, type WatchThroughClaimOpts,
} from './zeroconf-monitor'

/** Which providers actually answered during a watch — logged so the operator sees the DS-signal coverage. */
export interface ArcCoverage {
  providers: Set<string>
}

export type FetchTxStatus = (txid: string) => Promise<TxStatus>

/**
 * A fail-closed ARC verdict source for `txid`, recording which providers answered (coverage). Uses the
 * live `getTxStatus` rail by default; tests inject a fake. Provider-aware: only an ARC-class "accepted"
 * clears; a WoC/Bitails/none "seen" → 'unknown'.
 */
export function arcZeroConfSource(
  txid: string,
  coverage: ArcCoverage,
  fetchStatus: FetchTxStatus = getTxStatus,
): () => Promise<ZeroConfVerdict> {
  return async () => {
    const s = await fetchStatus(txid)
    coverage.providers.add(s.provider)
    return classifyArcStatus(s.status, s.provider)
  }
}

/** Human-readable coverage summary for logs, e.g. "GorillaPool,Anvil" (or "none"). */
export function coverageLabel(coverage: ArcCoverage): string {
  return [...coverage.providers].join(',') || 'none'
}

/**
 * PHASE 1 — the fail-closed reveal gate against the live ARC rail. Clears only if the lock is
 * ARC-accepted with no double-spend across the watch window (see `monitorZeroConf`). Returns the
 * provider coverage seen (guaranteed to include an ARC-class provider on success, since only an
 * ARC "accepted" can satisfy the final poll).
 *
 * LIVE-PROVEN on mainnet 2026-08-19 (scripts/probe-arc-doublespend.ts): a real de-minimis
 * double-spend of a BSV UTXO made Anvil flip the FIRST-seen (lock) tx's status SEEN_ON_NETWORK →
 * DOUBLE_SPEND_ATTEMPTED within one poll — so polling the LOCK here detects a funding double-spend,
 * no separate input-outpoint watcher needed. It also confirmed the multi-poll loop is required (the
 * flip landed on poll 1, not poll 0), and that a non-ARC "seen" (WoC) stays blind to the conflict.
 */
export async function assertLockSafeForZeroConf(
  lockTxid: string,
  opts: ZeroConfMonitorOpts,
  fetchStatus: FetchTxStatus = getTxStatus,
): Promise<ArcCoverage> {
  const coverage: ArcCoverage = { providers: new Set() }
  await monitorZeroConf(arcZeroConfSource(lockTxid, coverage, fetchStatus), opts)
  return coverage
}

export type FetchArcStatuses = (txid: string) => Promise<Array<{ status: string; provider: string }>>

/**
 * A fail-closed MULTI-ARC verdict source for `txid` (seam 4a, full-pilot minArc ≥ N upgrade over
 * `arcZeroConfSource`'s single-provider gate). Fetches every configured ARC-class provider's status
 * in one shot via `fetchStatuses` (see `wallet/broadcast.ts` `getMultiArcTxStatuses` for the live
 * rail), records EVERY provider that answered into `coverage` — including ones that came back
 * UNKNOWN, so an operator can see exactly who was consulted — and hands the raw reports to
 * `classifyMultiArc`, which fail-closes unless ≥ `minArc` DISTINCT ARC providers each report
 * 'accepted' (and aborts immediately on any single double-spend witness).
 */
export function multiArcZeroConfSource(
  txid: string,
  minArc: number,
  coverage: ArcCoverage,
  fetchStatuses: FetchArcStatuses,
): () => Promise<ZeroConfVerdict> {
  return async () => {
    const reports = await fetchStatuses(txid)
    for (const r of reports) coverage.providers.add(r.provider)
    return classifyMultiArc(reports, minArc)
  }
}

/**
 * PHASE 1 — MULTI-ARC upgrade over `assertLockSafeForZeroConf`. Mirrors it exactly, but drives
 * `monitorZeroConf` off `multiArcZeroConfSource` instead of the single-provider `arcZeroConfSource`:
 * on success, the FINAL poll had ≥ `minArc` DISTINCT ARC-class providers report 'accepted', with no
 * double-spend witness (from any provider) across the whole watch window. A single wrong / down /
 * compromised ARC provider can no longer clear the irreversible reveal on its own once `minArc` ≥ 2.
 */
export async function assertLockSafeForZeroConfMultiArc(
  lockTxid: string,
  minArc: number,
  opts: ZeroConfMonitorOpts,
  fetchStatuses: FetchArcStatuses,
): Promise<ArcCoverage> {
  const coverage: ArcCoverage = { providers: new Set() }
  await monitorZeroConf(multiArcZeroConfSource(lockTxid, minArc, coverage, fetchStatuses), opts)
  return coverage
}

/**
 * PATH-A DETECTION (§12.12) — after the reveal, watch the lock for a funding double-spend until the
 * initiator's own claim buries (status MINED, ≥1 conf). This DETECTS the outcome (win vs a bounded
 * ≤cap loss); it does NOT prevent a loss — `s` is already public, so the counterparty can claim
 * regardless. A confirmation is objective, so `claimConfirmed` trusts MINED from ANY provider; the
 * lock-DS watch stays ARC-aware. Throws (fail-closed) on any lock double-spend, any transport error,
 * or if the claim never buries within the window — the caller must then NOT declare the swap complete.
 */
export async function watchRevealThroughClaim(
  lockTxid: string,
  claimTxid: string,
  opts: WatchThroughClaimOpts,
  fetchStatus: FetchTxStatus = getTxStatus,
): Promise<ArcCoverage> {
  const coverage: ArcCoverage = { providers: new Set() }
  const lockStatus = arcZeroConfSource(lockTxid, coverage, fetchStatus)
  const claimConfirmed = async (): Promise<boolean> => {
    const s = await fetchStatus(claimTxid)
    coverage.providers.add(s.provider)
    return s.status === 'MINED'
  }
  await watchLockThroughClaim(lockStatus, claimConfirmed, opts)
  return coverage
}

/**
 * MULTI-ARC variant of {@link watchRevealThroughClaim} (seam 4a / 2026-09-10 red-team CRIT): the post-reveal §12.12
 * lock-double-spend watch must NOT silently downgrade to a single ARC vantage when the reveal was gated on a minArc≥2
 * quorum. The lock-DS source here is the QUORUM ({@link multiArcZeroConfSource}) — a DS witness from ANY provider still
 * aborts, and the loss of the quorum (fewer than `minArc` distinct ARC 'accepted') reads as 'unknown' → the watch
 * fails-closed exactly as the gate does. The claim-burial check stays single: MINED is OBJECTIVE (a mined claim spends
 * the lock ⇒ a definitive WIN regardless of which provider reports it).
 */
export async function watchRevealThroughClaimMultiArc(
  lockTxid: string,
  claimTxid: string,
  minArc: number,
  opts: WatchThroughClaimOpts,
  fetchStatuses: FetchArcStatuses,
  fetchStatus: FetchTxStatus = getTxStatus,
): Promise<ArcCoverage> {
  const coverage: ArcCoverage = { providers: new Set() }
  const lockStatus = multiArcZeroConfSource(lockTxid, minArc, coverage, fetchStatuses)
  const claimConfirmed = async (): Promise<boolean> => {
    const s = await fetchStatus(claimTxid)
    coverage.providers.add(s.provider)
    return s.status === 'MINED'
  }
  await watchLockThroughClaim(lockStatus, claimConfirmed, opts)
  return coverage
}
