import { Transaction, type ChainTracker } from '@bsv/sdk'
import type { BridgeInitiatorBsvRails } from '../../../bridge/initiator-executor'
import type { RecoveryBsvRails } from '../../../bridge/in-process-recovery'
import { makeAnvilChaintracks } from '../../../wallet/anvil-chaintracks'
import { makeWocChaintracks } from '../../../wallet/woc-chaintracks'
import { makeQuorumChainTracker } from '../../../wallet/quorum-chaintracks'
import { makeBsvHeightReader } from '../../../wallet/bsv-height'
import { broadcast, clearTaalApiKey, setAnvilNode } from '../../../wallet/broadcast'
import { fetchBeefForTxid, fetchTxHexForTxid } from '../../../wallet/fetch-beef'
import { makeMultiSourceUnspentFetcher } from '../../../wallet/address-utxo-sources'
import type { WocUtxo } from '../../../wallet/reserve-basket-sweep'

export interface BuyerBsvRailsOptions {
  /** Optional public Anvil endpoint. No bearer token is accepted by this API. */
  anvilBaseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** Open read endpoint; authentication is deliberately never configured. */
export const DEFAULT_BUYER_ANVIL_BASE_URL = 'https://anvil.sendbsv.com'

export interface BuyerUnspent extends WocUtxo { confirmations: number }
export type BuyerBsvRails = Pick<BridgeInitiatorBsvRails, 'broadcast' | 'chainHeight' | 'readBsvHeight' | 'txConfirmations' | 'fetchTx' | 'fetchBeef'> &
  Pick<RecoveryBsvRails, 'resolveSpender'> & { chainTracker: ChainTracker; unspentFor(address: string): Promise<BuyerUnspent[]> }

/**
 * Provider-keyless BSV reads and broadcasts.  Existing process-global
 * broadcaster credentials are cleared before this buyer-specific rail is
 * assembled, so its ladder can use only no-key tiers.
 */
export function makeBuyerBsvRails(opts: BuyerBsvRailsOptions = {}): BuyerBsvRails {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 12_000
  const anvilBaseUrl = opts.anvilBaseUrl ?? DEFAULT_BUYER_ANVIL_BASE_URL
  const anvil = makeAnvilChaintracks(anvilBaseUrl, { fetchImpl, timeoutMs })
  const woc = makeWocChaintracks('main', { fetchImpl, timeoutMs })
  // New risk and SPV finality are always two-of-two: own/open Anvil and WoC.
  const chainTracker = makeQuorumChainTracker([anvil as unknown as ChainTracker, woc as unknown as ChainTracker], 2)
  const heights = makeBsvHeightReader([anvil, woc], { env: {} })
  const unspent = makeMultiSourceUnspentFetcher({ fetchImpl, perSourceTimeoutMs: timeoutMs })

  // These are globals in the legacy ladder. Clear both possible inherited
  // credentials before exposing the buyer's broadcast function.
  setAnvilNode(anvilBaseUrl)
  clearTaalApiKey()
  const proofOptions = { fetchImpl, requireProof: true, anvilNodeUrl: anvilBaseUrl }
  const rawOptions = { fetchImpl, anvilNodeUrl: anvilBaseUrl }
  return {
    chainTracker,
    broadcast: async (rawTx: string, atomicBeefHex?: string): Promise<string> => (await broadcast(rawTx, atomicBeefHex, { taalApiKey: null, anvilNodeUrl: anvilBaseUrl, anvilAuthToken: null })).txid,
    chainHeight: (): Promise<number> => heights.readBsvHeight('risk'),
    readBsvHeight: (purpose): Promise<number> => heights.readBsvHeight(purpose),
    txConfirmations: async (txid: string): Promise<number> => {
      try {
        const beef = await fetchBeefForTxid(txid, proofOptions)
        const tx = beef.findAtomicTransaction(txid)
        const h = tx?.merklePath?.blockHeight
        if (typeof h !== 'number' || !Number.isSafeInteger(h) || h <= 0) return 0
        const tip = await heights.readBsvHeight('finality')
        const confirmations = tip - h + 1
        return Number.isSafeInteger(confirmations) && confirmations > 0 ? confirmations : 0
      } catch { return 0 }
    },
    fetchTx: async (txid: string): Promise<Transaction | null> => {
      try { return Transaction.fromHex(await fetchTxHexForTxid(txid, rawOptions)) } catch { return null }
    },
    fetchBeef: async (txid: string): Promise<Transaction | null> => {
      try { return (await fetchBeefForTxid(txid, proofOptions)).findAtomicTransaction(txid) ?? null } catch { return null }
    },
    // WoC is the established exact-outpoint reader. A 404 and a read failure
    // are both non-terminal for recovery, so both conservatively produce null.
    resolveSpender: async (txid: string, vout: number): Promise<string | null> => {
      try {
        const r = await fetchImpl(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/${vout}/spent`, { signal: AbortSignal.timeout(timeoutMs) })
        if (!r.ok) return null
        const body = await r.json() as { txid?: unknown }
        return typeof body.txid === 'string' ? body.txid : null
      } catch { return null }
    },
    unspentFor: async (address: string): Promise<BuyerUnspent[]> => {
      const coins = await unspent(address)
      const tip = await heights.readBsvHeight('finality')
      return coins.map((coin) => ({ ...coin, confirmations: coin.height > 0 && tip > 0 ? Math.max(0, tip - coin.height + 1) : 0 }))
    },
  }
}
