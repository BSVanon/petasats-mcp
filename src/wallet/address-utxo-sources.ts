/**
 * Multi-indexer address→unspent read with per-provider failover + backoff (doc-26 slice-1b).
 *
 * WHY: the reserve reconcile funnelled EVERY `/unspent` read through ONE keyless indexer (WhatsOnChain), so a burst
 * (the reconcile poll + a swap's proof/tx lookups, all at once) tripped WoC's anon 429 and fail-closed the tick (the
 * 2026-09-14 defect). Slice 1 keyed+retried the single WoC read; slice-1b spreads it across INDEPENDENT full indexers
 * so a throttle/outage on one just fails over to the next — no single provider can starve the reconcile. (Anvil is
 * NOT a rung: it is SPV-only with no UTXO set — verified against its route table — so it cannot answer
 * address→unspent; it stays the source for BEEF/merkle-proofs + chain height, elsewhere.)
 *
 * NO API KEY REQUIRED. WhatsOnChain's free tier is KEYLESS (~3 req/s); a key is a PAID upgrade we do not take. At our
 * volume (~1 reserve read / 15s) we are far under the keyless limit, and a burst-429 just fails over — the spread, not
 * a key, is the fix. `apiKey` is an optional passthrough only (unused in production).
 *
 * ADOPTED (reuse-first) from BSVanon's UTXOrder `core/net` (address-sources + provider-client + backoff-state),
 * trimmed for a Node service: dropped the browser CSP/offline-gate/localStorage scaffolding.
 *
 * FAIL-CLOSED, three-valued per leaf: a `WocUtxo[]` (possibly empty) is an AUTHORITATIVE answer; `null` means "this
 * source could not answer" (throttle / unreachable / bad shape / timeout) and is NEVER treated as "no coins". The
 * orchestrator also treats a leaf THROW as a `null` (cool + fail over — a leaf must never crash the reconcile). When
 * NO source can authoritatively answer, it THROWS, so the sweep records `error:true` → the signer's `readInventory`
 * fails closed (HOLD). Same `(address) => Promise<WocUtxo[]>` signature the sweep injects — a drop-in for the
 * single-source reader.
 *
 * WHY FAILOVER, NOT UNION/QUORUM (deliberate, reviewed): a `/unspent` read's value is its "only currently unspent"
 * property. UNIONing across sources would let a LAGGING indexer reintroduce an already-spent coin (over-count);
 * QUORUM would drop a freshly-confirmed coin one source hasn't indexed yet (under-count). Failover trusts ONE
 * authoritative snapshot at a time. Every discovered coin is STILL independently verified before it counts
 * (`internalizeReserveUtxo`: BEEF proves the output was CREATED with the claimed value+P2PKH(reserve)) — but note SPV
 * proves creation, NOT current non-spentness, so we rely on the SOURCE's "only-unspent" guarantee for liveness. That
 * is exactly why only AUTHORITATIVE FULL indexers are sources here (a pruned node — whose stale answer could list a
 * spent coin as unspent — is deliberately NOT a rung). True cross-source corroboration is the doc-26 slice-5
 * three-way drift alarm (chain vs DB vs ledger), not this raw read. `authoritativeForAbsence` gates trusting an EMPTY
 * answer.
 */
import type { WocUtxo } from './reserve-basket-sweep'
import { makeWocUnspentFetcher } from './reserve-basket-sweep'
import { is64HexTxid, isNonNegSafeInt, isPosSafeInt, isObjectRow } from './utxo-row-validation'

// ── Per-provider exponential backoff breaker (in-memory; a long-running daemon needs no cross-restart persistence) ──
const BASE_COOLDOWN_MS = 60_000 // first failure
const MAX_COOLDOWN_MS = 3_600_000 // cap (~6 consecutive failures)
interface BackoffState { consecutiveFails: number; cooldownUntil: number }
const backoff = new Map<string, BackoffState>()
const stateOf = (name: string): BackoffState => backoff.get(name) ?? { consecutiveFails: 0, cooldownUntil: 0 }
/** Cooling ⇒ skip the HTTP call entirely (don't burn a request while a provider is throttled). */
export const isInCooldown = (name: string, now: number = Date.now()): boolean => stateOf(name).cooldownUntil > now
/** A transport failure (429/5xx/network/throw) cools the provider; the cooldown DOUBLES each consecutive failure. */
export const recordProviderFailure = (name: string, now: number = Date.now()): void => {
  const prev = stateOf(name)
  const delay = Math.min(BASE_COOLDOWN_MS * 2 ** prev.consecutiveFails, MAX_COOLDOWN_MS)
  backoff.set(name, { consecutiveFails: prev.consecutiveFails + 1, cooldownUntil: now + delay })
}
/** A success resets the breaker. */
export const recordProviderSuccess = (name: string): void => {
  const prev = stateOf(name)
  if (prev.consecutiveFails !== 0 || prev.cooldownUntil !== 0) backoff.set(name, { consecutiveFails: 0, cooldownUntil: 0 })
}
/** Test helper. */
export const resetAllBackoff = (): void => backoff.clear()

/** One authoritative-or-null address→unspent reader. `authoritativeForAbsence`=false ⇒ a source whose `[]` must not
 *  be trusted as "no coins" (only corroborated). Production ships only authoritative sources. */
export interface AddressUnspentSource {
  name: string
  fetch: (address: string, signal?: AbortSignal) => Promise<WocUtxo[] | null>
  authoritativeForAbsence: boolean
}

export interface MultiSourceOpts {
  /** Optional WhatsOnChain API key (PAID upgrade; production runs keyless). */
  apiKey?: string
  /** Injectable for tests; production uses the global `fetch`. */
  fetchImpl?: typeof fetch
  perSourceTimeoutMs?: number
  /** Override the source set (tests). Production = WoC → BananaBlocks (both authoritative full indexers). */
  sources?: AddressUnspentSource[]
  /** Injectable clock for the backoff breaker (tests). */
  now?: () => number
}

/** Number of default PRODUCTION sources. Exported so the signer's IPC-budget boot assertion is derived from the real
 *  source count and can never silently drift from this array (review RISK 4). */
export const ADDRESS_SOURCE_COUNT = 2

const BANANABLOCKS_BASE = 'https://bananablocks.com/api/v1'

/** GET+JSON through a Node-trimmed "one door". Returns the parsed body, or `{ok:false}` on ANY failure (network /
 *  timeout / non-2xx / bad JSON) — the caller fails closed either way, so there is no need to distinguish reasons
 *  here (the backoff is applied once, in the orchestrator). `signal` is the caller's aggregate deadline; without one
 *  a per-request `timeoutMs` fallback applies. */
async function getJson<T>(url: string, fetchImpl: typeof fetch, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: true; value: T } | { ok: false }> {
  const abort = signal ?? AbortSignal.timeout(timeoutMs)
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: abort })
  } catch {
    return { ok: false } // network / timeout / abort
  }
  if (!res.ok) return { ok: false } // 429 / 5xx / 4xx
  try {
    return { ok: true, value: (await res.json()) as T }
  } catch {
    return { ok: false } // bad JSON
  }
}

/** BananaBlocks (GorillaPool) `address/{a}/utxos` → `{items:[{txid,vout,value,block_height}], cursor, hasMore}`,
 *  paginated. Full indexer (authoritative). Fail-closed null on any transport/shape failure OR if completeness can't
 *  be proven (page cap, or hasMore with no cursor). Threads the aggregate `signal` through EVERY page so the whole
 *  pagination is bounded by one per-source deadline (review RISK 2), and is null-body-safe (review BLOCKER). */
export function makeBananaBlocksSource(fetchImpl: typeof fetch, timeoutMs: number): AddressUnspentSource {
  const MAX_PAGES = 20
  return {
    name: 'bananablocks',
    authoritativeForAbsence: true,
    fetch: async (address, signal) => {
      const out: WocUtxo[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `${BANANABLOCKS_BASE}/address/${address}/utxos` + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')
        const r = await getJson<{ items?: unknown; cursor?: unknown; hasMore?: unknown } | null>(url, fetchImpl, timeoutMs, signal)
        if (!r.ok) return null
        const body = r.value // may be a literal JSON null → guard before ANY property access
        // STRICT, all-or-nothing (review HIGH e751b72f): reject the WHOLE response on any malformed item or pagination
        // field, so a bad row can NEVER be coerced to a value-0/height-0 coin the sweep silently drops while stamping
        // the reconcile "complete" (= a stale-low inventory). BananaBlocks is treated as CONFIRMED-only here: a row
        // lacking a positive block_height fails the source over to WoC (which handles the unconfirmed window).
        if (!body || typeof body !== 'object' || !Array.isArray(body.items) || typeof body.hasMore !== 'boolean') return null
        for (const row of body.items) {
          if (!isObjectRow(row)) return null // a null / primitive element → fail closed, never a property-access throw
          const o = row as { txid?: unknown; vout?: unknown; value?: unknown; block_height?: unknown }
          if (!is64HexTxid(o.txid) || !isNonNegSafeInt(o.vout) || !isPosSafeInt(o.value) || !isPosSafeInt(o.block_height)) return null
          out.push({ tx_hash: o.txid, tx_pos: o.vout, value: o.value, height: o.block_height })
        }
        if (!body.hasMore) return out
        if (typeof body.cursor !== 'string' || body.cursor.length === 0) return null // more pages promised but no cursor → can't complete
        cursor = body.cursor
      }
      return null // exceeded the page cap — completeness not guaranteed
    },
  }
}

/** WoC rung = slice-1's keyed+retry fetcher (keyless in production), wrapped to the source contract: it throws on
 *  failure → map to null. Single attempt inside the chain — a transient WoC blip fails OVER to BananaBlocks rather
 *  than spending a retry budget here. Self-bounded by its own `timeoutMs`. */
export function makeWocSource(apiKey: string | undefined, fetchImpl: typeof fetch, timeoutMs: number): AddressUnspentSource {
  const woc = makeWocUnspentFetcher({ apiKey, fetchImpl, timeoutMs, maxAttempts: 1 })
  return {
    name: 'woc',
    authoritativeForAbsence: true,
    fetch: async (address) => {
      try { return await woc(address) } catch { return null }
    },
  }
}

/**
 * Build a fail-closed multi-source `/unspent` reader with the SAME signature the sweep injects
 * (`(address) => Promise<WocUtxo[]>`). Tries each source in order, skipping any that is cooling; a funded result or an
 * authoritative empty stops immediately; a source failure OR THROW cools it and fails over. If NO source can
 * authoritatively answer, THROWS (fail-closed) so the sweep records `error:true` and the signer holds — never a false
 * "empty reserve".
 */
export function makeMultiSourceUnspentFetcher(opts: MultiSourceOpts = {}): (address: string) => Promise<WocUtxo[]> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.perSourceTimeoutMs ?? 3_000
  const now = opts.now ?? Date.now
  const sources = opts.sources ?? [
    makeWocSource(opts.apiKey, fetchImpl, timeoutMs),
    makeBananaBlocksSource(fetchImpl, timeoutMs),
  ]
  return async (address: string): Promise<WocUtxo[]> => {
    let anyCoolingSkipped = false
    for (const src of sources) {
      if (isInCooldown(src.name, now())) { anyCoolingSkipped = true; continue }
      // ONE aggregate deadline per source — bounds a paginating source across ALL its pages (RISK 2). A leaf THROW is
      // caught and treated exactly like a null transport failure (BLOCKER 1: a leaf must never crash the reconcile).
      let r: WocUtxo[] | null
      try {
        r = await src.fetch(address, AbortSignal.timeout(timeoutMs))
      } catch {
        r = null
      }
      if (r === null) { recordProviderFailure(src.name, now()); continue } // failure/throw → cool + fail over
      recordProviderSuccess(src.name)
      if (r.length > 0) return r // funded → authoritative, stop
      if (src.authoritativeForAbsence) return r // trusted empty → stop
      // non-authoritative empty → keep going to corroborate
    }
    // No source authoritatively answered → FAIL CLOSED (the sweep turns a throw into error:true → signer holds).
    throw new Error(`address /unspent: all ${sources.length} source(s) failed or were cooling${anyCoolingSkipped ? ' (some in backoff cooldown)' : ''} — refusing a possibly-stale reserve read (fail-closed)`)
  }
}
