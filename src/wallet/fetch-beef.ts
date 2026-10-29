/**
 * Multi-provider BEEF fetch by txid.
 *
 * Returns a BEEF for the given txid suitable for passing as
 * `inputBEEF` to the wallet's `createAction`. Tries providers in
 * order of preference:
 *
 *   1. WhatsOnChain `/v1/bsv/main/tx/{txid}/beef` — returns a BEEF
 *      with full ancestry + Merkle proofs once the tx is mined.
 *   2. WoC `/v1/bsv/main/tx/{txid}/hex` — fallback for mempool txs
 *      that don't yet have a Merkle proof. Builds a single-tx BEEF
 *      (rawTx only). Wallet's `validateRequiredInputs` accepts this
 *      with `trustSelf: 'known'` + `allowTxidOnly` because the rawTx
 *      is structurally complete.
 *   3. GorillaPool ordinals `/api/tx/{txid}/raw` — secondary raw-tx
 *      fallback if WoC is rate-limited or unavailable.
 *
 * Used by the buyer side of OrdLock take + atomic-swap settlement
 * paths where the spending wallet doesn't have the source tx in any
 * of its baskets (the source was emitted by another user's wallet
 * and is only discoverable via overlay/GP indexer).
 *
 * ## requireProof — for callers that ALWAYS spend mined UTXOs
 *
 * AMM swaps + OrdLock takes + MNEE refund/take spend already-mined
 * outpoints. wallet-toolbox-client validates inputBEEF under
 * `trustSelf:'known'` by walking the BEEF's BUMP entries and asking
 * its chainTracker to verify each Merkle root. A BEEF with no BUMP
 * (only `rawTx`, the shape WoC `/hex` and GP `/raw` produce) is
 * rejected with: "The inputBEEF parameter must be valid Beef when
 * factoring options.trustSelf".
 *
 * The 2026-05-08 pilot click-test hit exactly this path: the pool
 * tx was mined (block 948243) but WoC `/beef` rate-limited (429)
 * during the swap attempt. The lib fell through to `/hex` then
 * `/raw`, both proof-less, and the wallet rejected.
 *
 * Pass `{ requireProof: true }` from any caller that knows it's
 * spending a mined UTXO. The helper then:
 *   - Tries proof-bearing sources MULTI-SOURCE (B5, 2026-06-13): the
 *     Anvil node `/tx/{txid}/beef` route FIRST when `anvilNodeUrl` is
 *     supplied (it caches headers + serves BEEF v2 + BUMP), then WoC
 *     `/beef`, then BananaBlocks `/beef` (2026-06-18 — GorillaPool's
 *     same-team API, FREE/240-per-min/CORS-clean, and the ONLY proof
 *     source that serves 1-sat BSV-21 token BEEF, which WoC /beef 404s
 *     on). Any source succeeding unblocks the spend, so a single
 *     indexer rate-limiting (the 2026-05-08 pilot symptom) can no longer
 *     strand a refund/cancel/take — and freshly-minted tokens can now
 *     get the proof-bearing BEEF that `internalizeAction` requires.
 *   - Retries EACH source with backoff on 429 / 5xx / transient network
 *     errors before falling through to the next.
 *   - Throws a clear error (every source's failure surfaced) if no
 *     proof-bearing BEEF can be obtained, rather than silently degrading
 *     to a BEEF the wallet rejects.
 *
 * @throws if all providers fail. Each provider's error is surfaced
 *   in the thrown message so the caller can diagnose.
 */

import { Beef, MerklePath, Transaction, Utils } from '@bsv/sdk'

const WOC_TIMEOUT_MS = 8_000
const GP_TIMEOUT_MS = 8_000

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'
const GP_BASE = 'https://ordinals.gorillapool.io/api'

/**
 * BananaBlocks — GorillaPool's newer same-team BSV data API (FREE,
 * 240 req/min, CORS-clean — reflects the requesting Origin so it works
 * from the browser, and unlike WoC it does NOT drop CORS on 429). Its
 * `/tx/{txid}/beef` route returns proof-bearing BRC-95 AtomicBEEF —
 * crucially INCLUDING for 1-sat BSV-21 token txs that WoC `/beef` 404s
 * on (the gap that left freshly-minted tokens un-internalizable). The
 * SDK's `Beef.fromBinary` parses the AtomicBEEF natively (reads the
 * `01010101` marker + 32-byte atomicTxid prefix, then the inner BEEF).
 */
const BANANABLOCKS_BASE = 'https://bananablocks.com/api/v1'
const BANANABLOCKS_BEEF_TIMEOUT_MS = 12_000

/**
 * Default retry schedule for WoC /beef when `requireProof:true` is
 * set. Three attempts with exponential backoff before giving up.
 * Total worst-case latency: ~1.5s + 2 * timeout. Caller can override
 * via `wocBeefRetries` / `wocBeefRetryDelayMs`.
 */
const WOC_BEEF_DEFAULT_RETRIES = 3
const WOC_BEEF_DEFAULT_RETRY_DELAY_MS = 500
const ANVIL_BEEF_TIMEOUT_MS = 15_000

export interface FetchBeefForTxidOptions {
  /** Inject a custom fetch (tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Override timeouts (ms). */
  wocTimeoutMs?: number
  gorillaPoolTimeoutMs?: number
  /**
   * When `true`, ONLY proof-bearing providers are tried (currently
   * just WoC `/beef`). The proof-less fallbacks (`/hex`, `/raw`) are
   * skipped because they produce a BEEF wallet-toolbox rejects under
   * `trustSelf:'known'`. WoC `/beef` is retried with backoff on
   * transient failures. Pass this from any caller that spends a
   * KNOWN-MINED UTXO (AMM, OrdLock take, MNEE refund/take).
   *
   * Default `false` for backwards compat — OrdLock create / lister
   * paths consume both mined and mempool source txs.
   */
  requireProof?: boolean
  /** Override retry count for WoC /beef when `requireProof:true`. */
  wocBeefRetries?: number
  /** Override retry delay base (ms). Doubles each attempt. */
  wocBeefRetryDelayMs?: number
  /**
   * Anvil node base URL (no trailing slash). When set AND
   * `requireProof:true`, the Anvil node's `/tx/{txid}/beef` route is
   * tried as a FIRST proof-bearing source before WoC (B5, 2026-06-13).
   *
   * This removes the single-point-of-failure that stranded refunds: the
   * proof-bearing BEEF previously came ONLY from WoC `/beef`, so one WoC
   * 429 broke a customer's refund. Anvil already caches headers + serves
   * BEEF v2 with BUMP (the same endpoint `spv-proof-builder` uses), so
   * Anvil OR WoC succeeding is enough. Pass this from refund/cancel/take
   * callers that resolve a node URL.
   */
  anvilNodeUrl?: string
  /** Optional bearer token for the Anvil node BEEF route. */
  anvilAuthToken?: string
  /** Override the Anvil BEEF fetch timeout (ms). */
  anvilTimeoutMs?: number
  /** Override the BananaBlocks BEEF fetch timeout (ms). */
  bananaBlocksTimeoutMs?: number
  /** Observe proof-source and raw-fallback errors without changing fetch behavior. */
  onSourceError?: (source: string, message: string) => void
}

export async function fetchBeefForTxid(
  txid: string,
  opts: FetchBeefForTxidOptions = {},
): Promise<Beef> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (!fetchImpl) {
    throw new Error('fetchBeefForTxid: no fetch implementation available')
  }

  const errors: string[] = []
  const wocTimeoutMs = opts.wocTimeoutMs ?? WOC_TIMEOUT_MS
  const requireProof = opts.requireProof === true

  // ── 1. Proof-bearing source(s) — MULTI-SOURCE when requireProof ──
  // Each source retries transient failures (429 / 5xx / network) with
  // backoff before falling through. Without retry, a single 429 would
  // silently degrade to a proof-less BEEF the wallet rejects (the
  // 2026-05-08 pilot symptom). B5: when an Anvil node URL is supplied we
  // try Anvil FIRST (it caches headers + serves BUMP), then WoC — so one
  // indexer rate-limiting can never strand a customer's refund.
  const retries = requireProof
    ? Math.max(1, opts.wocBeefRetries ?? WOC_BEEF_DEFAULT_RETRIES)
    : 1
  const retryDelayMs = opts.wocBeefRetryDelayMs ?? WOC_BEEF_DEFAULT_RETRY_DELAY_MS

  // Run one proof-bearing source with retry/backoff on transient throws.
  // Returns the Beef on success, or null on 404 / not-proven-here /
  // exhausted retries (caller falls through to the next source).
  const tryProofSource = async (
    label: string,
    fn: () => Promise<Beef | null>,
  ): Promise<Beef | null> => {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await fn()
      } catch (e) {
        const source = `${label}${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`
        const message = (e as Error).message
        errors.push(`${source}: ${message}`)
        try { opts.onSourceError?.(source, message) } catch { /* observers must not affect fetching */ }
        if (attempt < retries - 1) {
          await sleep(retryDelayMs * Math.pow(2, attempt))
          continue
        }
      }
    }
    return null
  }

  // Source 1: Anvil node /beef — tried FIRST whenever a node URL is given
  // (in-CSP, not rate-limited). Returns proof-bearing BEEF for a mined tx
  // and null on 404 / not-yet-proven, so it is safe in BOTH modes: the
  // requireProof:false raw-tx path (fetchTxHexForTxid) gets Anvil-first too,
  // and a mempool source simply falls through to the /hex + /raw fallbacks.
  if (opts.anvilNodeUrl) {
    const anvilBeef = await tryProofSource('Anvil /beef', () =>
      fetchBeefFromAnvil(
        txid,
        opts.anvilNodeUrl!,
        opts.anvilAuthToken,
        fetchImpl,
        opts.anvilTimeoutMs ?? ANVIL_BEEF_TIMEOUT_MS,
      ),
    )
    if (anvilBeef) return anvilBeef
  }

  // Source 2: WoC /beef (the historical proof-bearing source).
  const wocBeef = await tryProofSource('WoC /beef', () =>
    fetchBeefFromWoc(txid, fetchImpl, wocTimeoutMs),
  )
  if (wocBeef) return wocBeef

  // Source 3: BananaBlocks /beef — GorillaPool's same-team data API.
  // Tried AFTER WoC in BOTH modes (it's an unconditional proof source,
  // no node URL required). It closes two gaps WoC leaves open:
  //   (a) 1-sat BSV-21 token txs — WoC /beef 404s on these, so a freshly
  //       minted token could never get a proof-bearing BEEF and stayed
  //       un-internalizable; BananaBlocks serves their full AtomicBEEF.
  //   (b) WoC 429 exhaustion — BananaBlocks (240/min, CORS-clean) covers
  //       the spend instead of stranding a refund/cancel/take.
  // Placed last among proof sources so existing working paths keep WoC
  // as primary; BananaBlocks only activates on WoC's miss/exhaustion.
  const bananaBeef = await tryProofSource('BananaBlocks /beef', () =>
    fetchBeefFromBananaBlocks(
      txid,
      fetchImpl,
      opts.bananaBlocksTimeoutMs ?? BANANABLOCKS_BEEF_TIMEOUT_MS,
    ),
  )
  if (bananaBeef) return bananaBeef

  // requireProof callers know they're spending a mined UTXO. The /hex
  // and /raw fallbacks below produce proof-LESS BEEF that wallet-toolbox
  // rejects under `trustSelf:'known'` — there's no point trying them.
  if (requireProof) {
    throw new Error(
      `fetchBeefForTxid(${txid}): proof-bearing BEEF unavailable from all sources (requireProof:true).\n  ${errors.join('\n  ')}`,
    )
  }

  // ── 2. WoC /hex (mempool fallback — single rawTx, no proofs) ──
  try {
    const beef = await fetchSingleTxBeefFromWoc(txid, fetchImpl, wocTimeoutMs)
    if (beef) return beef
  } catch (e) {
    const source = 'WoC /hex'
    const message = (e as Error).message
    errors.push(`${source}: ${message}`)
    try { opts.onSourceError?.(source, message) } catch { /* observers must not affect fetching */ }
  }

  // ── 3. GP /tx/{txid}/raw (secondary raw-tx fallback) ──
  try {
    const beef = await fetchSingleTxBeefFromGp(txid, fetchImpl, opts.gorillaPoolTimeoutMs ?? GP_TIMEOUT_MS)
    if (beef) return beef
  } catch (e) {
    const source = 'GP /tx/raw'
    const message = (e as Error).message
    errors.push(`${source}: ${message}`)
    try { opts.onSourceError?.(source, message) } catch { /* observers must not affect fetching */ }
  }

  throw new Error(
    `fetchBeefForTxid(${txid}): all providers failed.\n  ${errors.join('\n  ')}`,
  )
}

/**
 * Multi-provider raw-tx HEX fetch by txid — the resilient replacement for
 * the per-hook single-provider `fetch(WoC /hex)` calls (funds-recovery,
 * atomic taker, atomic settle). Reuses `fetchBeefForTxid` (`requireProof:
 * false`) so it inherits the full provider cascade — Anvil `/beef` first
 * (when `anvilNodeUrl` is supplied; in-CSP, not rate-limited), then WoC
 * `/beef`, BananaBlocks `/beef`, WoC `/hex`, GP `/raw` — with retry/backoff.
 * Accepts a mempool (0-conf) source (no proof required) and returns the
 * tx's hex. Fixes the single-provider WoC dependency that stranded the
 * funds-recovery last resort during a WoC outage (Sweep Pass 1, 2026-07-03).
 *
 * @throws if no provider can supply the tx (each provider's error surfaced).
 */
export async function fetchTxHexForTxid(
  txid: string,
  opts: Pick<
    FetchBeefForTxidOptions,
    'fetchImpl' | 'anvilNodeUrl' | 'anvilAuthToken' | 'wocTimeoutMs' | 'gorillaPoolTimeoutMs'
  > = {},
): Promise<string> {
  const beef = await fetchBeefForTxid(txid, { ...opts, requireProof: false })
  const bt = beef.findTxid(txid) as { tx?: Transaction } | null | undefined
  const tx = bt?.tx
  if (!tx) {
    throw new Error(
      `fetchTxHexForTxid(${txid}): a BEEF was returned but carries no tx for this txid`,
    )
  }
  return tx.toHex()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Statuses that mean "this source DETERMINISTICALLY can't/won't serve this
 * tx" — retrying can't change the outcome, so we skip straight to the next
 * source. An explicit allowlist (NOT `status >= 400`), because some 4xx are
 * transient and MUST still retry — see `beefStatusDisposition`.
 *   - 404 — not indexed here (fall through to another source)
 *   - 413 — verified deterministic bananablocks `/beef` refusal (2026-06-22
 *           on 81cac41e, an 897-byte CONFIRMED tx — the provider refusing,
 *           not an oversized payload on our end)
 *   - 414/415/451 — URI-too-long / unsupported-media / unavailable-for-legal:
 *           a malformed-or-blocked request a retry can't fix
 */
const TERMINAL_BEEF_MISS_STATUSES = new Set([404, 413, 414, 415, 451])

/**
 * Classify a non-OK HTTP status from a BEEF/tx endpoint:
 *   - 'miss'  → return null + fall through to the next source WITHOUT
 *               retrying (the `TERMINAL_BEEF_MISS_STATUSES` allowlist).
 *   - 'retry' → EVERYTHING ELSE: 429 (rate limit), 5xx (server), AND the
 *               transient 4xx — notably 408 Request Timeout (and 425 Too
 *               Early) which a proxy can emit and which a retry can clear.
 *               review c4e7e429: the old `status >= 400 → miss` swept 408 into
 *               terminal-miss, so a proxy timeout fell through immediately
 *               instead of backing off + retrying — the opposite of the goal.
 *               Unknown/unexpected statuses also retry (resilience-favoring).
 */
function beefStatusDisposition(status: number): 'miss' | 'retry' {
  return TERMINAL_BEEF_MISS_STATUSES.has(status) ? 'miss' : 'retry'
}

/**
 * True when `beef` carries a Merkle proof (BUMP) for `txid` — i.e. it is
 * genuinely proof-bearing, not a raw-tx-only envelope. Used to reject a
 * source that returns a tx the wallet would refuse under
 * `trustSelf:'known'` (e.g. Anvil serving a still-unmined tx from its
 * mempool with no BUMP yet) so we fall through to the next source.
 */
export function beefHasProofFor(beef: Beef, txid: string): boolean {
  try {
    const bt = beef.findTxid(txid) as { tx?: { merklePath?: MerklePath } } | null | undefined
    if (bt?.tx?.merklePath instanceof MerklePath) return true
    // Otherwise the proof must live in a container-level BUMP whose
    // level-0 leaves actually include THIS txid. A non-empty `bumps`
    // array is NOT sufficient — it may hold proofs for unrelated txs
    // (review fc7ce6b8). Mirror `spv-proof-builder.pickMerklePath`'s
    // txid-leaf scan so we never accept a proof-insufficient BEEF and
    // short-circuit the WoC fallback (which would re-introduce the
    // 'not spendable' class this whole change removes).
    const bumps = (beef as unknown as { bumps?: MerklePath[] }).bumps
    if (Array.isArray(bumps)) {
      for (const bump of bumps) {
        const leaves = bump.path?.[0] ?? []
        for (const leaf of leaves) {
          if (leaf.txid && leaf.hash === txid) return true
        }
      }
    }
    return false
  } catch {
    return false
  }
}

/**
 * Fetch proof-bearing BEEF from an Anvil node's `/tx/{txid}/beef` route
 * (binary BEEF v2 + BUMP). Mirrors `spv-proof-builder`'s Anvil path.
 * Returns null on 404 (tx not on this node yet) so the caller falls
 * through; throws on transient (429/5xx/network) so the retry loop backs
 * off. A response that parses but carries no proof is treated as a miss
 * (return null) — the tx isn't mined-and-proven on this node yet.
 */
async function fetchBeefFromAnvil(
  txid: string,
  anvilNodeUrl: string,
  anvilAuthToken: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Beef | null> {
  const url = `${anvilNodeUrl.replace(/\/$/, '')}/tx/${txid}/beef`
  const headers: Record<string, string> = {}
  if (anvilAuthToken) headers.Authorization = `Bearer ${anvilAuthToken}`
  const res = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    // 404 + terminal client errors → miss + fall through; 429/5xx → throw so
    // the retry loop backs off.
    if (beefStatusDisposition(res.status) === 'miss') return null
    throw new Error(`HTTP ${res.status}`)
  }
  const buf = await res.arrayBuffer()
  const beef = Beef.fromBinary(Array.from(new Uint8Array(buf)))
  if (!beefHasProofFor(beef, txid)) return null // not mined/proven here yet
  return beef
}

/**
 * Fetch proof-bearing BEEF from BananaBlocks' `/tx/{txid}/beef` route.
 * Returns BRC-95 AtomicBEEF (binary, magic `01010101`) which
 * `Beef.fromBinary` parses natively. Returns null on 404 (tx not indexed
 * here yet) so the caller falls through; throws on transient (429/5xx/
 * network) so the retry loop backs off. A response that parses but
 * carries no proof for `txid` is a miss (return null) — the tx isn't
 * mined-and-proven here yet. Same shape + guard as `fetchBeefFromAnvil`.
 */
async function fetchBeefFromBananaBlocks(
  txid: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Beef | null> {
  const url = `${BANANABLOCKS_BASE}/tx/${txid}/beef`
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) {
    // 404 (not indexed here) + terminal client errors (the verified 413 some
    // txs return) → miss + fall through, no retry. 429/5xx → throw so the
    // retry loop backs off.
    if (beefStatusDisposition(res.status) === 'miss') return null
    throw new Error(`HTTP ${res.status}`)
  }
  const buf = await res.arrayBuffer()
  const beef = Beef.fromBinary(Array.from(new Uint8Array(buf)))
  if (!beefHasProofFor(beef, txid)) return null // unmined/unproven here yet
  return beef
}

async function fetchBeefFromWoc(
  txid: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Beef | null> {
  const url = `${WOC_BASE}/tx/${txid}/beef`
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) {
    // 404 (tx not mined yet) + terminal client errors → miss + fall through.
    // 429 (rate limit) + 5xx (server error) are TRANSIENT — throw so the
    // requireProof retry loop can back off + retry, rather than degrading
    // straight to the proof-less fallbacks.
    if (beefStatusDisposition(res.status) === 'miss') return null
    throw new Error(`HTTP ${res.status}`)
  }
  const text = (await res.text()).trim()
  // WoC may return JSON wrapping the BEEF or raw hex; tolerate both.
  let beefHex: string
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'string') beefHex = parsed
    else if (parsed && typeof parsed.beef === 'string') beefHex = parsed.beef
    else throw new Error('unrecognized BEEF response shape')
  } catch {
    beefHex = text
  }
  if (!/^[0-9a-fA-F]+$/.test(beefHex)) {
    throw new Error('response is not hex')
  }
  const beef = Beef.fromBinary(Utils.toArray(beefHex, 'hex') as number[])
  // Parity with fetchBeefFromAnvil / fetchBeefFromBananaBlocks (review 96db4ec7):
  // a proof-LESS WoC /beef must NOT satisfy a proof-bearing fetch. WoC /beef is
  // proof-bearing for MINED txs, but defense-in-depth: if it ever serves a
  // proof-less 200, return null so the caller falls through (and requireProof:true
  // correctly reports "proof-bearing BEEF unavailable" rather than handing the
  // wallet a BEEF it will reject at internalize).
  if (!beefHasProofFor(beef, txid)) return null
  return beef
}

async function fetchSingleTxBeefFromWoc(
  txid: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Beef | null> {
  const url = `${WOC_BASE}/tx/${txid}/hex`
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const text = (await res.text()).trim()
  // WoC's /hex returns either raw hex string or JSON-wrapped string.
  let rawHex: string
  try {
    const parsed = JSON.parse(text)
    rawHex = typeof parsed === 'string' ? parsed : text
  } catch {
    rawHex = text
  }
  if (!/^[0-9a-fA-F]+$/.test(rawHex)) {
    throw new Error('response is not hex')
  }
  return buildSingleTxBeef(rawHex)
}

async function fetchSingleTxBeefFromGp(
  txid: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Beef | null> {
  // GorillaPool's `/api/tx/<txid>/raw` (and `/api/tx/<txid>`) return the
  // raw transaction as binary bytes. Pre-2026-05-08 this called
  // `/api/tx/<txid>/hex` which does NOT exist on GP — every call 404'd
  // and the entire fallback chain failed for newly-broadcast txs that
  // WoC hadn't yet indexed (the exact case the fallback was meant to
  // solve). Server-side curl probe confirmed the right path returns 200
  // with binary even for txs <60s after broadcast.
  const url = `${GP_BASE}/tx/${txid}/raw`
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const buf = await res.arrayBuffer()
  const txBytes = Array.from(new Uint8Array(buf))
  if (txBytes.length < 10) {
    throw new Error('response too short to be a tx')
  }
  return buildSingleTxBeefFromBytes(txBytes)
}

function buildSingleTxBeef(rawHex: string): Beef {
  const tx = Transaction.fromHex(rawHex)
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  return beef
}

function buildSingleTxBeefFromBytes(txBytes: number[]): Beef {
  const tx = Transaction.fromBinary(txBytes)
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  return beef
}
