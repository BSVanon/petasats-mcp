import { Transaction } from '@bsv/sdk'
// ── Types ──
export interface BroadcastResult {
  txid: string
  status: string
  provider: string
}
/** Per-call relay configuration. Present values override process globals for this broadcast only. */
export interface BroadcastOptions {
  taalApiKey?: string | null
  anvilNodeUrl?: string | null
  anvilAuthToken?: string | null
}

export interface TxStatus {
  txid: string
  status: string
  blockHash?: string
  blockHeight?: number
  provider: string
}

// ── Configuration ──

let anvilNodeUrl: string | null = null
let anvilAuthToken: string | null = null
let taalApiKey: string | null = null

export function setAnvilNode(url: string, authToken?: string) {
  anvilNodeUrl = url.replace(/\/$/, '') || null
  anvilAuthToken = authToken || null
}

export function setTaalApiKey(key: string) {
  taalApiKey = key
}

/** Clear a process-level TAAL credential before constructing a keyless client. */
export function clearTaalApiKey() {
  taalApiKey = null
}

// ── Fatal error detection ──

const FATAL_STATUSES = new Set([
  'DOUBLE_SPEND_ATTEMPTED',
  'MISSING_INPUTS',
  // ARC accepts the tx into an orphan mempool but never relays it — the
  // tx references a parent that ARC's view of the chain doesn't have
  // (in practice: a stale wallet basket UTXO that was already spent).
  // Without this entry, ARC returns 200 OK + a txid and the broadcast
  // helper reports fake success while the tx never lands. Surfacing as
  // fatal stops the ladder and preserves the diagnostic verdict. It never
  // authorizes a caller to release a wallet coin: the transaction may be live.
  'SEEN_IN_ORPHAN_MEMPOOL',
])

const FATAL_MESSAGES = [
  'double-spend',
  'already-spent',
  'txn-mempool-conflict',
  'bad-txns-inputs-spent',
  'insufficient funds',
]

function isFatalError(status: string, detail: string): boolean {
  if (FATAL_STATUSES.has(status)) return true
  const lower = detail.toLowerCase()
  return FATAL_MESSAGES.some(msg => lower.includes(msg))
}

// ── Idempotent re-broadcast detection ──

/**
 * Phrasings the providers use when a tx is ALREADY ON CHAIN (mempool or
 * mined). A re-broadcast that hits these is an IDEMPOTENT SUCCESS, not a
 * failure: the common case is the wallet's own `createAction` broadcasting
 * the tx first, then this belt-and-suspenders ladder re-submitting the SAME
 * tx — WoC/Bitails answer "already in the mempool" and ARC "txn-already-known".
 * Treating those as failures made a SUCCESSFUL mint surface a scary
 * "all broadcast providers failed" error (QA, 2026-06-23, test22 was on chain).
 */
const ALREADY_ON_CHAIN_PATTERNS = [
  'already in the mempool',
  'already-in-mempool',
  'already in mempool',
  'txn-already-known',
  'txn-already-in-mempool',
  'already known',
  'transaction already exists',
  'already recorded',
]

function isAlreadyOnChain(msg: string): boolean {
  const lower = msg.toLowerCase()
  return ALREADY_ON_CHAIN_PATTERNS.some((p) => lower.includes(p))
}

/**
 * The ONLY ARC statuses that mean the tx is actually RELAYED to the network — the sole safe grounds to report a
 * broadcast SUCCESS. An ALLOWLIST (not a denylist), because the official ARC status surface is larger than any
 * denylist we'd maintain (UNKNOWN, QUEUED, RECEIVED, STORED, MINED_IN_STALE_BLOCK, REJECTED, INVALID, MALFORMED,
 * SEEN_IN_ORPHAN_MEMPOOL, …): anything NOT explicitly relayed — including an unrecognised/new/absent status — falls
 * through fail-closed rather than fake-succeeding (review MED cycle-1+2, 2026-08-30). Money-critical: a fake success
 * makes bridge-executor mark the refund relayed + stop re-broadcasting a tx that never left ARC. The caller's retry
 * loop re-hits ARC once a not-yet-relayed tx (QUEUED/STORED) moves to SEEN_ON_NETWORK, so the 0-conf path isn't lost.
 */
const ARC_RELAYED = new Set(['ANNOUNCED_TO_NETWORK', 'REQUESTED_BY_NETWORK', 'SENT_TO_NETWORK', 'ACCEPTED_BY_NETWORK', 'SEEN_ON_NETWORK', 'MINED'])
/** An orphan / invalid / malformed signal ANYWHERE in the ARC body rejects the broadcast even if the status looks ok. */
const BAD_ARC_SIGNAL = /orphan|invalid|malformed/i
const isValidTxid = (s: string): boolean => /^[0-9a-f]{64}$/i.test(s)

/**
 * Canonical txid of a raw-tx hex — the success identifier to return when a
 * provider reports "already on chain" (its error body carries no txid then).
 * Returns '' if the hex can't be parsed (caller still treats it as success;
 * the tx is on chain regardless of whether we could re-derive the id).
 */
function txidFromRawTx(rawTx: string): string {
  try {
    return Transaction.fromHex(rawTx).id('hex') as string
  } catch {
    return ''
  }
}

export class FatalBroadcastError extends Error {
  txStatus: string
  competingTxs?: string[]

  constructor(message: string, txStatus: string, competingTxs?: string[]) {
    super(message)
    this.name = 'FatalBroadcastError'
    this.txStatus = txStatus
    this.competingTxs = competingTxs
  }
}

// ── Broadcast ──

async function broadcastViaAnvil(
  rawTx: string,
  atomicBeefHex?: string,
  nodeUrl = anvilNodeUrl,
  authToken = anvilAuthToken,
): Promise<BroadcastResult | null> {
  if (!nodeUrl) return null
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`

    // Anvil validates the BEEF (SPV) and, with ?arc=true, forwards it to miners.
    // BEEF carries the subject tx + its unconfirmed ancestors, so a tx spending a
    // 0-conf parent broadcasts in one shot instead of failing "missing inputs".
    // Anvil requires BEEF — a bare rawTx (no atomicBeefHex) is rejected and falls
    // through to ARC below.
    const res = await fetch(`${nodeUrl}/broadcast?arc=true`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ beef: atomicBeefHex ?? rawTx }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null // 422 = malformed/invalid BEEF → let the ARC tiers try
    const data: any = await res.json()
    
    // status, confidence, stored, mempool, arc:{ submitted, tx_status }, message }.
    // The ARC-level verdict is nested under `arc.tx_status` — a fatal one
    // (double-spend / missing-inputs / orphan mempool) must surface as a
    // FatalBroadcastError, NOT be retried on the lower tiers.
    const arcTxStatus: string = data.arc?.tx_status || ''
    if (isFatalError(arcTxStatus, data.message || '')) {
      throw new FatalBroadcastError(`Anvil: ${arcTxStatus} — ${data.message || 'fatal'}`, arcTxStatus, data.competingTxs)
    }
    // Success = miners genuinely HAVE it (`propagated` = ARC SEEN_ON_NETWORK+). Everything else
    // falls through to the ARC/WoC/Bitails tiers rather than report success for a tx that has NOT
    // been relayed and may never mine: `queued` (ARC accepted pre-SEEN — RECEIVED/STORED, not yet
    // on the wire), `validated-only` (no miner submit), `rejected`. This MIRRORS the ARC tier's
    // RELAYED allowlist — a not-yet-relayed verdict must not fake-succeed and stop the caller
    // re-broadcasting. Accepting `queued` here was that allowlist's un-hardened twin (red-team
    // 2026-08-30, the silent-refund-strand root): Anvil folds ARC RECEIVED/STORED → `queued`, so a
    // never-relayed refund got marked sent and the resolve loop stopped re-broadcasting it.
    if (data.status === 'propagated' && data.txid) {
      return { txid: data.txid, status: data.status, provider: 'Anvil' }
    }
  } catch (e) {
    // A fatal broadcast status must PROPAGATE — don't fall through to ARC
    // and don't report fake success. Only transport/parse errors are
    // swallowed so the orchestrator can still try ARC.
    if (e instanceof FatalBroadcastError) throw e
    // Anvil not reachable — fall through
  }
  return null
}

async function broadcastViaArc(
  rawTx: string,
  atomicBeefHex?: string,
  callTaalApiKey = taalApiKey,
): Promise<BroadcastResult> {
  const providers = [
    { url: 'https://arc.gorillapool.io', name: 'GorillaPool', apiKey: undefined as string | undefined },
    ...(callTaalApiKey ? [{ url: 'https://arc.taal.com', name: 'TAAL', apiKey: callTaalApiKey }] : []),
  ]

  const errors: string[] = []

  for (const provider of providers) {
    try {
      const h: Record<string, string> = { 'Content-Type': 'application/json' }
      if (provider.apiKey) h['Authorization'] = `Bearer ${provider.apiKey}`

      // ARC's rawTx field accepts raw hex, extended format, OR BEEF
      // (auto-detected). Send Atomic BEEF when supplied so a tx spending
      // a 0-conf parent validates against the ancestry carried in the
      // BEEF rather than being rejected for unknown inputs.
      const res = await fetch(`${provider.url}/v1/tx`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ rawTx: atomicBeefHex ?? rawTx }),
        signal: AbortSignal.timeout(30_000),
      })

      const data: any = await res.json()

      if (data.txStatus && isFatalError(data.txStatus, data.detail || '')) {
        throw new FatalBroadcastError(
          `${provider.name}: ${data.txStatus} — ${data.detail || 'fatal'}`,
          data.txStatus,
          data.competingTxs,
        )
      }

      if (!res.ok) {
        // ARC error responses can carry detail in any combination of
        // `title` / `detail` / `extraInfo` / `txStatus`. Prior code
        // only logged `detail` which is generic ("seems to be
        // malformed"). Combine the populated fields so the caller
        // sees what ARC actually objected to.
        const fields = [
          data.txStatus && `status=${data.txStatus}`,
          data.title && `title=${data.title}`,
          data.detail,
          data.extraInfo && `extra=${data.extraInfo}`,
        ].filter(Boolean)
        const summary = fields.length > 0 ? fields.join(' · ') : 'unknown'
        // Already-on-chain → idempotent success, not a failure.
        if (isAlreadyOnChain(summary) || isAlreadyOnChain(JSON.stringify(data))) {
          return {
            txid: data.txid || txidFromRawTx(rawTx),
            status: 'ALREADY_IN_MEMPOOL',
            provider: provider.name,
          }
        }
        errors.push(`${provider.name} ${res.status}: ${summary}`)
        continue
      }

      // FAIL-CLOSED (review MED cycle-1+2, 2026-08-30): a 2xx is NOT relay confirmation. Success requires a REAL txid
      // AND an explicitly-RELAYED status (allowlist), with no orphan/invalid/malformed signal anywhere in the body.
      // Anything else — no/garbage txid, an error-shaped 200, UNKNOWN/QUEUED/STORED/RECEIVED, MINED_IN_STALE_BLOCK,
      // INVALID/MALFORMED, an unrecognised status — falls through (the next provider / WoC / Bitails, or the caller's
      // retry once ARC moves to SEEN_ON_NETWORK). Returning any of those as the txid would make a money caller mark a
      // never-relayed refund as done.
      const arcTxid: string = data.txid ?? ''
      const arcStatus: string = (data.txStatus ?? '').toUpperCase()
      // Idempotent: some ARCs 200 with an already-known-tx body → success with a validated txid.
      if (isAlreadyOnChain(JSON.stringify(data))) {
        return { txid: isValidTxid(arcTxid) ? arcTxid : txidFromRawTx(rawTx), status: 'ALREADY_IN_MEMPOOL', provider: provider.name }
      }
      const bad = BAD_ARC_SIGNAL.test(`${data.txStatus ?? ''} ${data.detail ?? ''} ${data.extraInfo ?? ''} ${data.title ?? ''}`)
      if (!isValidTxid(arcTxid) || !ARC_RELAYED.has(arcStatus) || bad) {
        errors.push(`${provider.name}: 2xx but not relayed (txid='${arcTxid}', status='${arcStatus || 'none'}'${bad ? ', bad-signal' : ''})`)
        continue
      }
      return { txid: arcTxid, status: data.txStatus as string, provider: provider.name }
    } catch (err) {
      if (err instanceof FatalBroadcastError) throw err
      errors.push(`${provider.name}: ${(err as Error).message}`)
    }
  }

  throw new Error(`All ARC providers failed:\n${errors.join('\n')}`)
}

/**
 * WhatsOnChain raw-tx broadcast — non-ARC fallback. No API key
 * required; different network than ARC so it picks up the broadcast
 * even when GorillaPool/TAAL ARC reject for policy reasons. Used
 * after both Anvil + ARC have failed.
 */
async function broadcastViaWoc(rawTx: string): Promise<BroadcastResult> {
  const url = 'https://api.whatsonchain.com/v1/bsv/main/tx/raw'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: rawTx }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    // "already in the mempool" / "txn-already-known" → the tx IS on chain;
    // an idempotent re-broadcast, not a failure. Return success with the
    // canonical txid (WoC's error body carries no txid).
    if (isAlreadyOnChain(text)) {
      return { txid: txidFromRawTx(rawTx), status: 'ALREADY_IN_MEMPOOL', provider: 'WoC' }
    }
    // WoC error bodies are plain text, sometimes JSON-wrapped. Surface
    // raw body so the caller can see what got rejected.
    throw new Error(`WoC ${res.status}: ${text.slice(0, 500)}`)
  }
  // WoC returns the txid as a JSON-quoted string ("<64-hex>") on
  // success. Strip surrounding quotes if present.
  const txid = text.replace(/^"|"$/g, '').trim()
  if (!/^[0-9a-f]{64}$/i.test(txid)) {
    if (isAlreadyOnChain(text)) {
      return { txid: txidFromRawTx(rawTx), status: 'ALREADY_IN_MEMPOOL', provider: 'WoC' }
    }
    throw new Error(`WoC returned non-txid response: ${text.slice(0, 200)}`)
  }
  return { txid, status: 'SEEN_ON_NETWORK', provider: 'WoC' }
}

/**
 * Bitails raw-tx broadcast — second non-ARC fallback. No API key
 * required; independent BSV blockchain explorer with its own relay
 * path. Used after WoC has also failed. Last-resort tier before we
 * declare the tx genuinely unrelayable.
 */
async function broadcastViaBitails(rawTx: string): Promise<BroadcastResult> {
  const url = 'https://api.bitails.io/tx/broadcast'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: rawTx }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    if (isAlreadyOnChain(text)) {
      return { txid: txidFromRawTx(rawTx), status: 'ALREADY_IN_MEMPOOL', provider: 'Bitails' }
    }
    throw new Error(`Bitails ${res.status}: ${text.slice(0, 500)}`)
  }
  // Bitails returns either a bare txid string or a JSON object with
  // `{txid: "..."}`. Handle both shapes defensively.
  let txid: string
  try {
    const parsed = JSON.parse(text)
    txid = typeof parsed === 'string' ? parsed : parsed.txid ?? parsed.id ?? ''
  } catch {
    txid = text.replace(/^"|"$/g, '').trim()
  }
  if (!/^[0-9a-f]{64}$/i.test(txid)) {
    // Bitails reports already-known as a 200 with an error object
    // `{error:{code:-27,message:"already-in-mempool"}}` — that's success.
    if (isAlreadyOnChain(text)) {
      return { txid: txidFromRawTx(rawTx), status: 'ALREADY_IN_MEMPOOL', provider: 'Bitails' }
    }
    throw new Error(`Bitails returned non-txid response: ${text.slice(0, 200)}`)
  }
  return { txid, status: 'SEEN_ON_NETWORK', provider: 'Bitails' }
}

/**
 * Broadcast a raw transaction with five-tier failover:
 *   1. Anvil (local node, if configured)
 *   2. GorillaPool ARC (canonical BSV-21 indexer-aligned)
 *   3. TAAL ARC (if `taalApiKey` set)
 *   4. WhatsOnChain raw-tx (no key)
 *   5. Bitails raw-tx (no key, independent network position)
 *
 * `FatalBroadcastError` (consensus rejection — double-spend, missing
 * inputs) propagates eagerly without trying lower tiers. Those are
 * correctness errors that shouldn't get retried elsewhere.
 *
 * Past five tiers, returns diminish — most additional surfaces are
 * wrappers around the same underlying relay infrastructure. If all
 * five reject, the tx itself is the problem; check the surfaced
 * provider details (status / title / detail / extraInfo per ARC,
 * raw body per WoC/Bitails) for the specific reason.
 *
 * `atomicBeefHex` (optional): when the caller has the tx's Atomic BEEF,
 * the BEEF-capable tiers (Anvil + ARC) submit it instead of the bare
 * raw tx, so a tx spending a 0-conf parent validates against the
 * ancestry carried in the BEEF. WoC + Bitails always get raw (their
 * raw-tx endpoints don't speak BEEF) — they remain a best-effort
 * fallback that only succeeds once the parent confirms. Omit it and
 * every tier behaves exactly as before (raw).
 */
export async function broadcast(
  rawTx: string,
  atomicBeefHex?: string,
  options?: BroadcastOptions,
): Promise<BroadcastResult> {
  const callAnvilNodeUrl = options && 'anvilNodeUrl' in options ? options.anvilNodeUrl ?? null : anvilNodeUrl
  const callTaalApiKey = options && 'taalApiKey' in options ? options.taalApiKey ?? null : taalApiKey
  const callAnvilAuthToken = options && 'anvilAuthToken' in options ? options.anvilAuthToken ?? null : anvilAuthToken
  const anvilResult = await broadcastViaAnvil(rawTx, atomicBeefHex, callAnvilNodeUrl, callAnvilAuthToken)
  if (anvilResult) return anvilResult
  let arcMsg = ''
  let wocMsg = ''
  try {
    return await broadcastViaArc(rawTx, atomicBeefHex, callTaalApiKey)
  } catch (arcErr) {
    if (arcErr instanceof FatalBroadcastError) throw arcErr
    arcMsg = (arcErr as Error).message
  }
  try {
    return await broadcastViaWoc(rawTx)
  } catch (wocErr) {
    wocMsg = `WoC: ${(wocErr as Error).message}`
  }
  try {
    return await broadcastViaBitails(rawTx)
  } catch (bitErr) {
    throw new Error(
      `All broadcast providers failed:\n${arcMsg}\n${wocMsg}\nBitails: ${(bitErr as Error).message}`,
    )
  }
}

// ── Transaction status ──

export async function getTxStatus(txid: string): Promise<TxStatus> {
  // Try Anvil first
  if (anvilNodeUrl) {
    try {
      const headers: Record<string, string> = {}
      if (anvilAuthToken) headers['Authorization'] = `Bearer ${anvilAuthToken}`

      // { txid, txStatus, currentHeight, blockHeight?, confirmations, source }.
      // A 200 from /tx/{txid}/beef does NOT imply mined — Anvil can serve a
      // proof-less BEEF for a mempool tx — so gating MINED on that would report
      // it prematurely (review c4258296). Gate on confirmations / txStatus.
      const res = await fetch(`${anvilNodeUrl}/tx/${txid}/status`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const data: any = await res.json()
        if ((data.confirmations ?? 0) > 0 || data.txStatus === 'MINED') {
          return { txid, status: 'MINED', blockHeight: data.blockHeight, provider: 'Anvil' }
        }
        // Seen but not yet mined — return so `waitForMining` keeps polling.
        return { txid, status: data.txStatus || 'SEEN_ON_NETWORK', provider: 'Anvil' }
      }
    } catch {
      // Fall through
    }
  }

  // WoC fallback
  try {
    const res = await fetch(
      `https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`,
      { signal: AbortSignal.timeout(10_000) },
    )
    if (res.ok) {
      const data: any = await res.json()
      if (data.confirmations > 0) {
        return { txid, status: 'MINED', blockHash: data.blockhash, blockHeight: data.blockheight, provider: 'WhatsOnChain' }
      }
      return { txid, status: 'SEEN_ON_NETWORK', provider: 'WhatsOnChain' }
    }
  } catch {
    // Fall through
  }

  return { txid, status: 'UNKNOWN', provider: 'none' }
}

// ── Multi-provider ARC status (0-conf quorum, seam 4a) ──

/**
 * Query ONE ARC-class status endpoint (`GET /v1/tx/{txid}` — the ARC status query, distinct from the
 * `POST /v1/tx` submit endpoint used by `broadcastViaArc` above) for `getMultiArcTxStatuses` below.
 * Fail-closed PARSE: a 404 (provider hasn't seen this tx yet), any other non-ok response, a
 * thrown/timeout/transport error, or a body missing `txStatus` all collapse to
 * `{ status: 'UNKNOWN', provider }` — this NEVER throws. A parse miss must read as UNKNOWN so the
 * multi-provider quorum (`classifyMultiArc`) can't reach 'accepted' on a provider that didn't
 * actually answer.
 */
export async function fetchArcTxStatus(
  baseUrl: string,
  txid: string,
  provider: string,
  apiKey?: string,
): Promise<{ status: string; provider: string }> {
  try {
    const headers: Record<string, string> = {}
    // TAAL's published ARC example authorizes with the RAW key (`Authorization: <API Key>`), NOT `Bearer <key>`
    // (review 6f461cca MEDIUM). ⚠️ UNVERIFIED against the live TAAL status endpoint — and the broadcast ladder above
    // still sends `Bearer` — so both must be reconciled by a live mainnet status contract check before minArc≥3 is
    // relied upon. GorillaPool (the proven 2nd vantage for minArc=2) needs NO key, so this only affects TAAL.
    if (apiKey) headers['Authorization'] = apiKey
    const res = await fetch(`${baseUrl}/v1/tx/${txid}`, { headers, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { status: 'UNKNOWN', provider } // includes 404 — provider hasn't seen this tx yet
    const data: any = await res.json()
    const status = typeof data.txStatus === 'string' ? data.txStatus.toUpperCase() : ''
    if (!status) return { status: 'UNKNOWN', provider }
    return { status, provider }
  } catch {
    return { status: 'UNKNOWN', provider }
  }
}

/**
 * Multi-provider ARC status fan-out for the full-pilot 0-conf gate (`classifyMultiArc`, minArc ≥ N —
 * seam 4a). Queries the independent ARC-class rails for `txid`'s status IN PARALLEL (`Promise.all` —
 * one slow/stuck provider can't serialize the others) and returns every report:
 *   • Anvil — via the existing `getTxStatus` (already fail-closed / never throws), mapped down to
 *     the `{status, provider}` shape the classifier wants.
 *   • GorillaPool — always queried (`GET /v1/tx/{txid}`, no key required).
 *   • TAAL — queried ONLY when `taalApiKey` is configured (raw-key auth, per TAAL docs; ⚠️ UNVERIFIED live — do not
 *     rely on TAAL / enable minArc≥3 until a live mainnet status contract check confirms its auth + txStatus shape).
 * GorillaPool/TAAL each run through `fetchArcTxStatus` above, which is itself fail-closed — a timeout,
 * non-ok response, or malformed body becomes `{status:'UNKNOWN', provider}` rather than an exception,
 * so ONE provider outage can never abort the whole fetch (this function NEVER throws). Fewer distinct
 * ARC 'accepted' reports simply means `classifyMultiArc` can't reach quorum — fail-closed by
 * construction, never false-safe. Returns 2 reports without a TAAL key configured, 3 with one.
 */
export async function getMultiArcTxStatuses(txid: string): Promise<Array<{ status: string; provider: string }>> {
  const queries: Array<Promise<{ status: string; provider: string }>> = [
    getTxStatus(txid).then((r) => ({ status: r.status, provider: r.provider })),
    fetchArcTxStatus('https://arc.gorillapool.io', txid, 'GorillaPool'),
  ]
  if (taalApiKey) queries.push(fetchArcTxStatus('https://arc.taal.com', txid, 'TAAL', taalApiKey))
  return Promise.all(queries)
}

/**
 * Poll until a transaction is mined or timeout.
 */
export async function waitForMining(
  txid: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<TxStatus> {
  const timeout = opts.timeoutMs ?? 20 * 60_000
  const basePoll = opts.pollMs ?? 30_000
  const start = Date.now()

  const immediate = await getTxStatus(txid)
  if (immediate.status === 'MINED') return immediate

  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, basePoll))
    const status = await getTxStatus(txid)
    if (status.status === 'MINED') return status
  }

  return { txid, status: 'BROADCAST', provider: 'timeout' }
}
