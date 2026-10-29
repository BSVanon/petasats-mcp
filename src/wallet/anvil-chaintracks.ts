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
/** Anvil `{ status, value }` envelope. */
interface AnvilEnvelope<T> { status?: string; value?: T }
interface AnvilHeader { version: number; previousHash: string; merkleRoot: string; time: number; bits: number; nonce: number; hash?: string }

export interface AnvilChaintracksDeps {
  fetchImpl?: typeof fetch
  /** Bearer token (Anvil `API.AuthToken`). Not required for chaintracks reads; included for parity. */
  authToken?: string
  timeoutMs?: number
  /** Untrusted hint for where to find a block hash on this node's header chain. */
  locateBlockHeight?: (blockHash: string) => Promise<number | undefined>
}

export interface AnvilChaintracks {
  getPresentHeight(): Promise<number>
  findHeaderForHeight(height: number): Promise<ToolboxBlockHeader | undefined>
  findHeaderForBlockHash(hash: string): Promise<ToolboxBlockHeader>
  currentHeight(): Promise<number>
  isValidRootForHeight(root: string, height: number): Promise<boolean>
}

/**
 * Build an Anvil-backed `ChaintracksClientApi` for mainnet headers. The toolbox does not root-export its client
 * interface, so this adapter exposes its concrete supported surface. Only `getPresentHeight`, `findHeaderForHeight`,
 * `findHeaderForBlockHash`, `currentHeight`, and `isValidRootForHeight` are real; every other method throws named.
 */
export function makeAnvilChaintracks(baseUrl: string, deps: AnvilChaintracksDeps = {}): AnvilChaintracks {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 12_000
  const base = baseUrl.replace(/\/$/, '')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (deps.authToken && deps.authToken.trim() !== '') headers.Authorization = `Bearer ${deps.authToken}`

  async function getValue<T>(path: string, what: string): Promise<T> {
    let res: Response
    try {
      res = await fetchImpl(`${base}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new Error(`anvil-chaintracks ${what} fetch failed (fail-closed): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) throw new Error(`anvil-chaintracks ${what} HTTP ${res.status}`)
    const body = (await res.json()) as AnvilEnvelope<T>
    if (body.status !== undefined && body.status !== 'success') throw new Error(`anvil-chaintracks ${what} status '${String(body.status)}'`)
    if (body.value === undefined) throw new Error(`anvil-chaintracks ${what}: no value in envelope`)
    return body.value
  }

  const getPresentHeight = async (): Promise<number> => {
    const h = Number(await getValue<number>('/getPresentHeight', 'getPresentHeight'))
    if (!Number.isInteger(h) || h <= 0) throw new Error(`anvil-chaintracks getPresentHeight: bad height ${h}`)
    return h
  }

  const findHeaderForHeight = async (height: number): Promise<ToolboxBlockHeader | undefined> => {
    let hdr: AnvilHeader | null
    try {
      hdr = await getValue<AnvilHeader>(`/findHeaderHexForHeight?height=${height}`, `findHeaderForHeight(${height})`)
    } catch (e) {
      // A not-found height should surface as undefined (as the toolbox expects), not throw.
      if (e instanceof Error && /HTTP 404|no value/.test(e.message)) return undefined
      throw e
    }
    if (!hdr || typeof hdr.merkleRoot !== 'string' || hdr.merkleRoot.length !== 64) {
      throw new Error(`anvil-chaintracks findHeaderForHeight(${height}): missing/invalid merkleRoot`)
    }
    return {
      version: Number(hdr.version),
      previousHash: String(hdr.previousHash),
      merkleRoot: hdr.merkleRoot, // Anvil serves display order (matches @bsv/sdk root) — do NOT reverse
      time: Number(hdr.time),
      bits: Number(hdr.bits),
      nonce: Number(hdr.nonce),
      height,
      hash: String(hdr.hash ?? ''),
    }
  }

  const findHeaderForBlockHash = async (input: string): Promise<ToolboxBlockHeader> => {
    if (typeof input !== 'string' || !/^[0-9a-fA-F]{64}$/.test(input)) {
      throw new Error('anvil-chaintracks findHeaderForBlockHash: block hash must be a 64-character hexadecimal string')
    }
    const hash = input.toLowerCase()
    if (!deps.locateBlockHeight) {
      throw new Error('anvil-chaintracks findHeaderForBlockHash: no block-height locator configured (fail-closed)')
    }
    let height: number | undefined
    try {
      height = await deps.locateBlockHeight(hash)
    } catch (e) {
      throw new Error(`anvil-chaintracks findHeaderForBlockHash: block-height locator failed (fail-closed): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0) {
      throw new Error(`anvil-chaintracks findHeaderForBlockHash: locator returned invalid height ${String(height)} (fail-closed)`)
    }
    const header = await findHeaderForHeight(height)
    if (!header) {
      throw new Error(`anvil-chaintracks findHeaderForBlockHash: this node does not have height ${height} (fail-closed)`)
    }
    if (header.hash.toLowerCase() !== hash) {
      throw new Error(`anvil-chaintracks findHeaderForBlockHash: block ${hash} is not at height ${height} on this node's header chain`)
    }
    return header
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

  return new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop]
      return () => {
        throw new Error(
          `anvil-chaintracks: ${String(prop)}() is not implemented — the wallet SPV path uses only ` +
          `getPresentHeight + findHeaderForHeight + findHeaderForBlockHash. If the toolbox needs this, extend the adapter.`,
        )
      }
    },
  }) as unknown as AnvilChaintracks
}
