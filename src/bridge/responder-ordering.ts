/**
 * Cross-chain responder ordering in one deterministic unit.
 *
 * BSV block arrivals are modelled as a Poisson process with a 600-second mean,
 * so the time to `window` blocks is Gamma(shape=window, scale=600s). The table
 * contains the smallest whole second whose Erlang survival probability is at
 * most 1e-6: exp(-t/600) * sum(i=0..window-1, (t/600)^i / i!).
 */

/** Minimum BSV runway for lock confirmation plus the initiator's reveal budget. */
export const MIN_REVEAL_CONFIRM_BUDGET_BLOCKS = 6
export const MIN_RESPONDER_WINDOW_BLOCKS = MIN_REVEAL_CONFIRM_BUDGET_BLOCKS + 2

/** Long windows amplify the tail risk and are not accepted by the live responder. */
export const MAX_RESPONDER_WINDOW_BLOCKS = 24

/** Extra Base runway beyond the claim budget. */
export const MIN_RESPONDER_BASE_MARGIN_BLOCKS = 900
export const BSV_BLOCK_SECS_EST = 600
export const BASE_BLOCK_SECS_EST = 2
export const CROSS_CHAIN_MARGIN_SECS = 30 * 60

// Index 0 is deliberately unused so the BSV window is the direct table index.
const BSV_REFUND_GAMMA_P999999_SECS = Object.freeze([
  0,
  8_290, 10_014, 11_478, 12_811, 14_059, 15_248,
  16_391, 17_498, 18_575, 19_627, 20_657, 21_669,
  22_665, 23_646, 24_614, 25_570, 26_515, 27_451,
  28_378, 29_296, 30_207, 31_111, 32_008, 32_898,
])

/** 1e-6 upper-tail Gamma bound for an already-validated BSV window. */
export function bsvRefundGammaUpperBoundSecs(windowBlocks: number): number {
  if (!Number.isInteger(windowBlocks) || windowBlocks < 1 || windowBlocks > MAX_RESPONDER_WINDOW_BLOCKS) {
    throw new Error(`BSV window must be an integer in [1, ${MAX_RESPONDER_WINDOW_BLOCKS}] (got ${String(windowBlocks)})`)
  }
  return BSV_REFUND_GAMMA_P999999_SECS[windowBlocks]
}

export interface ResponderOrderingInputs {
  bsvRefundLocktime: number
  baseTimelockBlock: number
  claimBudgetBaseBlocks: number
}

export interface OrderingGuardResult {
  ok: boolean
  reason?: string
}

/** A live chain height must be a finite, non-negative safe integer. */
export function isChainHeight(h: number): boolean {
  return Number.isSafeInteger(h) && h >= 0
}

export function checkResponderRunwayAndOrdering(
  p: ResponderOrderingInputs,
  heights: { bsvHeight: number; baseHeight: number },
): OrderingGuardResult {
  if (!Number.isSafeInteger(p.bsvRefundLocktime) || p.bsvRefundLocktime <= 0 ||
      !Number.isSafeInteger(p.baseTimelockBlock) || p.baseTimelockBlock <= 0 ||
      !Number.isSafeInteger(p.claimBudgetBaseBlocks) || p.claimBudgetBaseBlocks <= 0) {
    return { ok: false, reason: `invalid ordering inputs (fail-closed): bsvRefundLocktime=${p.bsvRefundLocktime} baseTimelockBlock=${p.baseTimelockBlock} claimBudgetBaseBlocks=${p.claimBudgetBaseBlocks} — all must be positive safe integers` }
  }
  if (!isChainHeight(heights.bsvHeight) || !isChainHeight(heights.baseHeight)) {
    return { ok: false, reason: `invalid live height(s) bsv=${heights.bsvHeight} base=${heights.baseHeight} — must be finite non-negative integers (fail-closed; a NaN/Infinity would silently pass every runway/ordering check)` }
  }

  const bsvWindow = p.bsvRefundLocktime - heights.bsvHeight
  if (bsvWindow < MIN_RESPONDER_WINDOW_BLOCKS) {
    return { ok: false, reason: `BSV window ${bsvWindow} block(s) < ${MIN_RESPONDER_WINDOW_BLOCKS} — too close to the refund height to lock safely` }
  }
  if (bsvWindow > MAX_RESPONDER_WINDOW_BLOCKS) {
    return { ok: false, reason: `BSV window ${bsvWindow} block(s) > ${MAX_RESPONDER_WINDOW_BLOCKS} — exceeds the maximum accepted responder window` }
  }

  const baseRunway = p.baseTimelockBlock - heights.baseHeight
  const baseFloor = p.claimBudgetBaseBlocks + MIN_RESPONDER_BASE_MARGIN_BLOCKS
  if (baseRunway < baseFloor) {
    return { ok: false, reason: `Base runway ${baseRunway} block(s) < claim budget ${p.claimBudgetBaseBlocks} + margin ${MIN_RESPONDER_BASE_MARGIN_BLOCKS} — the USDC-claim window could expire mid-swap` }
  }

  const bsvRefundBoundSecs = bsvRefundGammaUpperBoundSecs(bsvWindow)
  const safeClaimWcSecs = (baseRunway - p.claimBudgetBaseBlocks) * BASE_BLOCK_SECS_EST
  if (safeClaimWcSecs < bsvRefundBoundSecs + CROSS_CHAIN_MARGIN_SECS) {
    return {
      ok: false,
      reason: `cross-chain timelock mis-ordered: BSV refund 99.9999% bound ~${Math.round(bsvRefundBoundSecs / 60)}min vs the market maker's USDC-claim cutoff ~${Math.round(safeClaimWcSecs / 60)}min (need cutoff ≥ BSV-refund bound + ${CROSS_CHAIN_MARGIN_SECS / 60}min) — refusing (a taker could reveal past the market maker's claim window and keep both legs)`,
    }
  }
  return { ok: true }
}
