/**
 * §12.11 0-conf reveal monitor — the double-spend gate the INITIATOR runs before revealing
 * `s` against an UNCONFIRMED BSV lock (small swaps, the fast path). Revealing is irreversible,
 * so this is FAIL-CLOSED: it clears only if no poll reports a double-spend, no poll errors, and the
 * FINAL poll is ACCEPTED. A double-spend signal or a transport error aborts immediately; an early
 * UNKNOWN is tolerated as propagation lag, but ending on UNKNOWN aborts. Uncertainty is danger.
 *
 * These are the PURE, injectable primitives (no network). The mainnet/testnet status SOURCE is
 * wired in by the caller — see `src/bridge/mainnet-zeroconf.ts` for the live ARC/Anvil rail:
 *  - MAINNET: ARC/Anvil `getTxStatus` → `classifyArcStatus` (real `DOUBLE_SPEND_ATTEMPTED` signal;
 *    a NON-ARC "seen" is downgraded to 'unknown' — it can't observe a competing spend).
 *  - TESTNET: a WoC "still-seen" stand-in can only report accepted/unknown (NO double-spend
 *    signal) — so it is NOT sufficient for mainnet 0-conf on its own; documented at the call site.
 *
 * Two phases wrap the irreversible reveal: `monitorZeroConf` BEFORE revealing (lock is ARC-accepted,
 * no DS across the watch) and `watchLockThroughClaim` AFTER (watch the lock for a DS until the
 * initiator's own claim buries — the loss window, see that fn).
 */

export type ZeroConfVerdict = 'accepted' | 'double-spend' | 'unknown'

/** Map an ARC/Anvil tx-status string to a 0-conf verdict. Fail-closed: anything unclear → 'unknown'. */
export function classifyTxStatus(status: string | undefined): ZeroConfVerdict {
  const s = (status ?? '').toUpperCase()
  if (s.includes('DOUBLE_SPEND') || s === 'REJECTED' || s === 'CONFLICTING') return 'double-spend'
  if (s === 'SEEN_ON_NETWORK' || s === 'MINED' || s === 'ALREADY_IN_MEMPOOL' || s === 'ACCEPTED_BY_NETWORK') return 'accepted'
  return 'unknown'
}

/**
 * ARC-class providers whose mempool actually carries a `DOUBLE_SPEND_ATTEMPTED` signal. A positive
 * "seen" from anyone else (WhatsOnChain / Bitails / none) does NOT prove the absence of a competing
 * spend, so it must not be trusted to clear a 0-conf reveal.
 */
export const ARC_PROVIDERS: ReadonlySet<string> = new Set(['Anvil', 'GorillaPool', 'TAAL'])

/**
 * Provider-aware 0-conf verdict — the MAINNET upgrade over the raw status classifier. A double-spend
 * signal is trusted from ANY provider (belt-and-suspenders), but a POSITIVE "accepted" is trusted
 * ONLY from an ARC-class provider; a non-ARC "seen" is downgraded to 'unknown' (fail-closed) so a
 * WoC/Bitails/none fallback can never fake safety on the irreversible reveal path.
 */
export function classifyArcStatus(status: string | undefined, provider: string | undefined): ZeroConfVerdict {
  const base = classifyTxStatus(status)
  if (base === 'double-spend') return 'double-spend'
  if (base === 'accepted') return ARC_PROVIDERS.has(provider ?? '') ? 'accepted' : 'unknown'
  return 'unknown'
}

/**
 * MULTI-ARC 0-conf verdict (minArc ≥ N) — the FULL-pilot upgrade over the single-provider gate (seam 4a). Given the
 * statuses reported by a SET of independent ARC-class providers for the SAME lock this poll, decide fail-closed:
 *   • 'double-spend' if ANY provider (ARC or not) reports a conflict — one witness of a conflict is enough (b&s).
 *   • 'accepted' ONLY if ≥ `minArc` DISTINCT ARC-class providers each report 'accepted' — independent corroboration,
 *     so a single wrong / compromised / colluding ARC provider cannot clear the irreversible reveal on its own.
 *   • 'unknown' otherwise (fail-closed) — too few independent ARC confirmations yet.
 * A non-ARC "seen" (WhatsOnChain / Bitails / none) NEVER counts toward the ARC quorum — it cannot observe a competing
 * spend (`classifyArcStatus` already downgrades it to 'unknown'). minArc=1 reduces to the single-provider behaviour.
 */
export function classifyMultiArc(
  reports: ReadonlyArray<{ status: string | undefined; provider: string | undefined }>,
  minArc: number,
): ZeroConfVerdict {
  if (!Number.isInteger(minArc) || minArc < 1) throw new Error('classifyMultiArc: minArc must be an integer ≥ 1')
  const arcAccepted = new Set<string>()
  for (const r of reports) {
    const v = classifyArcStatus(r.status, r.provider) // DS trusted from anyone; 'accepted' ONLY from an ARC provider
    if (v === 'double-spend') return 'double-spend'    // any single DS witness aborts the reveal (belt-and-suspenders)
    if (v === 'accepted' && r.provider) arcAccepted.add(r.provider) // count DISTINCT ARC providers (provider is ARC here)
  }
  return arcAccepted.size >= minArc ? 'accepted' : 'unknown'
}

export interface ZeroConfMonitorOpts {
  /** Number of status checks across the watch window (≥ 1). */
  polls: number
  /** Gap between checks (ms). */
  sleepMs: number
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Watch the lock across the window. Resolves ONLY if no poll ever reports a double-spend, no
 * poll throws, AND the FINAL poll is 'accepted' (we end in a known-good state — early 'unknown'
 * is tolerated as propagation lag, but ending uncertain is not). A DELAYED conflict appearing
 * mid-window is caught because every poll is checked. Throws (fail-closed) otherwise.
 */
export async function monitorZeroConf(getStatus: () => Promise<ZeroConfVerdict>, opts: ZeroConfMonitorOpts): Promise<void> {
  if (!Number.isInteger(opts.polls) || opts.polls < 1) throw new Error('monitorZeroConf: polls must be an integer ≥ 1')
  if (!Number.isFinite(opts.sleepMs) || opts.sleepMs < 0) throw new Error('monitorZeroConf: sleepMs must be a finite number ≥ 0')
  const sleep = opts.sleep ?? realSleep
  let last: ZeroConfVerdict = 'unknown'
  for (let i = 0; i < opts.polls; i++) {
    let verdict: ZeroConfVerdict
    try {
      verdict = await getStatus()
    } catch (e) {
      throw new Error(`0-conf monitor: status check failed (fail-closed) — ${e instanceof Error ? e.message : String(e)}`)
    }
    if (verdict === 'double-spend') throw new Error('0-conf monitor: DOUBLE-SPEND detected on the BSV lock — refusing to reveal')
    last = verdict
    if (i < opts.polls - 1) await sleep(opts.sleepMs)
  }
  if (last !== 'accepted') {
    throw new Error('0-conf monitor: lock not confirmed-accepted by end of watch (fail-closed) — refusing to reveal')
  }
}

export interface WatchThroughClaimOpts {
  /** ABSOLUTE failsafe cap on status rounds (≥ 1). In block-cadence mode (below) this only fires if the chain is
   *  fully STALLED / the height source is broken; otherwise `maxBlocks` decides. In legacy (no `chainHeight`) mode it
   *  is the wall-clock give-up (`maxPolls × sleepMs`). Fail-closed if the claim never buries within it. */
  maxPolls: number
  /** Gap between checks (ms). */
  sleepMs: number
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
  /**
   * BLOCK-CADENCE budget (BSVanon's fix, 2026-09-09). When provided, the watch fails ONLY after the chain advances
   * `maxBlocks` NEW blocks (measured by this height source since watch start) without the claim burying — NOT after a
   * wall-clock timeout. BSV's block-time variance (frequent 20–40+ min gaps around a ~10 min mean) makes wall-clock
   * unsafe: a slow-but-normal block would false-fail an honest, adequately-fee'd claim (observed 2026-09-04/09). An
   * honest claim buries in the next block or two; only a genuinely stuck claim survives `maxBlocks` real blocks.
   * Omit ⇒ legacy wall-clock poll-count behaviour (unchanged; kept for the pure primitive tests + non-mainnet rails).
   */
  chainHeight?: () => Promise<number>
  /** New-block budget for block-cadence mode (integer ≥ 1, default 3). Ignored without `chainHeight`. */
  maxBlocks?: number
  /** Consecutive bad `chainHeight` reads tolerated in block-cadence mode (integer ≥ 0, default 60). D2 showed that
   * a single Anvil height-read blip must not abandon a post-reveal claim; bad reads never count as block progress and
   * the bounded tolerance still fails closed if the height rail remains unreliable. Ignored without `chainHeight`. */
  maxHeightFailures?: number
  /** Optional per-poll progress hook (poll index + new blocks elapsed since watch start) — for operator logging. */
  onPoll?: (info: { poll: number; blocksElapsed: number }) => void
}

/**
 * §12.12 PATH-A DETECTION (NOT prevention) — after the initiator REVEALS `s` against a 0-conf lock,
 * watch the LOCK for a funding double-spend until the initiator's own CLAIM buries (≥1 conf). This
 * cannot PREVENT a loss: `s` is already public, so the responder can claim the counterparty asset
 * regardless. It DETECTS the outcome — a clean burial means the initiator kept its asset (WIN); a
 * lock double-spend means the initiator was robbed of this (bounded, ≤cap) swap while `s` was public
 * (LOSS). Once the claim is mined the lock is necessarily mined too (the claim spends the lock
 * output), so a clean burial is a definitive WIN.
 *
 * Each round checks `claimConfirmed()` FIRST (a buried claim ⇒ WIN, regardless of any now-stale lock
 * signal), then the lock verdict. FAIL-CLOSED: any lock double-spend, any transport error, or the
 * claim NOT burying within `maxPolls` → throw. A throw means "loss / unresolved" — the caller must
 * NOT declare the swap complete; surface it loudly (and, in production, nuke the counterparty's
 * reputation + optionally re-broadcast the lock to contest the funding race).
 */
export async function watchLockThroughClaim(
  lockStatus: () => Promise<ZeroConfVerdict>,
  claimConfirmed: () => Promise<boolean>,
  opts: WatchThroughClaimOpts,
): Promise<void> {
  if (!Number.isInteger(opts.maxPolls) || opts.maxPolls < 1) throw new Error('watchLockThroughClaim: maxPolls must be an integer ≥ 1')
  if (!Number.isFinite(opts.sleepMs) || opts.sleepMs < 0) throw new Error('watchLockThroughClaim: sleepMs must be a finite number ≥ 0')
  const sleep = opts.sleep ?? realSleep
  const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
  const useBlocks = typeof opts.chainHeight === 'function'
  const maxBlocks = opts.maxBlocks ?? 3
  if (useBlocks && (!Number.isInteger(maxBlocks) || maxBlocks < 1)) throw new Error('watchLockThroughClaim: maxBlocks must be an integer ≥ 1')
  const maxHeightFailures = opts.maxHeightFailures ?? 60
  if (useBlocks && (!Number.isInteger(maxHeightFailures) || maxHeightFailures < 0)) throw new Error('watchLockThroughClaim: maxHeightFailures must be an integer ≥ 0')
  // BLOCK-CADENCE (BSVanon's fix): anchor the give-up budget to CHAIN PROGRESS, not wall-clock — the budget is measured
  // in NEW blocks since the FIRST unburied poll, so a slow-but-normal block extends the wait instead of false-failing an
  // honest claim. review 099868d1: (MEDIUM) the height rail is consulted ONLY AFTER an unburied claim result — never
  // before — so a height outage can NEVER override the buried-first WIN (a mined/merkle-proven claim is definitive
  // regardless of the tip). (LOW) every height is validated: a malformed (NaN/negative/fractional) or REGRESSING tip
  // fails closed rather than silently degrading the maxBlocks bound to the absolute-failsafe cap. D2 found that a
  // single Anvil height-read blip can otherwise falsely abandon a claim after `s` is public, so a bounded run of bad
  // reads is tolerated as no progress; it never moves the anchor/high-water or extends the budget indefinitely.
  let startHeight: number | undefined
  let lastHeight = -1
  let blocksElapsed = 0
  let consecutiveHeightFailures = 0
  const readValidHeight = async (): Promise<{ height?: number; failure?: string }> => {
    let h: number
    try { h = await opts.chainHeight!() }
    catch (e) { return { failure: `0-conf claim-watch: chain-height read failed (fail-closed) — ${msg(e)}` } }
    if (!Number.isSafeInteger(h) || h < 0) return { failure: `0-conf claim-watch: chain-height rail returned a non-safe tip (${h}) — fail-closed` }
    if (h < lastHeight) return { failure: `0-conf claim-watch: chain-height regressed (${lastHeight} → ${h}) — fail-closed (unreliable tip)` }
    lastHeight = h
    return { height: h }
  }
  for (let i = 0; i < opts.maxPolls; i++) {
    let buried: boolean
    try {
      buried = await claimConfirmed()
    } catch (e) {
      throw new Error(`0-conf claim-watch: claim-confirm check failed (fail-closed) — ${msg(e)}`)
    }
    if (buried) return // buried-first WIN — a definitive claim burial, INDEPENDENT of the height rail (review 099868d1 MEDIUM)
    let verdict: ZeroConfVerdict
    try {
      verdict = await lockStatus()
    } catch (e) {
      throw new Error(`0-conf claim-watch: lock status check failed (fail-closed) — ${msg(e)}`)
    }
    if (verdict === 'double-spend') {
      throw new Error('0-conf claim-watch: DOUBLE-SPEND of the BSV lock after reveal — swap under attack, do NOT declare complete')
    }
    if (useBlocks) {
      const heightRead = await readValidHeight() // consulted ONLY after an unburied result (never before the buried-first check)
      if (heightRead.failure) {
        consecutiveHeightFailures += 1
        if (consecutiveHeightFailures > maxHeightFailures) {
          throw new Error(`${heightRead.failure} after ${consecutiveHeightFailures} consecutive bad read(s)`)
        }
        opts.onPoll?.({ poll: i, blocksElapsed })
        if (i < opts.maxPolls - 1) await sleep(opts.sleepMs)
        continue
      }
      consecutiveHeightFailures = 0
      const h = heightRead.height!
      if (startHeight === undefined) startHeight = h // anchor the budget on the FIRST unburied poll
      blocksElapsed = h - startHeight // ≥ 0: readValidHeight rejects any regression below the anchor
      opts.onPoll?.({ poll: i, blocksElapsed })
      if (blocksElapsed >= maxBlocks) {
        throw new Error(`0-conf claim-watch: initiator BSV claim did not bury within ${maxBlocks} new block(s) (fail-closed) — do NOT declare complete`)
      }
    } else {
      opts.onPoll?.({ poll: i, blocksElapsed: 0 })
    }
    if (i < opts.maxPolls - 1) await sleep(opts.sleepMs)
  }
  throw new Error(useBlocks
    ? `0-conf claim-watch: initiator BSV claim did not bury within the absolute failsafe window (${opts.maxPolls} polls; chain may be stalled) — do NOT declare complete`
    : '0-conf claim-watch: initiator BSV claim did not bury within the risk window (fail-closed) — do NOT declare complete')
}
