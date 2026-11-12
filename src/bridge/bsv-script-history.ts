/** Read-only BSV chain history for a record-derived locking script. */
import { makeWocJsonGetter, type WocJsonClientOpts } from '../wallet/woc-json-client'
import { scriptHashOf } from '../wallet/script-utxo-source'

export interface BsvScriptHistoryReaderOpts extends WocJsonClientOpts {
  chain?: 'main' | 'test'
}

export type BsvScriptHistoryScope = 'confirmed' | 'unconfirmed' | 'all'

interface ScriptHistoryEnvelope {
  script?: unknown
  result?: unknown
  error?: unknown
}

const TXID = /^[0-9a-fA-F]{64}$/

function parseHistory(body: unknown, endpoint: string, expectedScriptHash: string): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`WoC ${endpoint} returned a malformed script-history envelope`)
  }
  const envelope = body as ScriptHistoryEnvelope
  if (typeof envelope.script !== 'string' || envelope.script.toLowerCase() !== expectedScriptHash) {
    throw new Error(`WoC ${endpoint} returned history for a different script`)
  }
  if (typeof envelope.error !== 'string' || envelope.error !== '') {
    throw new Error(`WoC ${endpoint} reported an error: ${String(envelope.error)}`)
  }
  if (!Array.isArray(envelope.result)) throw new Error(`WoC ${endpoint} returned a malformed result list`)
  if (envelope.result.length >= 1_000) {
    throw new Error(`WoC ${endpoint} reached the 1000-row page limit; absence cannot be proven from incomplete history`)
  }
  return envelope.result.map((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`WoC ${endpoint} result[${index}] is malformed`)
    }
    const txid = (row as { tx_hash?: unknown }).tx_hash
    if (typeof txid !== 'string' || !TXID.test(txid)) {
      throw new Error(`WoC ${endpoint} result[${index}] has an invalid tx_hash`)
    }
    return txid.toLowerCase()
  })
}

/**
 * Return every confirmed or unconfirmed transaction reported for an exact locking script. Both histories must be
 * readable: an empty result is authoritative only when neither chain nor mempool has ever carried the script.
 */
export function makeWocScriptHistoryReader(
  opts: BsvScriptHistoryReaderOpts = {},
): (lockingScriptHex: string, signal?: AbortSignal, scope?: BsvScriptHistoryScope) => Promise<string[]> {
  const getJson = makeWocJsonGetter(opts)
  const chain = opts.chain ?? 'main'
  return async (lockingScriptHex: string, signal?: AbortSignal, scope: BsvScriptHistoryScope = 'all'): Promise<string[]> => {
    const scriptHash = scriptHashOf(lockingScriptHex)
    const base = `https://api.whatsonchain.com/v1/bsv/${chain}/script/${scriptHash}`
    const confirmed = scope === 'unconfirmed'
      ? undefined
      : await getJson(`${base}/confirmed/history?limit=1000&order=asc`, { signal })
    const unconfirmed = scope === 'confirmed'
      ? undefined
      : await getJson(`${base}/unconfirmed/history`, { signal })
    return [...new Set([
      ...(confirmed === undefined ? [] : parseHistory(confirmed, 'confirmed script history', scriptHash)),
      ...(unconfirmed === undefined ? [] : parseHistory(unconfirmed, 'unconfirmed script history', scriptHash)),
    ])]
  }
}
