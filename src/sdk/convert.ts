/** ERC-20 assets the bridge allowlist supports (fail-closed; mirrors src/bridge/evm/token-allowlist). */
export type Erc20Asset = 'USDC' | 'USDT' | 'DAI' | 'WETH' | 'cbBTC'
export const ERC20_ASSETS: readonly Erc20Asset[] = ['USDC', 'USDT', 'DAI', 'WETH', 'cbBTC']
/** A BSV-21 token, identified by its genesis id (`<txid>_<vout>`). */
export interface Bsv21Ref {
  bsv21: string
}
/** A tradeable asset: BSV, an allowlisted Base ERC-20, or a BSV-21 token. */
export type Asset = 'BSV' | Erc20Asset | Bsv21Ref
/** Which mainnet-proven settlement path a pair resolves to. */
export type Route = 'bridge' | 'dex'
export function isErc20(a: Asset): a is Erc20Asset {
  return typeof a === 'string' && (ERC20_ASSETS as readonly string[]).includes(a)
}
export function isBsv(a: Asset): a is 'BSV' {
  return a === 'BSV'
}
export function isBsv21(a: Asset): a is Bsv21Ref {
  return typeof a === 'object' && a !== null && typeof (a as { bsv21?: unknown }).bsv21 === 'string'
}

/** Human label for an asset (for quotes / logs / MCP output). */
export function assetLabel(a: Asset): string {
  if (isBsv21(a)) return `BSV-21:${a.bsv21.slice(0, 12)}…`
  return a
}

/** Strict asset equality (BSV-21 compared by genesis id; a token and a string are never equal). */
export function assetsEqual(a: Asset, b: Asset): boolean {
  if (isBsv21(a) && isBsv21(b)) return a.bsv21 === b.bsv21
  return a === b
}

/**
 * Resolve a pair to its settlement path — FAIL-CLOSED. Supported: ERC-20 ↔ BSV (bridge) and BSV ↔ BSV-21
 * (DEX). Everything else throws: same-asset, ERC-20 ↔ ERC-20, ERC-20 ↔ BSV-21 (no direct route — would be
 * two hops), BSV-21 ↔ BSV-21. Callers get a clear error, never a silent wrong route.
 */
export function resolveRoute(from: Asset, to: Asset): Route {
  if ((isErc20(from) && isBsv(to)) || (isBsv(from) && isErc20(to))) return 'bridge'
  if ((isBsv(from) && isBsv21(to)) || (isBsv21(from) && isBsv(to))) return 'dex'
  const pair = `${assetLabel(from)} → ${assetLabel(to)}`
  if (isErc20(from) && isErc20(to)) throw new Error(`convert: no direct ERC-20↔ERC-20 route (${pair}); bridge each via BSV`)
  if (isBsv21(from) && isBsv21(to)) throw new Error(`convert: no direct BSV-21↔BSV-21 route (${pair}); hop via BSV`)
  if ((isErc20(from) && isBsv21(to)) || (isBsv21(from) && isErc20(to))) throw new Error(`convert: no direct ERC-20↔BSV-21 route (${pair}); hop via BSV`)
  throw new Error(`convert: unsupported pair ${pair}`)
}

/** A non-committal price quote for a pair + amount. */
export interface Quote {
  from: Asset
  to: Asset
  route: Route
  /** Atomic units of `from` the caller sends. */
  amountIn: bigint
  /** Atomic units of `to` the caller receives at this quote. */
  amountOut: bigint
  /** Unix seconds after which the quote is stale. */
  expiry: number
  /** Opaque quote reference the backend recognizes at execute time. */
  quoteId: string
}

export interface ConvertRequest {
  from: Asset
  to: Asset
  /** Atomic units of `from` to convert. */
  amountIn: bigint
  /** Where the `to` asset is delivered — a BSV address or an EVM address, per the output side. */
  deliverTo: string
  /** Optional: settle against a specific prior quote (else the backend re-quotes). */
  quote?: Quote
}

export interface SwapResult {
  ok: boolean
  route: Route
  /**
   * Outcome of a successful `ok:true` result:
   *  - `settled`  — the swap COMPLETED atomically (both legs done): a bridge HTLC claim, or a DEX buy.
   *  - `listed`   — a RESTING ORDER was posted (a DEX sell = an OrdLock listing open to any buyer); value
   *                 changes hands only when someone fills it. `txids.listTxid` is the on-chain order.
   *  - `pending`  — accepted + in-flight (reserved for async settlement that reports back later).
   * Defaults to `settled` when omitted (the completed-swap paths). Additive so callers can branch on it.
   */
  status?: 'settled' | 'listed' | 'pending'
  /** Settlement transaction ids, keyed by leg (e.g. { baseTxid, bsvTxid } or { buyTxid } / { listTxid }). */
  txids: Record<string, string>
  reason?: string
}

/** A settlement path (bridge or DEX). Both are already mainnet-proven; the SDK just routes to them. */
export interface RouteBackend {
  quote(req: Omit<ConvertRequest, 'quote'>): Promise<Quote>
  execute(req: ConvertRequest): Promise<SwapResult>
}

export interface PetaSatsDeps {
  bridge: RouteBackend
  dex: RouteBackend
  now?(): number
}

export interface PetaSats {
  /** Price a conversion without committing. */
  quote(req: Omit<ConvertRequest, 'quote'>): Promise<Quote>
  /** Execute a conversion non-custodially over the resolved settlement path. */
  convert(req: ConvertRequest): Promise<SwapResult>
}

function validateAmount(amountIn: bigint): void {
  if (typeof amountIn !== 'bigint' || amountIn < 1n) throw new Error(`convert: amountIn must be a positive bigint (got ${amountIn})`)
}

/**
 * Build the SDK from injected settlement backends. Routing + validation live here (pure, testable);
 * money lives only in the backends. `quote`/`convert` fail closed on an unsupported pair, a non-positive
 * amount, an expired quote, or a from/to that doesn't match the supplied quote.
 */
export function createPetaSats(deps: PetaSatsDeps): PetaSats {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const backendFor = (route: Route): RouteBackend => (route === 'bridge' ? deps.bridge : deps.dex)

  return {
    async quote(req): Promise<Quote> {
      validateAmount(req.amountIn)
      const route = resolveRoute(req.from, req.to) // throws on unsupported
      return backendFor(route).quote(req)
    },

    async convert(req): Promise<SwapResult> {
      validateAmount(req.amountIn)
      const route = resolveRoute(req.from, req.to)
      if (req.quote) {
        // Fail-closed: a supplied quote must bind to THIS request — route + exact pair (direction) + amountIn.
        // Without this, a same-route quote could be replayed into a different convert() call (wrong direction,
        // wrong asset, or a stale amount), and a backend would trust its amountOut as the counter-amount for
        // economics the user never quoted. Binding here protects every backend at the one public chokepoint.
        if (req.quote.route !== route) throw new Error('convert: supplied quote is for a different route')
        if (!assetsEqual(req.quote.from, req.from) || !assetsEqual(req.quote.to, req.to)) throw new Error('convert: supplied quote is for a different pair')
        if (req.quote.amountIn !== req.amountIn) throw new Error(`convert: supplied quote amountIn ${req.quote.amountIn} ≠ request amountIn ${req.amountIn}`)
        if (req.quote.expiry < now()) throw new Error('convert: supplied quote has expired')
      }
      return backendFor(route).execute(req)
    },
  }
}
