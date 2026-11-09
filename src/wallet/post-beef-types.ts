import type { Beef } from '@bsv/sdk'

/** One requested txid's verdict (subset of the toolbox `PostTxResultForTxid`). */
export interface PostBeefTxidResult {
  txid: string
  status: 'success' | 'error'
  doubleSpend?: boolean
  serviceError?: boolean
  competingTxs?: string[]
}

/** The `PostBeefResult` shape the toolbox expects back from a `PostBeefService`. */
export interface PostBeefResult {
  name: string
  status: 'success' | 'error'
  txidResults: PostBeefTxidResult[]
  data?: object
}

/** A toolbox `PostBeefService`: `(beef, txids) => Promise<PostBeefResult>`. */
export type PostBeefService = (beef: Beef, txids: string[]) => Promise<PostBeefResult>
