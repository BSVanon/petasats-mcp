/** Exact, fail-closed WhatsOnChain outpoint-spend reader for attended wallet operations. */
import { makeWocJsonGetter, type WocJsonClientOpts } from './woc-json-client'

export interface WocOutpointSpentReader {
  /** true only for WoC's authoritative 404 (no confirmed or mempool spender). */
  isUnspent(outpoint: string): Promise<boolean>
}

export interface WocOutpointSpenderReader extends WocOutpointSpentReader {
  /** The exact spending txid, or null for WoC's 404 (no confirmed or mempool spender known). */
  spender(outpoint: string): Promise<string | null>
}

function parseOutpoint(outpoint: string): { txid: string; vout: number } {
  const [txid, voutText, extra] = outpoint.split('.')
  const vout = Number(voutText)
  if (!/^[0-9a-f]{64}$/i.test(txid ?? '') || extra !== undefined || !Number.isSafeInteger(vout) || vout < 0) {
    throw new Error(`invalid outpoint '${outpoint}'`)
  }
  return { txid, vout }
}

/**
 * WoC `/tx/{txid}/{vout}/spent`: 404 means unspent; 200 must contain the spending txid. The shared JSON getter
 * supplies `woc-api-key`, bounded retries for 429/5xx, and a per-request timeout. Every other response fails closed.
 */
export function makeWocOutpointSpentReader(opts: WocJsonClientOpts & { chain?: 'main' | 'test' } = {}): WocOutpointSpenderReader {
  const getJson = makeWocJsonGetter(opts)
  const chain = opts.chain ?? 'main'
  const spender = async (outpoint: string): Promise<string | null> => {
    const { txid, vout } = parseOutpoint(outpoint)
    const body = await getJson(`https://api.whatsonchain.com/v1/bsv/${chain}/tx/${txid}/${vout}/spent`, { nullOn404: true, requiredStatus: 200 })
    if (body === null) return null
    const spendingTxid = body && typeof body === 'object' && !Array.isArray(body) ? (body as { txid?: unknown }).txid : undefined
    if (typeof spendingTxid !== 'string' || !/^[0-9a-f]{64}$/i.test(spendingTxid)) {
      throw new Error(`WoC /spent returned HTTP 200 without a spending txid for ${outpoint}`)
    }
    return spendingTxid
  }
  return {
    async isUnspent(outpoint: string): Promise<boolean> {
      return (await spender(outpoint)) === null
    },
    spender,
  }
}
