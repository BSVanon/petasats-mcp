/**
 * Read-only WhatsOnChain lookups for arbitrary BSV locking scripts.
 *
 * The address reader in `reserve-basket-sweep.ts` is intentionally P2PKH-oriented. Holdings verification also has
 * to cover HTLC/covenant scripts and wallet-toolbox rows whose locking script is derived on demand, so this module
 * reads the universal `/script/{scriptHash}/unspent/all` endpoint (which marks confirmed outputs already spent by a
 * mempool transaction) and can recover a missing script from its creating tx.
 *
 * Both endpoint factories share ONE bounded retry helper, harvested from `makeWocUnspentFetcher`: retry only
 * transient 408/429/5xx and transport failures, use exponential backoff, validate successful bodies strictly, and
 * throw when no authoritative answer is available. It is chain-read-only and never receives a key or wallet handle.
 */
import { Hash, Utils } from '@bsv/sdk'
import type { WocUtxo } from './reserve-basket-sweep'
import { is64HexTxid, isNonNegSafeInt, isObjectRow, isPosSafeInt } from './utxo-row-validation'
import { makeWocJsonGetter, type WocJsonClientOpts } from './woc-json-client'

export interface WocFetchOpts extends WocJsonClientOpts {
  chain?: 'main' | 'test'
}

function parseWocUtxoPage(body: unknown, requestedHash: string): { utxos: WocUtxo[]; nextPageToken?: string } {
  if (!isObjectRow(body)) throw new Error('WoC /script/unspent/all did not return an object')
  if (typeof body.script !== 'string' || body.script.toLowerCase() !== requestedHash.toLowerCase()) {
    throw new Error('WoC /script/unspent/all returned a mismatched script hash')
  }
  if (body.error !== undefined && body.error !== '') throw new Error('WoC /script/unspent/all returned an error')
  if (!Array.isArray(body.result)) throw new Error('WoC /script/unspent/all did not return a result array')
  if (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string') {
    throw new Error('WoC /script/unspent/all returned a malformed nextPageToken')
  }

  const utxos: WocUtxo[] = []
  for (const row of body.result) {
    if (!isObjectRow(row)) throw new Error('WoC /script/unspent/all returned a null/non-object row - refusing (fail-closed)')
    const candidate = row as {
      tx_hash?: unknown; tx_pos?: unknown; value?: unknown; height?: unknown; status?: unknown; isSpentInMempoolTx?: unknown
    }
    if (!is64HexTxid(candidate.tx_hash) || !isNonNegSafeInt(candidate.tx_pos) || !isPosSafeInt(candidate.value)
      || typeof candidate.isSpentInMempoolTx !== 'boolean') {
      throw new Error('WoC /script/unspent/all returned a malformed row - refusing (fail-closed)')
    }
    let height: number
    if (candidate.status === 'confirmed') {
      if (!isPosSafeInt(candidate.height)) throw new Error('WoC /script/unspent/all returned a malformed confirmed row - refusing (fail-closed)')
      height = candidate.height
    } else if (candidate.status === 'unconfirmed') {
      if (candidate.height !== undefined && candidate.height !== 0) {
        throw new Error('WoC /script/unspent/all returned a malformed unconfirmed row - refusing (fail-closed)')
      }
      height = 0
    } else {
      throw new Error('WoC /script/unspent/all returned an unknown row status - refusing (fail-closed)')
    }
    if (!candidate.isSpentInMempoolTx) {
      utxos.push({ tx_hash: candidate.tx_hash, tx_pos: candidate.tx_pos, value: candidate.value, height })
    }
  }
  return { utxos, ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}) }
}

/** WhatsOnChain script hash: SHA-256(script bytes), displayed in reversed byte order. */
export function scriptHashOf(scriptHex: string): string {
  const digest = Hash.sha256(Utils.toArray(scriptHex, 'hex'))
  return Utils.toHex([...digest].reverse()).toLowerCase()
}

/** Build a fail-closed `/script/{scriptHash}/unspent/all` reader for arbitrary BSV locking scripts. */
export function makeWocScriptHashFetcher(opts: WocFetchOpts = {}): (scriptHash: string, signal?: AbortSignal) => Promise<WocUtxo[]> {
  const getJson = makeWocJsonGetter(opts)
  const chain = opts.chain ?? 'main'
  return async (scriptHash: string, signal?: AbortSignal): Promise<WocUtxo[]> => {
    const collected: WocUtxo[] = []
    let token: string | undefined
    for (let page = 0; page < 50; page++) {
      const suffix = token === undefined ? '' : `?token=${encodeURIComponent(token)}`
      const body = await getJson(`https://api.whatsonchain.com/v1/bsv/${chain}/script/${scriptHash}/unspent/all${suffix}`, { signal })
      const parsed = parseWocUtxoPage(body, scriptHash)
      collected.push(...parsed.utxos)
      if (parsed.nextPageToken === undefined) return collected
      token = parsed.nextPageToken
    }
    throw new Error('WoC /script/unspent/all exceeded 50 pages - refusing incomplete result')
  }
}

const isScriptHex = (value: unknown): value is string => typeof value === 'string' && /^(?:[0-9a-fA-F]{2})*$/.test(value)

/**
 * Build a `/tx/hash/{txid}` reader that maps each output index to its locking-script hex. A 404 is authoritative
 * absence and returns `null`; transport ambiguity and malformed successful responses throw (fail closed).
 */
export function makeWocTxOutputScriptFetcher(opts: WocFetchOpts = {}): (txid: string, signal?: AbortSignal) => Promise<Map<number, string> | null> {
  const getJson = makeWocJsonGetter(opts)
  const chain = opts.chain ?? 'main'
  return async (txid: string, signal?: AbortSignal): Promise<Map<number, string> | null> => {
    const body = await getJson(`https://api.whatsonchain.com/v1/bsv/${chain}/tx/hash/${txid}`, { nullOn404: true, signal })
    if (body === null) return null
    if (!isObjectRow(body) || !Array.isArray(body.vout)) {
      throw new Error('WoC /tx/hash did not return a transaction with a vout array')
    }

    const scripts = new Map<number, string>()
    for (let index = 0; index < body.vout.length; index++) {
      const vout = body.vout[index]
      if (!isObjectRow(vout) || !isObjectRow(vout.scriptPubKey) || !isScriptHex(vout.scriptPubKey.hex)) {
        throw new Error('WoC /tx/hash returned a malformed vout script - refusing (fail-closed)')
      }
      scripts.set(index, vout.scriptPubKey.hex.toLowerCase())
    }
    return scripts
  }
}
