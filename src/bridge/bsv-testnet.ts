import { P2PKH, Transaction } from '@bsv/sdk'
const BSV_NETWORK = (process.env.BSV_NETWORK ?? 'test').trim().toLowerCase()
if (BSV_NETWORK !== 'main' && BSV_NETWORK !== 'test') {
  throw new Error(`BSV_NETWORK must be 'main' or 'test' (got '${process.env.BSV_NETWORK}')`)
}
const WOC = `https://api.whatsonchain.com/v1/bsv/${BSV_NETWORK}`

export interface TestnetFundingUtxo {
  txid: string
  vout: number
  satoshis: number
  /** P2PKH lock hex (derived from the address — network-agnostic script). */
  scriptHex: string
}

async function wocJson(path: string): Promise<unknown> {
  const res = await fetch(`${WOC}${path}`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`WoC-test ${path} → HTTP ${res.status}`)
  return res.json()
}

/** The largest spendable UTXO at a testnet P2PKH address (the funder's coin). */
export async function fetchTestnetFundingUtxo(address: string): Promise<TestnetFundingUtxo> {
  const rows = (await wocJson(`/address/${address}/unspent`)) as Array<{ tx_hash: string; tx_pos: number; value: number; height?: number }>
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`no BSV UTXOs at ${address} — funded yet?`)
  // Prefer CONFIRMED UTXOs (height>0): never chain a new lock on an unconfirmed — possibly stuck — parent
  // (2026-08-21 mainnet fix; carried Leg-A(b)). Fall back to the full set only if nothing is confirmed yet.
  const confirmed = rows.filter((r) => (r.height ?? 0) > 0)
  const pool = (confirmed.length ? confirmed : rows).slice().sort((a, b) => b.value - a.value)
  // Skip any candidate a stuck/unconfirmed tx is ALREADY spending — WoC's /unspent can still list a confirmed
  // UTXO that an unconfirmed (low-fee, stuck) tx spends in the mempool; locking on it is a double-spend that
  // gets rejected. Pick the largest confirmed, un-mempool-spent UTXO. (2026-08-21 mainnet fix; carried Leg-A(b).)
  // FAIL-CLOSED (review 3f290f83 LOW): only select a UTXO whose spent-status was DEFINITIVELY confirmed unspent.
  // WoC `/spent` returns 200 when a spender exists (confirmed OR mempool) and 404 when truly unspent. Any other
  // status — or a network error — is INCONCLUSIVE: we must NOT assume unspent (that risks locking onto a
  // mempool-spent coin = a double-spend reject on mainnet), so skip the candidate and try the next.
  let inconclusive = 0
  for (const u of pool) {
    let status: 'spent' | 'unspent' | 'unknown' = 'unknown'
    try {
      const res = await fetch(`${WOC}/tx/${u.tx_hash}/${u.tx_pos}/spent`, { signal: AbortSignal.timeout(15_000) })
      if (res.status === 200) status = 'spent'
      else if (res.status === 404) status = 'unspent'
      else status = 'unknown' // 429/5xx/etc — not a verified answer
    } catch { status = 'unknown' /* transient — inconclusive, NOT usable */ }
    if (status === 'unspent') {
      return { txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value, scriptHex: new P2PKH().lock(address).toHex() }
    }
    if (status === 'unknown') inconclusive++
  }
  throw new Error(
    `no spendable (confirmed, VERIFIED-un-mempool-spent) UTXO at ${address}` +
    (inconclusive ? ` (${inconclusive} candidate(s) skipped — spent-probe inconclusive; retry when WoC recovers)` : ''),
  )
}

/** Fetch a raw tx (for source attachment when needed). */
export async function fetchTestnetTx(txid: string): Promise<Transaction> {
  const res = await fetch(`${WOC}/tx/${txid}/hex`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`WoC-test tx/${txid}/hex → HTTP ${res.status}`)
  return Transaction.fromHex((await res.text()).trim())
}

/** Broadcast a raw tx to BSV testnet; returns the txid. */
export async function broadcastTestnet(txHex: string): Promise<string> {
  const res = await fetch(`${WOC}/tx/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txhex: txHex }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.text()).trim()
  if (!res.ok) throw new Error(`WoC-test broadcast → HTTP ${res.status}: ${body}`)
  return body.replace(/^"|"$/g, '') // WoC returns the txid as a quoted string
}

/**
 * Confirmations for a tx (0 if unconfirmed/unknown). The BSV-side finality gate: the
 * initiator waits for the BSV lock to reach ≥1 conf before revealing `s`, so it never
 * reveals against a lock that could still be dropped/double-spent out from under it.
 */
export async function fetchTestnetTxConfirmations(txid: string): Promise<number> {
  try {
    const t = (await wocJson(`/tx/hash/${txid}`)) as { confirmations?: number }
    return typeof t.confirmations === 'number' ? t.confirmations : 0
  } catch {
    return 0 // not yet indexed / transient → treat as unconfirmed (fail-closed)
  }
}

/**
 * Is a tx SEEN by the network (in mempool or mined)? The §12.11 0-conf best-effort signal
 * for TESTNET: after a short propagation watch, a still-seen lock hasn't been double-spent out.
 * NOTE: WoC-test gives no double-spend callbacks — MAINNET swaps must use ARC `getTxStatus`
 * (SEEN_ON_NETWORK / DOUBLE_SPEND_ATTEMPTED, via the Anvil rail) for a real double-spend signal.
 */
export async function fetchTestnetTxSeen(txid: string): Promise<boolean> {
  try {
    const t = (await wocJson(`/tx/hash/${txid}`)) as { txid?: string }
    return t?.txid === txid
  } catch {
    return false // 404 / not indexed → treat as not-seen (fail-closed)
  }
}

export interface TestnetChainInfo {
  blocks: number
  /** Median-time-past (what timestamp CLTV compares against). */
  medianTime: number
}

export async function testnetChainInfo(): Promise<TestnetChainInfo> {
  const info = (await wocJson('/chain/info')) as { blocks: number; mediantime: number }
  return { blocks: info.blocks, medianTime: info.mediantime }
}
