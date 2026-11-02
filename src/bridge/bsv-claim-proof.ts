import type { ChainTracker, Transaction } from '@bsv/sdk'

/** Header-validated evidence that a particular BSV transaction was mined. */
export interface BsvClaimProof { height: number; root?: string }

/**
 * Fetch and validate the transaction's BEEF proof against the supplied header tracker. A tracker
 * which has not reached the proof header is an ordinary "not proved yet" result. `root` is absent
 * only for legacy test doubles which implement `verify` but not the SDK's `computeRoot`; production
 * MerklePath instances always provide it and only a root-bearing result is suitable for persistence.
 */
export async function proveBsvClaim(
  txid: string,
  rails: { fetchBeef(txid: string): Promise<Transaction | null>; chainTracker: ChainTracker },
): Promise<BsvClaimProof | undefined> {
  const proved = await rails.fetchBeef(txid)
  if (!proved || proved.id('hex').toLowerCase() !== txid.toLowerCase() || !proved.merklePath) return undefined
  try {
    if (!await proved.merklePath.verify(txid, rails.chainTracker)) return undefined
  } catch (error) {
    let trackerTip: number
    try { trackerTip = await rails.chainTracker.currentHeight() }
    catch { return undefined }
    if (trackerTip < proved.merklePath.blockHeight) return undefined
    throw error
  }
  const root = typeof (proved.merklePath as { computeRoot?: (id: string) => unknown }).computeRoot === 'function'
    ? (proved.merklePath as { computeRoot(id: string): unknown }).computeRoot(txid)
    : undefined
  return {
    height: proved.merklePath.blockHeight,
    ...(typeof root === 'string' && /^[0-9a-f]{64}$/i.test(root) ? { root: root.toLowerCase() } : {}),
  }
}
