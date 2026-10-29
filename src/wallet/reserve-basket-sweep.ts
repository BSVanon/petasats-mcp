import { Beef, P2PKH, type WalletInterface, type WalletOutput } from '@bsv/sdk'
import type { FetchBeef } from '../settlement/htlc/wallet-htlc-lock'
import { is64HexTxid, isNonNegSafeInt, isPosSafeInt, isObjectRow } from './utxo-row-validation'
import { makeWocJsonGetter, type WocJsonClientOpts } from './woc-json-client'
import { listAllActions } from './list-all-actions'
import { makeWocOutpointSpentReader, type WocOutpointSpentReader } from './woc-outpoint-spent'
/** WhatsOnChain `/address/{addr}/unspent` row. `height <= 0` means unconfirmed (mempool-only, no merkle proof yet). */
export interface WocUtxo {
  height: number
  tx_pos: number
  tx_hash: string
  value: number
}
/** Config for {@link makeWocUnspentFetcher}. Every field has a production-safe default; the only one that matters
 *  operationally is `apiKey`. */
export interface WocUnspentFetcherOpts extends WocJsonClientOpts {
  /** Chain segment of the WoC path. Default 'main'. */
  chain?: 'main' | 'test'
}

/**
 * Build a WoC `/address/{addr}/unspent` reader. Returns ONLY currently-unspent coins — the fail-closed liveness the
 * whole sweep design leans on (an already-spent coin simply never appears here). Adds two things the old bare `fetch`
 * lacked: (1) an OPTIONAL `woc-api-key` header (lifts the anon 429 that was starving the reserve reconcile), and
 * (2) a bounded exponential backoff-retry on TRANSIENT failures only (429/408/5xx/network/timeout). It NEVER weakens
 * the fail-closed contract: a permanent error, or a retryable one that outlives `maxAttempts`, still THROWS — so
 * `sweepReserveIntoBasket` returns `error:true`, `reconcileComplete` stays false, and the signer refuses the read
 * rather than serve a stale-low inventory. The returned closure matches the `(address) => Promise<WocUtxo[]>` shape
 * the sweep injects, so it drops straight into `ReserveSweepDeps.fetchWocUnspent`.
 */
export function makeWocUnspentFetcher(opts: WocUnspentFetcherOpts = {}): (address: string) => Promise<WocUtxo[]> {
  const chain = opts.chain ?? 'main'
  const getJson = makeWocJsonGetter(opts)

  return async (address: string): Promise<WocUtxo[]> => {
    const u = await getJson(`https://api.whatsonchain.com/v1/bsv/${chain}/address/${address}/unspent`)
    if (!Array.isArray(u)) throw new Error('WoC /unspent did not return an array')
    // STRICT per-row validation (review HIGH e751b72f): reject the WHOLE response on any malformed row rather than let a
    // missing/garbage value or height be coerced+dropped by the sweep (→ a stale-low inventory stamped "complete").
    // height 0 is LEGITIMATE — WoC returns unconfirmed coins with height 0 and the sweep filters them — so height is
    // non-negative, not strictly positive.
    for (const row of u) {
      if (!isObjectRow(row)) throw new Error('WoC /unspent returned a null/non-object row — refusing (fail-closed)')
      const o = row as { tx_hash?: unknown; tx_pos?: unknown; value?: unknown; height?: unknown }
      if (!is64HexTxid(o.tx_hash) || !isNonNegSafeInt(o.tx_pos) || !isPosSafeInt(o.value) || !isNonNegSafeInt(o.height)) {
        throw new Error('WoC /unspent returned a malformed row — refusing (fail-closed)')
      }
    }
    return u as WocUtxo[]
  }
}

export const fetchWocUnspent: (address: string) => Promise<WocUtxo[]> = makeWocUnspentFetcher()

export interface ReserveUtxo {
  txid: string
  vout: number
  /** The independently-known value (from WoC `/unspent` — NOT the caller's opinion of a settlement fill). */
  value: number
}

export interface InternalizeReserveUtxoDeps {
  wallet: WalletInterface
  fetchBeef: FetchBeef
  /** Exact current-spend reader. New outputs require a clean unspent answer immediately before insertion. */
  outpointSpentReader: WocOutpointSpentReader
  reserveAddress: string
  basket: string
  /** Wallet-action cosmetic labels only (nothing queries/filters by them) — callers may customize for their own
   *  audit trail; default is the autonomous-sweep label. */
  tags?: string[]
  description?: string
  /** Labels on the internalized action. Omit for the established reserve-sweep label. */
  labels?: string[]
}

export const RESERVE_OUTPUT_PAGE_SIZE = 1_000
export const MAX_RESERVE_OUTPUTS = 100_000

/**
 * Read a complete, stable basket snapshot. A first-page-only answer is unsafe for idempotency: an existing output
 * beyond that page would be mistaken for a new coin. If the basket changes while paging, or exceeds the explicit
 * operational bound, fail closed and let the next reconcile retry from page zero.
 */
export async function listAllReserveOutputs(
  wallet: WalletInterface,
  basket: string,
  opts: { includeCustomInstructions?: boolean; maxOutputs?: number } = {},
): Promise<WalletOutput[]> {
  const maxOutputs = opts.maxOutputs ?? MAX_RESERVE_OUTPUTS
  if (!Number.isSafeInteger(maxOutputs) || maxOutputs <= 0) {
    throw new Error(`reserve output scan max must be a positive safe integer (got ${String(maxOutputs)})`)
  }
  const outputs: WalletOutput[] = []
  const outpoints = new Set<string>()
  let expectedTotal: number | undefined
  let offset = 0

  for (;;) {
    const page = await wallet.listOutputs({
      basket,
      limit: RESERVE_OUTPUT_PAGE_SIZE,
      offset,
      ...(opts.includeCustomInstructions ? { includeCustomInstructions: true } : {}),
    })
    if (!Number.isSafeInteger(page.totalOutputs) || page.totalOutputs < 0) {
      throw new Error(`reserve output scan returned invalid totalOutputs=${String(page.totalOutputs)} (fail-closed)`)
    }
    if (page.totalOutputs > maxOutputs) {
      throw new Error(`reserve output scan found ${page.totalOutputs} outputs, exceeding the safe bound ${maxOutputs} (fail-closed; reconcile/prune before retrying)`)
    }
    if (expectedTotal === undefined) expectedTotal = page.totalOutputs
    else if (page.totalOutputs !== expectedTotal) {
      throw new Error(`reserve output basket changed while paging (${expectedTotal} → ${page.totalOutputs}); refusing an incomplete snapshot (fail-closed)`)
    }
    if (offset < expectedTotal && page.outputs.length === 0) {
      throw new Error(`reserve output scan ended early at ${offset}/${expectedTotal} (fail-closed)`)
    }
    for (const output of page.outputs) {
      if (outpoints.has(output.outpoint)) {
        throw new Error(`reserve output scan returned duplicate outpoint ${output.outpoint} across pages (fail-closed)`)
      }
      outpoints.add(output.outpoint)
      outputs.push(output)
      if (outputs.length > maxOutputs) {
        throw new Error(`reserve output scan exceeded the safe bound ${maxOutputs} (fail-closed; reconcile/prune before retrying)`)
      }
    }
    offset += page.outputs.length
    if (offset >= expectedTotal) {
      if (offset !== expectedTotal) {
        throw new Error(`reserve output scan returned ${offset} rows for declared total ${expectedTotal} (fail-closed)`)
      }
      return outputs
    }
  }
}

/**
 * Internalize ONE reserve UTXO into `basket`. Never broadcasts, never moves money — pure wallet-DB awareness.
 * Idempotent: an already-tracked, spendable, right-value outpoint is a no-op (`inserted:false`) unless labels are
 * requested, in which case the toolbox is deliberately called again to merge those labels. Fail-closed
 * (throws) on any poison-guard miss, a missing/unproven subject tx, or an internalize the wallet doesn't confirm.
 */
export async function internalizeReserveUtxo(deps: InternalizeReserveUtxoDeps, utxo: ReserveUtxo): Promise<{ inserted: boolean }> {
  const outpoint = `${utxo.txid}.${utxo.vout}`
  const basket = deps.basket

  // Idempotency FIRST (cheap — no BEEF fetch needed without labels).
  const pre = await listAllReserveOutputs(deps.wallet, basket, { includeCustomInstructions: true })
  const existing = pre.find((o) => o.outpoint === outpoint)
  if (existing) {
    if (existing.satoshis !== utxo.value || !existing.spendable) {
      throw new Error(`${outpoint} already in '${basket}' but INVALID (satoshis=${existing.satoshis}, spendable=${existing.spendable}) — stale/corrupt DB; refusing`)
    }
    if (!deps.labels?.length) return { inserted: false }
  }

  const beef = Beef.fromBinary(await deps.fetchBeef(utxo.txid))
  if (!beef.bumps || beef.bumps.length === 0) throw new Error(`${outpoint}: BEEF for ${utxo.txid} has no merkle bump — cannot SPV-anchor`)
  const stx = beef.findTxid(utxo.txid)?.tx
  if (!stx) throw new Error(`${outpoint}: BEEF for ${utxo.txid} carries no subject tx body`)
  const sout = stx.outputs[utxo.vout]
  if (!sout) throw new Error(`${outpoint}: subject tx has no output at vout ${utxo.vout}`)

  // validation and stores the output spendable regardless — so VERIFY the BEEF's output is EXACTLY the caller's
  // independently-known value (WoC's `/unspent` reading — the SAME source the sweep's liveness leans on) AND
  // EXACTLY P2PKH(reserveAddress), before ever inserting it.
  if (typeof sout.satoshis !== 'number' || sout.satoshis !== utxo.value) {
    throw new Error(`${outpoint}: BEEF output ${String(sout.satoshis)} sat ≠ expected ${utxo.value} sat — refusing (value mismatch, reserve-poison guard)`)
  }
  const p2pkhLockHex = new P2PKH().lock(deps.reserveAddress).toHex()
  if (sout.lockingScript.toHex() !== p2pkhLockHex) {
    throw new Error(`${outpoint}: output script ≠ P2PKH(${deps.reserveAddress}) — refusing (reserve-poison guard)`)
  }

  // BEEF proves historical inclusion, not that this outpoint survived a stale discovery response or a later spend.
  // Keep this final exact read at the shared insertion seam so every new basket insertion has the same proof.
  if (!existing && !await deps.outpointSpentReader.isUnspent(outpoint)) {
    throw new Error(`${outpoint}: chain reports spent — refusing to internalize`)
  }

  const r = await deps.wallet.internalizeAction({
    tx: beef.toBinaryAtomic(utxo.txid),
    outputs: [{ outputIndex: utxo.vout, protocol: 'basket insertion', insertionRemittance: { basket, tags: deps.tags ?? ['reserve-sweep', 'reserve'] } }],
    description: deps.description ?? "maker reserve internalize (autonomous sweep)",
    ...(deps.labels ? { labels: deps.labels } : {}),
  })
  const post = await listAllReserveOutputs(deps.wallet, basket)
  const found = post.find((o) => o.outpoint === outpoint)
  if (!(r.accepted === true && found && found.satoshis === utxo.value && found.spendable)) {
    throw new Error(`${outpoint}: internalize NOT confirmed in basket (accepted=${String(r.accepted)}, present=${!!found}) — refusing`)
  }
  if (deps.labels?.length) {
    const labelled = await listAllActions(deps.wallet, { labels: deps.labels, labelQueryMode: 'any', includeLabels: false, seekPermission: false })
    if (!labelled.some((action) => action.txid === utxo.txid && action.status === 'completed')) {
      throw new Error(`${outpoint}: internalize did not produce a completed action with labels ${deps.labels.join(', ')} — refusing to resolve`)
    }
  }
  return { inserted: !existing }
}

export interface ReserveSweepDeps {
  wallet: WalletInterface
  /** WoC `/unspent` for the reserve address — injected so tests can fake it; production wires `fetchWocUnspent`. */
  fetchWocUnspent: (address: string) => Promise<WocUtxo[]>
  fetchBeef: FetchBeef
  reserveAddress: string
  basket: string
  log?: (tag: string, msg: string) => void
  /** Quarantined lock inputs.  Held coins are chain-unspent but must never be re-internalized as spendable. */
  heldOutpoints?: () => Promise<Set<string>>
  /** Exact current-spend reader. A clean unspent answer is required immediately before a new insertion. */
  outpointSpentReader?: WocOutpointSpentReader
  /** Compatibility injection for attended callers: undefined means unspent; a spender or read error fails closed. */
  resolveSpender?: (outpoint: string) => Promise<string | undefined>
  /** WoC options for the production default exact-spend reader. */
  wocOpts?: WocJsonClientOpts
}

export interface ReserveSweepResult {
  /** Freshly internalized THIS cycle (excludes idempotent already-tracked skips). */
  swept: number
  /** Confirmed unspent UTXOs examined this cycle (0 when the lookup itself failed). */
  total: number
  /** Confirmed UTXOs that FAILED to internalize this cycle (BEEF fetch, missing bump, post-verify miss, corrupt-DB
   *  idempotency refusal, …). review cycle-3 HIGH: WoC `/unspent` for the reserve address returns ONLY P2PKH(reserve)
   *  coins, so a failure here is NOT a benign "poison coin" — it's a genuine, still-unaccounted confirmed reserve
   *  coin. `failed > 0` ⇒ the basket is INCOMPLETE (missing real BSV) → the caller MUST fail the inventory read
   *  closed, or it serves a stale-low number that can drive a redundant restock. */
  failed: number
  /** Confirmed reserve UTXOs deliberately skipped because a quarantined HTLC lock still holds them. */
  held: number
  /** Satoshis represented by {@link held}. */
  heldSats: number
  /** true ⇒ the WoC `/unspent` lookup failed; the cycle was skipped WITHOUT internalizing anything (FAIL-CLOSED —
   *  never trust a partial/errored liveness read; the next cycle tries again). */
  error?: boolean
}

/** A reconcile is COMPLETE only when the WoC lookup succeeded AND every confirmed reserve UTXO internalized. Callers
 *  that need a trustworthy inventory (the fail-closed on-read reconcile) gate on this; the best-effort interval sweep
 *  does not. */
export const reconcileComplete = (r: ReserveSweepResult): boolean => r.error !== true && r.failed === 0

/**
 * One sweep cycle: discover the reserve address's confirmed unspent UTXOs (WoC `/unspent` — no brain input) and
 * internalize any not already tracked. A lookup failure fails the WHOLE cycle closed (`error:true`). A per-UTXO
 * failure no longer aborts the loop — the rest still internalize — BUT it is COUNTED (`failed`) so the caller can
 * treat the cycle as INCOMPLETE and fail an inventory read closed (review cycle-3 HIGH: a silently-skipped confirmed
 * claim → stale-low basket → redundant restock). Never throws.
 */
export async function sweepReserveIntoBasket(deps: ReserveSweepDeps): Promise<ReserveSweepResult> {
  const log = deps.log ?? (() => {})
  const outpointSpentReader = deps.outpointSpentReader ?? (deps.resolveSpender
    ? { isUnspent: async (outpoint: string): Promise<boolean> => (await deps.resolveSpender!(outpoint)) === undefined }
    : makeWocOutpointSpentReader(deps.wocOpts))
  let utxos: WocUtxo[]
  let heldOutpoints: Set<string> | undefined
  try {
    utxos = await deps.fetchWocUnspent(deps.reserveAddress)
  } catch (e) {
    log('sweep', `WoC /unspent read FAILED — skipping this sweep cycle (fail-closed, nothing internalized): ${e instanceof Error ? e.message : String(e)}`)
    return { swept: 0, total: 0, failed: 0, held: 0, heldSats: 0, error: true }
  }
  try {
    heldOutpoints = deps.heldOutpoints ? new Set([...await deps.heldOutpoints()].map((outpoint) => outpoint.toLowerCase())) : undefined
  } catch (e) {
    log('sweep', `held lock input read FAILED — skipping this sweep cycle (fail-closed, nothing internalized): ${e instanceof Error ? e.message : String(e)}`)
    return { swept: 0, total: 0, failed: 0, held: 0, heldSats: 0, error: true }
  }
  // CONFIRMED only (height > 0): an unconfirmed coin has no merkle proof yet — internalizeReserveUtxo would just
  // throw on it every cycle. Skip it here (NOT a `failed` — it's not yet internalizable); the NEXT sweep picks it up
  // once it mines.
  const confirmed = utxos.filter((u) => u.height > 0 && u.value > 0)
  let swept = 0
  let failed = 0
  let held = 0
  let heldSats = 0
  for (const u of confirmed) {
    const outpoint = `${u.tx_hash}.${u.tx_pos}`.toLowerCase()
    if (heldOutpoints?.has(outpoint)) {
      held++
      heldSats += u.value
      log('sweep', `⚠ ${outpoint} is held by a quarantined HTLC lock; resolve with the attended scripts/cancel-stranded-lock.ts`)
      continue
    }
    try {
      const res = await internalizeReserveUtxo(
        { wallet: deps.wallet, fetchBeef: deps.fetchBeef, outpointSpentReader, reserveAddress: deps.reserveAddress, basket: deps.basket },
        { txid: u.tx_hash, vout: u.tx_pos, value: u.value },
      )
      if (res.inserted) { swept++; log('sweep', `internalized ${outpoint} = ${u.value} sat`) }
    } catch (e) {
      // One bad coin no longer aborts the sweep — but it IS a confirmed reserve coin we couldn't account for, so
      // COUNT it: the cycle is incomplete and an on-read inventory MUST fail closed (retried next cycle).
      failed++
      log('sweep', `⚠ ${outpoint} FAILED to internalize (cycle INCOMPLETE → inventory fails closed; retries next sweep): ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { swept, total: confirmed.length, failed, held, heldSats }
}
