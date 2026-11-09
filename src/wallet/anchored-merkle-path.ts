/**
 * Merkle-proof anchoring for the MAINNET agent wallet (doc 20 §B). The toolbox's proof providers (WhatsOnChain,
 * Bitails) build a MerklePath from a TSC proof and the header `Services.hashToHeader` returns, and the toolbox then
 * stores `header.merkleRoot` beside the path without recomputing it. This wraps each provider so a proof reaches the
 * toolbox only if the root it hashes to (BRC-74: the root is always recomputed from the path) equals its header's root
 * at the path's height AND that root is on this agent's own Anvil header chain (BRC-9: proofs link to the verifier's
 * own most-work chain). Anything else becomes a no-proof result carrying an error, so `Services.getMerklePath` moves
 * on to the next provider.
 *
 * Kept out of `anvil-chaintracks.ts` on purpose: importing the toolbox root runs `dotenv.config()` (Setup.js), and the
 * watchtower daemons load the Anvil adapter without the toolbox.
 */
import { sdk } from '@bsv/wallet-toolbox'

/** Reject provider proofs unless their computed root is in this agent's Anvil-backed header chain. */
export function anchorMerklePathService(
  service: sdk.GetMerklePathService,
  tracker: { isValidRootForHeight(root: string, height: number): Promise<boolean> },
): sdk.GetMerklePathService {
  return async (txid, services) => {
    const result = await service(txid, services)
    if (!result.merklePath) return result

    let height: number | undefined
    let root: string | undefined
    try {
      height = result.merklePath.blockHeight
      if (!Number.isSafeInteger(height) || height <= 0) {
        throw new Error(`invalid merkle path block height ${String(height)}`)
      }
      root = result.merklePath.computeRoot(txid)
      if (!result.header || result.header.height !== height || result.header.merkleRoot !== root) {
        throw new Error('merkle path root does not match its header')
      }
      if (await tracker.isValidRootForHeight(root, height) !== true) {
        throw new Error('merkle path root is not on this node\'s header chain')
      }
      return result
    } catch (e) {
      const error = sdk.WalletError.fromUnknown(e)
      return {
        name: result.name,
        notes: [...(result.notes ?? []), {
          what: 'getMerklePathRootNotOnChain',
          name: result.name,
          txid,
          height,
          root,
          reason: e instanceof Error ? e.message : String(e),
        }],
        error,
      }
    }
  }
}
