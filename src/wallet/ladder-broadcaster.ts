/**
 * Ladder-backed toolbox `PostBeefService` — the MAINNET wallet broadcaster (2026-09-08 lock-broadcast fix, review-directed).
 *
 * Provides the wallet-owned `sendWith` broadcast of the HTLC lock. The wallet MUST own this broadcast so its noSend action advances state (the broadcast
 * 0-conf change becomes spendable → swap-to-swap chaining). An EXTERNAL bolt-on (the reverted `withLadderFallback`)
 * relayed the tx but left the wallet action `sending`/maybe-live → a stale reservation, unspendable change, and a
 * `needsAttention` restart (review HIGH). So the fallback lives HERE, INSIDE the lifecycle: run the proven 5-tier ladder
 * (Anvil own-node FIRST → GorillaPool ARC → TAAL ARC → WoC → Bitails) and map its verdict onto the toolbox contract, so
 * `commit()`→`sendWith` both survives a single own-node hiccup AND advances wallet state on a genuine relay.
 *
 * A broadcast RELAYS a fully-SIGNED tx — a third-party miner cannot forge or alter it, only relay or drop it — so the
 * earlier "own-node only, no third-party" mandate was over-strict for the broadcast leg (the refund/claim already use
 * this exact ladder). Anvil stays the PRIMARY tier; the others engage only on Anvil's ambiguous verdict.
 *
 * RESULT CONTRACT (verified against the toolbox mapper — getting this wrong is money-critical in BOTH directions: a
 * false 'success' advances an UNSENT action; a false 'failed' strands a LIVE tx):
 *   ladder returns a BroadcastResult whose txid MATCHES the subject (case-insensitive) → 'success'
 *     → toolbox marks the action SENT ('unproven') → wallet advances state. A GENUINE relay: the ladder's Anvil tier
 *       only returns on `propagated`/known; a `queued`/validated-only falls THROUGH to the next tier (never a false send).
 *   BroadcastResult whose txid is ABSENT or does NOT match the subject → serviceError (review MED: never mark an UNSENT
 *     tx sent on a mismatched/echoed relay response).
 *   >1 txid in the batch → serviceError for ALL (review MED: this service broadcasts ONE subject tx; a batch needs each
 *     txid individually broadcast + verified, never one verdict fanned across siblings).
 *   EVERY FatalBroadcastError → serviceError → action HELD/retryable. A provider saying an input is spent,
 *     conflicting, or unknown does not prove this signed transaction is malformed; it may already be live.
 *   plain Error (EVERY tier ambiguous/transient) → serviceError → RETRYABLE (action NOT failed; the synchronous
 *     `commit()` then aborts the swap on the non-'unproven' send). Ambiguity ALWAYS fails toward serviceError.
 */
import { type Beef, Utils } from '@bsv/sdk'
import { broadcast as broadcastViaLadder, FatalBroadcastError } from './broadcast'
import type { PostBeefService, PostBeefResult, PostBeefTxidResult } from './post-beef-types'

/**
 * Build a 5-tier-ladder-backed `PostBeefService` for mainnet. Injected into the wallet's `postBeefServices` by
 * `applyMainnetAnvilServices`. The ladder's own-node (Anvil) tier is selected via `setAnvilNode` (called at wiring).
 */
export function makeLadderPostBeefService(deps: { broadcast?: typeof broadcastViaLadder, log?: (message: string) => void } = {}): PostBeefService {
  const doBroadcast = deps.broadcast ?? broadcastViaLadder
  const log = deps.log ?? console.error
  return async (beef: Beef, txids: string[]): Promise<PostBeefResult> => {
    if (!Array.isArray(txids) || txids.length === 0) {
      return { name: 'LadderBeef', status: 'error', txidResults: [], data: { error: 'no txids to post' } }
    }
    // MULTI-TX BATCH GUARD (review MED 2026-09-08): this service broadcasts ONE subject tx and would otherwise apply that
    // single verdict to every txid — a false 'success' on an un-broadcast sibling could advance an UNSENT wallet action.
    // The wallet's real use is single-tx (one lock per sendWith); refuse a batch as serviceError (retryable) until each
    // txid is individually broadcast + txid-verified, rather than fabricate a per-tx verdict we never checked.
    if (txids.length > 1) {
      const txidResults: PostBeefTxidResult[] = txids.map((txid) => ({ txid, status: 'error', serviceError: true }))
      return { name: 'LadderBeef', status: 'error', txidResults, data: { error: `multi-tx batch of ${txids.length} unsupported — each txid must be individually broadcast + verified` } }
    }
    const subjectTxid = txids[0] // single-tx commit (the wallet's only real use — mirrors the Anvil service)
    const tx = beef.findAtomicTransaction(subjectTxid)
    if (!tx) {
      // The subject tx isn't in the BEEF → cannot broadcast. RETRYABLE (never a false 'failed' of a maybe-valid tx).
      const txidResults: PostBeefTxidResult[] = txids.map((txid) => ({ txid, status: 'error', serviceError: true }))
      return { name: 'LadderBeef', status: 'error', txidResults, data: { error: `subject tx ${subjectTxid} not in BEEF` } }
    }
    const rawTxHex = tx.toHex()
    let atomicBeefHex: string | undefined
    try { atomicBeefHex = Utils.toHex(beef.toBinaryAtomic(subjectTxid)) } catch { atomicBeefHex = undefined /* all tiers receive raw tx without ancestry */ }

    let verdict: 'success' | 'serviceError'
    let data: object | undefined
    try {
      // ARC accepts BRC-62 BEEF, not Atomic BEEF; the opt-in changes only the bytes the ARC tiers receive.
      const r = await doBroadcast(rawTxHex, atomicBeefHex, { arcAtomicBeefAsBeef: true })
      // TXID-MATCH GUARD (review MED 2026-09-08): mark the action SENT only if the relay we got back is for THIS subject
      // tx. We broadcast rawTxHex (= the subject), so a genuine relay echoes the subject txid; a PRESENT-but-mismatched
      // or ABSENT txid means the response does not confirm OUR tx → serviceError (retryable), never a false 'success'
      // that would advance an UNSENT wallet action. Case-insensitive (review).
      const relayedTxid = (r.txid ?? '').toLowerCase()
      if (relayedTxid && relayedTxid === subjectTxid.toLowerCase()) {
        verdict = 'success' // a tier confirmed a genuine relay OF THIS TX (SEEN_ON_NETWORK / propagated / already-in-mempool)
        data = { provider: r.provider, status: r.status, txid: r.txid }
      } else {
        verdict = 'serviceError' // relay did not confirm the subject txid → hold (retryable), do NOT mark sent
        data = { error: `relay response txid '${r.txid ?? ''}' did not confirm subject ${subjectTxid} — refusing to mark sent`, provider: r.provider, status: r.status }
      }
    } catch (e) {
      if (e instanceof FatalBroadcastError) {
        // A fatal provider verdict stops the ladder, but never releases the wallet input: it says an input is
        // spent, conflicting, or unknown to that provider, and our signed transaction may already be live.
        verdict = 'serviceError'
        data = { fatal: e.message, txStatus: e.txStatus, competingTxs: e.competingTxs }
        log(`[LadderBeef] fatal broadcast verdict held: ${e.message}; txStatus=${e.txStatus}; competingTxs=${JSON.stringify(e.competingTxs ?? [])}`)
      } else {
        // EVERY tier ambiguous/transient (no fatal, no confirmed relay) → retryable; never strand a possibly-live tx.
        verdict = 'serviceError'
        data = { error: e instanceof Error ? e.message : String(e) }
      }
    }

    const txidResults: PostBeefTxidResult[] = txids.map((txid) => {
      switch (verdict) {
        case 'success': return { txid, status: 'success' }
        case 'serviceError': return { txid, status: 'error', serviceError: true }
      }
    })
    const status = txidResults.every((r) => r.status === 'success') ? 'success' : 'error'
    return { name: 'LadderBeef', status, txidResults, data }
  }
}
