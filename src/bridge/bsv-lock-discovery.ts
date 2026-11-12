import type { Transaction } from '@bsv/sdk'
import { scriptHashOf } from '../wallet/script-utxo-source'
import type { WocUtxo } from '../wallet/reserve-basket-sweep'
import type { BsvScriptHistoryScope } from './bsv-script-history'

export interface BsvLockFindOptions {
  /** Pre-reveal uniqueness proof: read both confirmed and mempool history now, even if the UTXO index is empty. */
  forceHistory?: boolean
}

export interface BsvLockByScriptFinderDeps {
  /** Canonical exact-script UTXO index. Throws when no authoritative answer is available. */
  readScriptUnspent(scriptHash: string, signal?: AbortSignal): Promise<WocUtxo[]>
  /** Canonical confirmed + mempool exact-script history, used when the UTXO endpoint misses or fails. */
  readScriptHistory(lockingScriptHex: string, signal?: AbortSignal, scope?: BsvScriptHistoryScope): Promise<string[]>
  /** Existing multi-source raw transaction/BEEF discovery ladder. */
  fetchTx(txid: string, signal?: AbortSignal): Promise<Transaction | null>
  /** Operational note for a script-index candidate which is not the negotiated output tuple. */
  log?(message: string): void
  nowMs?(): number
}

export interface BsvLockByScriptFinder {
  (lockingScriptHex: string, expectedSatoshis: number, signal?: AbortSignal, opts?: BsvLockFindOptions): Promise<Transaction | null>
  /** End the negotiated tuple's multi-poll observation and release its cached ambiguity state. */
  release(lockingScriptHex: string, expectedSatoshis: number): void
}

export const MAX_IDLE_BSV_LOCK_TUPLES = 512
export const BSV_LOCK_TUPLE_EVICTION_AGE_MS = 24 * 60 * 60_000

/** A positive observation of multiple qualifying locks is a safety conflict, not an indexer outage. */
export class AmbiguousBsvLockError extends Error {
  constructor(matches: number) {
    super(`BSV exact-script discovery is ambiguous: ${matches} transactions pay the negotiated script and satoshis at output 0`)
    this.name = 'AmbiguousBsvLockError'
  }
}

/**
 * Find the one transaction whose output 0 carries the exact negotiated locking script and satoshis.
 *
 * The script UTXO endpoint is the fast path. Exact-script history is its bounded endpoint failover, and the returned
 * transaction is independently fetched and byte-checked before it can be named to the initiator executor. A script
 * match at another output or with another amount is merely unrelated chain activity: it is ignored and logged once per
 * txid. Multiple qualifying transactions are ambiguous: the caller must never guess which responder lock to claim.
 */
export function makeBsvLockByScriptFinder(
  deps: BsvLockByScriptFinderDeps,
): BsvLockByScriptFinder {
  interface TupleState {
    ignoredTxids: Set<string>
    qualifying: Map<string, Transaction>
    cycle: number
    nextHistoryScope: Exclude<BsvScriptHistoryScope, 'all'>
    activeReads: number
    lastReadMs: number
    released: boolean
    cacheable: boolean
  }
  // leaking a prior swap's candidates into a different script/amount tuple.
  const tupleStates = new Map<string, TupleState>()
  const log = deps.log ?? console.warn
  const nowMs = deps.nowMs ?? Date.now
  const evictIdle = (reserveSlot = false): boolean => {
    let idleCount = [...tupleStates.values()].filter((state) => state.activeReads === 0).length
    const limit = reserveSlot ? MAX_IDLE_BSV_LOCK_TUPLES - 1 : MAX_IDLE_BSV_LOCK_TUPLES
    if (idleCount <= limit) return true
    const cutoff = nowMs() - BSV_LOCK_TUPLE_EVICTION_AGE_MS
    const eligible = [...tupleStates.entries()]
      .filter(([, state]) => state.activeReads === 0 && state.lastReadMs <= cutoff)
      .sort((a, b) => a[1].lastReadMs - b[1].lastReadMs)
    for (const [key] of eligible) {
      if (idleCount <= limit) break
      tupleStates.delete(key)
      idleCount -= 1
      log(`BSV exact-script discovery evicted idle tuple ${key} (least-recently-used backstop)`)
    }
    return idleCount <= limit
  }
  const finder = async (lockingScriptHex: string, expectedSatoshis: number, signal?: AbortSignal, opts: BsvLockFindOptions = {}): Promise<Transaction | null> => {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(expectedSatoshis) || expectedSatoshis < 1) {
      throw new Error(`BSV exact-script discovery expectedSatoshis must be a positive safe integer (got ${String(expectedSatoshis)})`)
    }
    const expectedScript = lockingScriptHex.toLowerCase()
    const tupleKey = `${expectedScript}:${expectedSatoshis}`
    let state = tupleStates.get(tupleKey)
    if (!state) {
      const cacheable = evictIdle(true)
      state = { ignoredTxids: new Set(), qualifying: new Map(), cycle: 0, nextHistoryScope: 'confirmed', activeReads: 0, lastReadMs: nowMs(), released: false, cacheable }
      tupleStates.set(tupleKey, state)
    }
    state.activeReads += 1
    state.lastReadMs = nowMs()
    state.released = false
    try {
    const scriptHash = scriptHashOf(expectedScript)
    const candidateTxids = new Set<string>()
    const sourceErrors: string[] = []

    state.cycle += 1
    if (opts.forceHistory) {
      try {
        for (const txid of await deps.readScriptHistory(expectedScript, signal, 'all')) candidateTxids.add(txid.toLowerCase())
      } catch (error) {
        sourceErrors.push(`script-history: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (state.cycle % 5 === 0) {
      // An empty discovery cycle performs ONE physical script-index request. Every fifth cycle substitutes one of the
      // two history endpoints for the UTXO endpoint; alternating the scopes eventually covers already-spent locks
      // without tripling the steady-state request rate.
      const scope = state.nextHistoryScope
      state.nextHistoryScope = scope === 'confirmed' ? 'unconfirmed' : 'confirmed'
      try {
        for (const txid of await deps.readScriptHistory(expectedScript, signal, scope)) candidateTxids.add(txid.toLowerCase())
        // Once one history endpoint reports activity, complete the other half now so a second qualifying lock cannot
        // hide behind the cadence. This is no longer an empty cycle.
        if (candidateTxids.size > 0) {
          const other = scope === 'confirmed' ? 'unconfirmed' : 'confirmed'
          for (const txid of await deps.readScriptHistory(expectedScript, signal, other)) candidateTxids.add(txid.toLowerCase())
        }
      } catch (error) {
        sourceErrors.push(`script-history: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      try {
        for (const row of await deps.readScriptUnspent(scriptHash, signal)) candidateTxids.add(row.tx_hash.toLowerCase())
        // A live hit makes uniqueness money-critical. History includes a same-script lock which was already spent and
        // therefore disappeared from the UTXO endpoint; read both histories before accepting the hit.
        if (candidateTxids.size > 0) {
          for (const txid of await deps.readScriptHistory(expectedScript, signal, 'all')) candidateTxids.add(txid.toLowerCase())
        }
      } catch (error) {
        sourceErrors.push(`script-unspent: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    signal?.throwIfAborted()
    if (candidateTxids.size === 0) {
      if (sourceErrors.length > 0) throw new Error(`BSV exact-script indexer unavailable: ${sourceErrors.join('; ')}`)
      if (state.qualifying.size > 1) throw new AmbiguousBsvLockError(state.qualifying.size)
      return state.qualifying.values().next().value ?? null
    }
    if (sourceErrors.length > 0) throw new Error(`BSV exact-script indexer unavailable: ${sourceErrors.join('; ')}`)

    const matches: Transaction[] = []
    let fetchFailed = false
    for (const txid of candidateTxids) {
      signal?.throwIfAborted()
      let tx: Transaction | null
      try {
        tx = await deps.fetchTx(txid, signal)
      } catch {
        fetchFailed = true
        continue
      }
      if (!tx) { fetchFailed = true; continue }
      if (tx.id('hex').toLowerCase() !== txid) {
        throw new Error(`BSV exact-script transaction lookup returned ${tx.id('hex')} for requested ${txid}`)
      }
      const out0 = tx.outputs[0]
      if (out0?.lockingScript?.toHex().toLowerCase() === expectedScript && out0.satoshis === expectedSatoshis) {
        matches.push(tx)
        state.qualifying.set(tx.id('hex').toLowerCase(), tx)
        continue
      }
      if (!state.ignoredTxids.has(txid)) {
        state.ignoredTxids.add(txid)
        const reason = !out0
          ? 'has no output 0'
          : out0.lockingScript?.toHex().toLowerCase() !== expectedScript
            ? 'does not carry the negotiated script at output 0'
            : `carries ${String(out0.satoshis)} sat at output 0 instead of ${String(expectedSatoshis)}`
        log(`BSV exact-script discovery ignored non-qualifying transaction ${txid}: ${reason}`)
      }
    }

    signal?.throwIfAborted()
    if (state.qualifying.size > 1) throw new AmbiguousBsvLockError(state.qualifying.size)
    if (fetchFailed) throw new Error('BSV exact-script history found activity but the transaction lookup layer failed')
    if (matches.length === 1) return matches[0]
    return state.qualifying.values().next().value ?? null
    } finally {
      state.activeReads -= 1
      state.lastReadMs = nowMs()
      if ((state.released || !state.cacheable) && state.activeReads === 0) tupleStates.delete(tupleKey)
      else evictIdle()
    }
  }
  finder.release = (lockingScriptHex: string, expectedSatoshis: number): void => {
    const key = `${lockingScriptHex.toLowerCase()}:${expectedSatoshis}`
    const state = tupleStates.get(key)
    if (!state) return
    state.released = true
    if (state.activeReads === 0) tupleStates.delete(key)
  }
  return finder
}
