/**
 * WhatsOnChain-backed `ChaintracksClientApi` adapter — the TESTNET chaintracker for the canonical build/test phase
 * (doc 20). The toolbox's `Services.getChainTracker()` wraps a `ChaintracksClientApi` in a `ChaintracksChainTracker`,
 * which — verified in the installed `@bsv/wallet-toolbox` — calls ONLY two methods on it:
 *   currentHeight()              → chaintracks.getPresentHeight()
 *   isValidRootForHeight(root,h) → chaintracks.findHeaderForHeight(h), then compares root === header.merkleRoot
 * `Services.getHeight()` likewise calls `chaintracks.getPresentHeight()`, and `Services.hashToHeader(hash)` (the
 * merkle-proof providers' block-hash lookup) calls `chaintracks.findHeaderForBlockHash(hash)`. The toolbox's DEFAULT testnet chaintracks
 * (`testnet-chaintracks.babbage.systems`) is DOWN (probed 2026-08-24), so this adapter serves those from
 * WhatsOnChain testnet — mirroring `@bsv/sdk`'s own `WhatsOnChain` ChainTracker EXACTLY (same endpoints:
 * `/block/headers` for the tip, `/block/{h}/header` for the header) so the `merkleroot` field is already in the byte
 * order `@bsv/sdk`'s `MerklePath.computeRoot` produces — NO reversal, verified against the reference implementation.
 *
 * Every OTHER `ChaintracksClientApi` method is a Proxy trap that THROWS naming itself — so if the toolbox ever calls
 * a third method on the wallet path, we get a loud, specific error instead of a silent wrong-trust decision.
 *
 * MAINNET is the same wiring with a different backend: the canonical `ChaintracksServiceClient` pointed at each
 * agent's OWN local Anvil node (serves the same header-chain functions). Same
 * `ChaintracksChainTracker` wraps either — this is the testnet half of that environment swap (doc 20 §B).
 */

/** The BlockHeader shape the toolbox expects (`sdk/WalletServices.interfaces` — not root-exported, mirrored here).
 *  `ChaintracksChainTracker` reads only `.merkleRoot`; the rest are populated for any other reader. */
interface ToolboxBlockHeader {
  version: number
  previousHash: string
  merkleRoot: string
  time: number
  bits: number
  nonce: number
  height: number
  hash: string
}

/** WhatsOnChain `/block/{height}/header` response (the fields we map). */
interface WocHeader {
  version: number
  previousblockhash: string
  merkleroot: string
  time: number
  bits: string // hex, e.g. "1c00f1ae"
  nonce: number
  height: number
  hash: string
}

export interface WocChaintracksDeps {
  /** Injectable for tests; production uses the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Optional WhatsOnChain API key (raises the free-tier rate limit; see doc 20 — a pre-scale item). */
  apiKey?: string
  /** Per-request network timeout (default 8_000 ms). */
  timeoutMs?: number
}

export interface WocChaintracks {
  getPresentHeight(): Promise<number>
  findHeaderForHeight(height: number): Promise<ToolboxBlockHeader | undefined>
  findHeaderForBlockHash(hash: string): Promise<ToolboxBlockHeader>
  currentHeight(): Promise<number>
  isValidRootForHeight(root: string, height: number): Promise<boolean>
}

/**
 * Build a WoC-backed `ChaintracksClientApi` for the given chain. The toolbox does not export its client interface
 * from its root, so this adapter exposes its concrete supported surface. Only `getPresentHeight`,
 * `findHeaderForHeight`, `findHeaderForBlockHash`, `currentHeight`, and `isValidRootForHeight` are real.
 */
export function makeWocChaintracks(chain: 'test' | 'main', deps: WocChaintracksDeps = {}): WocChaintracks {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 8_000
  const base = `https://api.whatsonchain.com/v1/bsv/${chain}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (deps.apiKey && deps.apiKey.trim() !== '') headers['woc-api-key'] = deps.apiKey

  const get = (path: string): Promise<Response> =>
    fetchImpl(`${base}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })

  // Tip height — mirrors @bsv/sdk WhatsOnChain.currentHeight (`/block/headers` → data[0].height).
  const getPresentHeight = async (): Promise<number> => {
    let res: Response
    try {
      res = await get('/block/headers')
    } catch (e) {
      throw new Error(`woc-chaintracks getPresentHeight fetch failed (fail-closed): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) throw new Error(`woc-chaintracks getPresentHeight HTTP ${res.status}`)
    const data = (await res.json()) as Array<{ height?: unknown }>
    const h = Array.isArray(data) ? Number(data[0]?.height) : NaN
    if (!Number.isInteger(h) || h <= 0) throw new Error('woc-chaintracks getPresentHeight: bad /block/headers response')
    return h
  }

  // Header at a height — mirrors @bsv/sdk WhatsOnChain.isValidRootForHeight's endpoint (`/block/{h}/header`), so the
  // `merkleroot` is already in the order @bsv/sdk's computed root uses (compared as `root === header.merkleRoot`).
  const findHeaderForHeight = async (height: number): Promise<ToolboxBlockHeader | undefined> => {
    let res: Response
    try {
      res = await get(`/block/${height}/header`)
    } catch (e) {
      throw new Error(`woc-chaintracks findHeaderForHeight(${height}) fetch failed (fail-closed): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`woc-chaintracks findHeaderForHeight(${height}) HTTP ${res.status}`)
    const d = (await res.json()) as WocHeader
    if (typeof d?.merkleroot !== 'string' || d.merkleroot.length !== 64) {
      throw new Error(`woc-chaintracks findHeaderForHeight(${height}): missing/invalid merkleroot`)
    }
    return {
      version: Number(d.version),
      previousHash: String(d.previousblockhash),
      merkleRoot: d.merkleroot, // already correct byte order (matches @bsv/sdk root) — do NOT reverse
      time: Number(d.time),
      bits: parseInt(String(d.bits), 16),
      nonce: Number(d.nonce),
      height: Number(d.height),
      hash: String(d.hash),
    }
  }

  const findHeaderForBlockHash = async (input: string): Promise<ToolboxBlockHeader> => {
    if (typeof input !== 'string' || !/^[0-9a-fA-F]{64}$/.test(input)) {
      throw new Error('woc-chaintracks findHeaderForBlockHash: block hash must be a 64-character hexadecimal string')
    }
    const hash = input.toLowerCase()
    let res: Response
    try {
      res = await get(`/block/${hash}/header`)
    } catch (e) {
      throw new Error(`woc-chaintracks findHeaderForBlockHash(${hash}) fetch failed (fail-closed): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (res.status === 404) throw new Error(`woc-chaintracks findHeaderForBlockHash(${hash}) HTTP 404`)
    if (!res.ok) throw new Error(`woc-chaintracks findHeaderForBlockHash(${hash}) HTTP ${res.status}`)
    const d = (await res.json()) as WocHeader
    if (typeof d?.hash !== 'string' || d.hash.toLowerCase() !== hash) {
      throw new Error(`woc-chaintracks findHeaderForBlockHash: response hash does not match ${hash}`)
    }
    if (!Number.isSafeInteger(d.height) || d.height <= 0) {
      throw new Error(`woc-chaintracks findHeaderForBlockHash(${hash}): missing/invalid height`)
    }
    if (typeof d.merkleroot !== 'string' || d.merkleroot.length !== 64) {
      throw new Error(`woc-chaintracks findHeaderForBlockHash(${hash}): missing/invalid merkleroot`)
    }
    return {
      version: Number(d.version),
      previousHash: String(d.previousblockhash),
      merkleRoot: d.merkleroot, // already correct byte order (matches @bsv/sdk root) — do NOT reverse
      time: Number(d.time),
      bits: parseInt(String(d.bits), 16),
      nonce: Number(d.nonce),
      height: d.height,
      hash: d.hash,
    }
  }

  const impl: Record<string, unknown> = {
    getPresentHeight,
    findHeaderForHeight,
    findHeaderForBlockHash,
    currentHeight: getPresentHeight,
    isValidRootForHeight: async (root: string, height: number): Promise<boolean> => {
      const h = await findHeaderForHeight(height)
      return !!h && h.merkleRoot === root
    },
  }

  // Any un-implemented ClientApi method → a thrower that names itself (loud, not silently wrong).
  return new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop]
      return () => {
        throw new Error(
          `woc-chaintracks: ${String(prop)}() is not implemented — the wallet SPV path uses only ` +
          `getPresentHeight + findHeaderForHeight + findHeaderForBlockHash (testnet). If the toolbox needs this, wire a fuller provider.`,
        )
      }
    },
  }) as unknown as WocChaintracks
}
