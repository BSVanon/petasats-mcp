/** Asset parsing/formatting for the MCP surface — maps agent-friendly strings to the SDK's Asset type. */

import { isErc20, isBsv21, ERC20_ASSETS, type Asset } from 'petasats/sdk'
import { ToolInputError } from './validate.js'

const BSV21_ID = /^[0-9a-f]{64}_\d+$/i

/**
 * Parse an agent-supplied asset string into an SDK Asset:
 *  - `BSV`
 *  - an allowlisted ERC-20 symbol: USDC | USDT | DAI | WETH | cbBTC
 *  - a BSV-21 token: `bsv21:<txid>_<vout>` (or the bare `<txid>_<vout>` genesis id)
 * Fail-closed: anything else throws a ToolInputError (never a silent mis-classification).
 */
export function parseAsset(s: string): Asset {
  const v = s.trim()
  if (v === 'BSV') return 'BSV'
  if (isErc20(v as Asset)) return v as Asset
  if (v.startsWith('bsv21:')) {
    const id = v.slice('bsv21:'.length)
    if (!BSV21_ID.test(id)) throw new ToolInputError(`invalid BSV-21 token id '${id}' — expected <txid>_<vout>`)
    return { bsv21: id }
  }
  if (BSV21_ID.test(v)) return { bsv21: v }
  throw new ToolInputError(`unsupported asset '${s}'. Use BSV, one of [${ERC20_ASSETS.join(', ')}], or bsv21:<txid>_<vout>`)
}

/** Format an SDK Asset back to its canonical agent-facing string. */
export function formatAsset(a: Asset): string {
  return isBsv21(a) ? `bsv21:${a.bsv21}` : a
}

/** The static supported-conversion matrix (what `convert()` can route), for list_liquidity + descriptions. */
export function supportedPairs(): Array<{ pair: string; route: 'bridge' | 'dex'; note: string }> {
  return [{
    pair: 'USDC -> BSV', route: 'bridge' as const,
    note: 'A bound quote and covenant atomic swap through the market maker (Base -> BSV). Keys remain local.',
  }]
}
