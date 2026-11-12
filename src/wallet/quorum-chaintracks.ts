/**
 * CORROBORATING ChainTracker quorum (seam 4b — the SPV header defense for full pilot).
 *
 * Our thin ChainTracker adapters (`makeAnvilChaintracks`, `makeWocChaintracks`) TRUST a single header source. The 0-conf
 * / confirmed SPV gates verify a lock/claim merkle proof against `isValidRootForHeight(root, height)` — so a compromised
 * or MITM'd single source could serve a forged-difficulty chain and a fake merkle root, and the gate would clear.
 *
 * Why NOT independent full-DAA (difficulty-retarget) validation: (1) neither `@bsv/sdk` nor the canonical
 * `@bsv/wallet-toolbox` does it — the reference BSV SPV stack validates per-header PoW + linkage + most-work, NOT the
 * DAA; and (2) more importantly it does not even CLOSE the threat — an attacker controlling the whole fabricated window
 * can craft a SELF-CONSISTENT low-difficulty chain (low target, ~600s spacing ⇒ DAA-stable) that PASSES a cw-144 recompute.
 * The DAA only checks internal work÷timespan consistency, never that the difficulty matches the REAL network. The only
 * thing that ties difficulty to reality is cumulative-work-vs-the-network (a thin client can't check that) OR a SECOND
 * INDEPENDENT source that reads the real network.
 *
 * So this requires ≥ `minAgree` INDEPENDENT header sources to AGREE that the header at a height carries the claimed
 * merkleRoot before a proof clears — e.g. the OWN Anvil node + WhatsOnChain mainnet. A compromised/MITM'd single source
 * can't forge a proof: the independent source returns the real header and disagrees. FAIL-CLOSED: a disagreement OR an
 * error is a no-confirm; fewer than `minAgree` positive confirmations ⇒ the root is NOT validated ⇒ the reveal is
 * refused (USDC stays watchtower-refundable). Mirrors the minArc≥2 ARC quorum (seam 4a). No consensus code to get wrong.
 *
 * WAIT-AND-RECHECK (opt-in via `deps.recheck`, default OFF): a source that lags the tip or sits in the shallow reorg
 * zone briefly holds a stale/orphan header and rejects an honest root, false-failing an otherwise-settled proof
 * (observed live 2026-09-11). When enabled, a TRANSIENT shortfall is re-queried a bounded number of times before
 * fail-closing — but a disagreement on a block already buried MORE than `shallowReorgDepth` under a source's own tip is
 * a HARD fork/forgery and still fails closed IMMEDIATELY, no retry. The terminal state is always fail-closed; this only
 * forgives lag, never forges agreement. See {@link QuorumChainTrackerDeps.recheck}.
 */
import type { ChainTracker } from '@bsv/sdk'

export interface QuorumChainTrackerDeps {
  /** Operator log for the security-relevant events (a disagreement is a possible forgery/reorg; an error is liveness). */
  log?: (msg: string) => void
  /**
   * WAIT-AND-RECHECK tolerance for a TRANSIENT quorum shortfall — a source that lags the tip or sits in the shallow
   * reorg zone at `height` will briefly hold a stale/orphan header and disagree on an honest root, false-failing an
   * otherwise-settled proof (observed live 2026-09-11: our own Anvil node served a stale tip and rejected a claim's
   * merkle root that HAD settled). Default `maxRechecks: 0` = the strict, immediate fail-closed behavior (unchanged for
   * every existing caller/test). When enabled, a shortfall is re-queried up to `maxRechecks` times with `delayMs`
   * between attempts — giving a lagging source time to catch up — before fail-closing.
   *
   * CRITICAL SAFETY INVARIANT: this NEVER makes a bad root pass. (1) The terminal state after all rechecks is still
   * fail-closed. (2) A disagreeing source that has ALREADY synced MORE than `shallowReorgDepth` blocks PAST `height`
   * and STILL rejects the root is a HARD fork/forgery — waiting can't resolve it — so it fails closed IMMEDIATELY, no
   * retry. Only a shortfall consistent with lag or a ≤`shallowReorgDepth`-deep reorg is ever waited on.
   */
  recheck?: {
    /** Max re-queries after the first shortfall (default 0 = disabled, strict immediate fail-closed). */
    maxRechecks?: number
    /** Delay between rechecks in ms (default 20_000 — a shallow reorg / lag typically resolves within a block). */
    delayMs?: number
    /** A disagreement within this many blocks of a source's own tip is treated as transient; deeper is a hard fork (default 2). */
    shallowReorgDepth?: number
    /** Injectable sleep (tests pass a no-wait stub); defaults to a real setTimeout. */
    sleep?: (ms: number) => Promise<void>
  }
}

export function resolveMakerChainTrackerRecheck(env: Record<string, string | undefined> = process.env): NonNullable<QuorumChainTrackerDeps['recheck']> {
  return {
    maxRechecks: Number(env.MAKER_CHAINTRACK_RECHECKS ?? '8'),
    delayMs: Number(env.MAKER_CHAINTRACK_RECHECK_MS ?? '20000'),
    shallowReorgDepth: Number(env.MAKER_CHAINTRACK_REORG_DEPTH ?? '2'),
  }
}

/**
 * What a source that rejected a root holds at that height. It is read only to classify the rejection, never to confirm:
 * 'different' = a well-formed header for exactly that height whose root differs; 'missing' = no header there (a gap or
 * lag in its index, like an outage); 'match' = it now holds the root (it caught up); 'unknown' = it cannot say.
 */
type RejectionKind = 'different' | 'missing' | 'match' | 'unknown'

async function classifyRejection(tracker: ChainTracker, root: string, height: number): Promise<RejectionKind> {
  try {
    const find = (tracker as { findHeaderForHeight?: unknown }).findHeaderForHeight
    if (typeof find !== 'function') return 'unknown'
    const header = (await find.call(tracker, height)) as { merkleRoot?: unknown; height?: unknown } | undefined | null
    if (header === undefined || header === null) return 'missing'
    if (typeof header.merkleRoot !== 'string' || !/^[0-9a-fA-F]{64}$/.test(header.merkleRoot)) return 'unknown'
    if (header.height !== undefined && Number(header.height) !== height) return 'unknown'
    return header.merkleRoot.toLowerCase() === root.toLowerCase() ? 'match' : 'different'
  } catch {
    return 'unknown'
  }
}

async function tipOf(tracker: ChainTracker): Promise<number | undefined> {
  try {
    const value = await tracker.currentHeight()
    return Number.isSafeInteger(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Read each rejecting source's tip and what it holds at `height`, together. An unreadable tip reads as undefined. */
async function readRejections(trackers: ChainTracker[], idx: number[], root: string, height: number): Promise<Array<{ i: number; tip?: number; kind: RejectionKind }>> {
  return Promise.all(idx.map(async (i) => {
    const [tip, kind] = await Promise.all([tipOf(trackers[i]), classifyRejection(trackers[i], root, height)])
    return { i, tip, kind }
  }))
}

export function makeQuorumChainTracker(trackers: ChainTracker[], minAgree: number, deps: QuorumChainTrackerDeps = {}): ChainTracker {
  if (!Array.isArray(trackers) || trackers.length === 0) throw new Error('makeQuorumChainTracker: at least one ChainTracker is required')
  if (!Number.isInteger(minAgree) || minAgree < 1) throw new Error(`makeQuorumChainTracker: minAgree must be an integer ≥ 1 (got ${minAgree})`)
  if (minAgree > trackers.length) throw new Error(`makeQuorumChainTracker: minAgree ${minAgree} exceeds the ${trackers.length} configured source(s) — an unsatisfiable quorum`)
  const log = deps.log ?? ((): void => {})
  // Sanitize the recheck knobs at the primitive's trust boundary (defense-in-depth vs. a garbage/Infinity/NaN value from
  // ANY caller's env parsing): a non-finite or negative value degrades to the SAFE default — maxRechecks→0 (strict, no
  // loop), delayMs→20s, shallowReorgDepth→2. This forbids `Infinity` (would make the recheck loop non-terminating) and
  // `NaN` (would silently disable the hard-fork classification below), and caps maxRechecks so an operator typo can't
  // hang the money-critical reveal gate.
  const finiteOr = (v: number | undefined, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)
  const maxRechecks = Math.min(50, Math.max(0, Math.trunc(finiteOr(deps.recheck?.maxRechecks, 0))))
  const recheckDelayMs = Math.max(0, finiteOr(deps.recheck?.delayMs, 20_000))
  const shallowReorgDepth = Math.max(0, Math.trunc(finiteOr(deps.recheck?.shallowReorgDepth, 2)))
  const sleep = deps.recheck?.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))

  return {
    isValidRootForHeight: async (root: string, height: number): Promise<boolean> => {
      for (let attempt = 0; ; attempt += 1) {
        const results = await Promise.allSettled(trackers.map((t) => t.isValidRootForHeight(root, height)))
        let confirms = 0
        let disagreements = 0
        let errors = 0
        const disagreeIdx: number[] = []
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            if (r.value === true) confirms += 1
            else { disagreements += 1; disagreeIdx.push(i); log(`chaintrack-quorum: source ${i} DISAGREES on root@${height} — it holds a different header (possible forgery / reorg / lag)`) }
          } else {
            errors += 1
            log(`chaintrack-quorum: source ${i} errored on root@${height} (fail-closed, no-confirm): ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
          }
        })
        if (confirms >= minAgree) {
          if (disagreeIdx.length === 0) return true
          // Enough sources confirm, but another one rejected the root. Only a source that is well past this height
          // (its tip beyond the shallow reorg zone) AND holds a well-formed DIFFERENT header for it is a definitive
          // conflict (a forged proof or a deep reorg): the root then fails closed however many others confirm. A
          // source that is behind, has no header there (a gap in its index), has since caught up, or cannot say is
          // tolerated, like a source that errored.
          const rejections = await readRejections(trackers, disagreeIdx, root, height)
          const conflict = rejections.find((r) => r.kind === 'different' && r.tip !== undefined && r.tip - shallowReorgDepth > height)
          rejections.filter((r) => r.kind === 'missing' && r.tip !== undefined && r.tip - shallowReorgDepth > height).forEach((r) => {
            log(`chaintrack-quorum: source ${r.i} has no header at ${height} though its tip ${r.tip} is past it — a gap in its index, tolerated while ${confirms} source(s) confirm`)
          })
          if (!conflict) return true
          log(`chaintrack-quorum: source ${conflict.i} holds a different header at ${height} and its tip is >${shallowReorgDepth} blocks past it while ${confirms} source(s) confirm — definitive conflict, fail-closed`)
          return false
        }

        // Classify the shortfall: is it a TRANSIENT lag / shallow reorg (wait and recheck) or HARD (fail now)? A
        // disagreeing source that has already synced MORE than `shallowReorgDepth` blocks PAST `height` and still rejects
        // the root can never be reconciled by waiting → fail-closed immediately, no retry — unless it now holds the root
        // (it caught up). A gap in its index at a buried height is HARD too: waiting does not fill it, and a proof that
        // lacks its quorum must not hold a caller (the watchtower's startup checks run one after another) for the whole
        // recheck schedule. A source that cannot say what it holds stays HARD, as before. Only checked when rechecks are
        // enabled (default keeps the strict, immediate fail-closed path byte-identical to before).
        let hardDisagreement = false
        let hardWhy = ''
        if (maxRechecks > 0 && disagreeIdx.length > 0) {
          const rejections = await readRejections(trackers, disagreeIdx, root, height)
          rejections.forEach((r) => {
            if (r.tip === undefined || r.tip - shallowReorgDepth <= height) return
            if (r.kind === 'match') {
              log(`chaintrack-quorum: source ${r.i} rejected root@${height} with its tip ${r.tip} past it, but now holds the root — transient`)
              return
            }
            hardDisagreement = true
            if (r.kind === 'missing') {
              hardWhy ||= 'index gap at a buried height'
              log(`chaintrack-quorum: source ${r.i} has no header at ${height} though its tip ${r.tip} is >${shallowReorgDepth} blocks past it — a gap in its index that waiting will not fill; fail-closed (no retry)`)
              return
            }
            hardWhy = 'deep fork/forgery'
            log(`chaintrack-quorum: source ${r.i} rejects root@${height} though its tip ${r.tip} is >${shallowReorgDepth} blocks past it — HARD fork/forgery, fail-closed (no retry)`)
          })
        }

        const canRetry = maxRechecks > 0 && attempt < maxRechecks && !hardDisagreement
        if (!canRetry) {
          log(`chaintrack-quorum: root@${height} NOT corroborated — ${confirms}/${minAgree} confirmations (${disagreements} disagreed, ${errors} errored)${attempt > 0 ? ` after ${attempt} recheck(s)` : ''}${hardDisagreement ? ` [hard disagreement — ${hardWhy}]` : ''} — REFUSING (fail-closed)`)
          return false
        }
        log(`chaintrack-quorum: root@${height} short ${confirms}/${minAgree} — TRANSIENT (source lag / ≤${shallowReorgDepth}-deep reorg zone); recheck ${attempt + 1}/${maxRechecks} in ${recheckDelayMs}ms`)
        await sleep(recheckDelayMs)
      }
    },
    currentHeight: async (): Promise<number> => {
      const results = await Promise.allSettled(trackers.map((t) => t.currentHeight()))
      const heights = results
        .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled' && Number.isSafeInteger(r.value) && r.value > 0)
        .map((r) => r.value)
      if (heights.length < minAgree) throw new Error(`chaintrack-quorum currentHeight: only ${heights.length}/${minAgree} source(s) returned a height (fail-closed)`)
      // Conservative: the highest height at least two answering sources (or minAgree, if more) have reached. With two
      // sources this is the minimum, as before: a lagging source counts FEWER confirmations, never more. With three,
      // one stale source cannot hold the tip back and one ahead source cannot add confirmations.
      const descending = [...heights].sort((a, b) => b - a)
      return descending[Math.max(minAgree, Math.min(2, descending.length)) - 1]
    },
  }
}
