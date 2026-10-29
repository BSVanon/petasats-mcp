import { createHash } from 'node:crypto'
import { fallback, http, type HttpTransport, type Transport } from 'viem'
import { guardLookup, lookupRefusalGuard, lookupRefusalRetryableFetch } from './lookup-refusal'
/** The deliberate default — a single stable endpoint, not the flaky `sepolia.base.org` round-robin. */
export const PINNED_BASE_SEPOLIA_RPC = 'https://base-sepolia-rpc.publicnode.com'
export const BASE_MAINNET_CHAIN_ID = 8453
export const BASE_SEPOLIA_CHAIN_ID = 84532
/** The official public endpoint is round-robin/load-balanced; safe with the counter, but operationally less reliable. */
const KNOWN_LOAD_BALANCED_BASE_SEND_HOSTS = new Set(['mainnet.base.org'])
/** Accepted with a loud reliability/latency warning; a dedicated/private endpoint is still preferred. */
const KNOWN_PUBLIC_BASE_SEND_HOSTS = new Set(['base-rpc.publicnode.com', 'base.llamarpc.com', 'base.drpc.org'])

/** Validate an RPC URL is well-formed http(s) — a bad endpoint must surface at startup, not mid-swap. */
function validateRpcUrl(url: string, varName: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${varName} is not a valid URL: '${url}'`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${varName} must be http(s), got '${parsed.protocol}' in '${url}'`)
  }
  return url
}

/** Ordered mainnet endpoints.  The primary remains mandatory and is always first. */
export function resolveBaseMainnetRpcUrls(env: Record<string, string | undefined> = process.env): string[] {
  const primary = env.BASE_MAINNET_RPC?.trim()
  if (!primary) {
    throw new Error('BASE_MAINNET_RPC is required for a Base mainnet (chainId 8453) record — refusing to fall back to the Sepolia pin (fail-closed money-safety)')
  }
  const urls = [validateRpcUrl(primary, 'BASE_MAINNET_RPC')]
  const raw = env.BASE_MAINNET_RPC_FALLBACKS?.trim()
  if (!raw) return urls
  for (const [index, candidate] of raw.split(',').map((value) => value.trim()).entries()) {
    if (!candidate) throw new Error(`BASE_MAINNET_RPC_FALLBACKS contains an empty URL at position ${index + 1}`)
    urls.push(validateRpcUrl(candidate, `BASE_MAINNET_RPC_FALLBACKS[${index + 1}]`))
  }
  return urls
}

export const DEFAULT_BASE_RPC_PROBE_INTERVAL_MS = 3_600_000
export function resolveBaseRpcProbeIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BASE_RPC_PROBE_INTERVAL_MS?.trim()
  const value = raw ? Number(raw) : DEFAULT_BASE_RPC_PROBE_INTERVAL_MS
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 86_400_000) {
    throw new Error(`BASE_RPC_PROBE_INTERVAL_MS must be a safe integer from 60000 through 86400000 (got '${raw ?? ''}')`)
  }
  return value
}

/** Endpoints lagging farther than this latest head are not safe for shared swap reads. */
export const DEFAULT_BASE_RPC_MAX_HEAD_LAG_BLOCKS = 30
export function resolveBaseRpcMaxHeadLagBlocks(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BASE_RPC_MAX_HEAD_LAG_BLOCKS
  if (raw === undefined || raw === '') return DEFAULT_BASE_RPC_MAX_HEAD_LAG_BLOCKS
  if (!/^\d+$/.test(raw)) {
    throw new Error(`BASE_RPC_MAX_HEAD_LAG_BLOCKS must be a non-negative safe integer (got '${raw}')`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`BASE_RPC_MAX_HEAD_LAG_BLOCKS must be a non-negative safe integer (got '${raw}')`)
  }
  return value
}

export const DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS = 60_000
const BASE_RPC_UNVERIFIED_CRITICAL_AFTER_MS = 10 * 60_000
export function resolveBaseRpcDegradedProbeIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BASE_RPC_DEGRADED_PROBE_INTERVAL_MS?.trim()
  const value = raw ? Number(raw) : DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 3_600_000) {
    throw new Error(`BASE_RPC_DEGRADED_PROBE_INTERVAL_MS must be a safe integer from 10000 through 3600000 (got '${raw ?? ''}')`)
  }
  return value
}

/**
 * Resolve the Base SEPOLIA RPC URL: `BASE_SEPOLIA_RPC` if set (trimmed), else the pin. Fail-closed on a
 * malformed override — a bad RPC URL should surface at startup, not as a confusing mid-swap fetch
 * error. Injectable env for tests.
 */
export function resolveBaseRpc(env: Record<string, string | undefined> = process.env): string {
  return validateRpcUrl(env.BASE_SEPOLIA_RPC?.trim() || PINNED_BASE_SEPOLIA_RPC, 'BASE_SEPOLIA_RPC')
}

/**
 * CHAIN-AWARE Base RPC — the fix for review 8902e6fc HIGH: the client's chain is picked from a record's
 * `baseChainId`, so its RPC MUST be resolved from the SAME chainId or a mainnet client can silently run
 * over the Sepolia pin (wrong heights/logs; a refund that can't submit). Rules, fail-closed:
 *   • an explicit `override` (e.g. WATCH_BASE_RPC) always wins (validated);
 *   • SEPOLIA (84532) → `resolveBaseRpc` (pin-backed, safe for testnet);
 *   • MAINNET (8453) → REQUIRES `BASE_MAINNET_RPC` — there is NO pin fallback (a public/wrong mainnet RPC
 *     is real money risk at size), so an unset var THROWS rather than silently using the Sepolia pin;
 *   • any other chainId THROWS (unsupported).
 */
export function resolveBaseRpcForChain(
  chainId: number,
  env: Record<string, string | undefined> = process.env,
  override?: string,
): string {
  // review 7dff3be8 LOW: reject an unsupported chainId FIRST — before honoring any override — so a record
  // on a chain we don't support fails at startup, never builds a client that dies later on chain checks.
  if (chainId !== BASE_MAINNET_CHAIN_ID && chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`resolveBaseRpcForChain: unsupported Base chainId ${chainId} (expected ${BASE_MAINNET_CHAIN_ID} mainnet or ${BASE_SEPOLIA_CHAIN_ID} sepolia)`)
  }
  if (override?.trim()) return validateRpcUrl(override.trim(), 'base RPC override')
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return resolveBaseRpc(env)
  // mainnet — REQUIRES an explicit endpoint; no pin fallback (a public/wrong mainnet RPC is money risk).
  const url = env.BASE_MAINNET_RPC?.trim()
  if (!url) {
    throw new Error('BASE_MAINNET_RPC is required for a Base mainnet (chainId 8453) record — refusing to fall back to the Sepolia pin (fail-closed money-safety)')
  }
  return validateRpcUrl(url, 'BASE_MAINNET_RPC')
}

/** The list companion to resolveBaseRpcForChain. Overrides deliberately remain a one-endpoint operator pin. */
export function resolveBaseRpcUrlsForChain(
  chainId: number,
  env: Record<string, string | undefined> = process.env,
  override?: string,
): string[] {
  if (chainId !== BASE_MAINNET_CHAIN_ID && chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`resolveBaseRpcForChain: unsupported Base chainId ${chainId} (expected ${BASE_MAINNET_CHAIN_ID} mainnet or ${BASE_SEPOLIA_CHAIN_ID} sepolia)`)
  }
  if (override?.trim()) return [validateRpcUrl(override.trim(), 'base RPC override')]
  return chainId === BASE_MAINNET_CHAIN_ID ? resolveBaseMainnetRpcUrls(env) : [resolveBaseRpc(env)]
}

export function resolveMakerBaseSendRpc(
  chainId: number,
  env: Record<string, string | undefined> = process.env,
  override?: string,
  warn: (message: string) => void = () => {},
): string {
  if (chainId !== BASE_MAINNET_CHAIN_ID) return resolveBaseRpcForChain(chainId, env, override)

  const shared = env.BASE_MAINNET_RPC?.trim()
  if (!shared) {
    throw new Error("BASE_MAINNET_RPC is required for the live Base mainnet send path — refusing an implicit fallback endpoint")
  }
  const configured = resolveBaseRpcForChain(chainId, env) // validate mandatory BASE_MAINNET_RPC even if override wins
  const candidateOverride = override?.trim()
  if (candidateOverride && candidateOverride !== shared) {
    warn("WATCH_BASE_RPC differs from BASE_MAINNET_RPC on the maker-key send path; the persisted nonce counter preserves correctness, but endpoint drift complicates diagnosis")
  }
  const url = candidateOverride ? resolveBaseRpcForChain(chainId, env, candidateOverride) : configured
  const host = new URL(url).hostname.toLowerCase()
  if (KNOWN_LOAD_BALANCED_BASE_SEND_HOSTS.has(host)) {
    warn(`⚠ Base send RPC host ${host} is a known load-balanced public endpoint; the persisted nonce counter preserves correctness across backend mempools, but use a dedicated private node for stronger reliability/latency`)
  }
  if (KNOWN_PUBLIC_BASE_SEND_HOSTS.has(host)) {
    warn(`⚠ Base send RPC host ${host} is public/shared; the persisted nonce counter preserves correctness, but a dedicated private node is preferred for reliability/latency`)
  }
  return url
}

/** Log-safe endpoint identity: origin is visible; full URL (including provider path/query keys) is represented by hash. */
export function describeBaseSendRpc(url: string): string {
  const parsed = new URL(url)
  const fingerprint = createHash('sha256').update(url).digest('hex').slice(0, 16)
  return `${parsed.origin} · endpoint-sha256 ${fingerprint}`
}

/** Base READ retries: 6 retries after 250/500/1000/2000/4000/8000 ms (~15.75 s max added wait per read). This covers a
 *  throttled 429 (see below) and also widens viem's default schedule (3 × 150 ms) for the errors viem already retries
 *  (5xx, 408, …). The D2 drill (2026-09-27) saw mainnet.base.org keep throttling past the earlier 4-retry, ~3.75 s
 *  schedule; a caller with a tighter deadline (the signer's counterparty check) is still cut off by that deadline. */
export const BASE_READ_RETRY_COUNT = 6
export const BASE_READ_RETRY_DELAY_MS = 250

export function throttleRetryableFetch(inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init)
    if (res.status !== 429) return res
    await res.body?.cancel().catch(() => {})
    return new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })
  }
}

/** The Base READ transport: `http(url)` plus throttle and lookup-refusal retries (lookup-refusal.ts). Reads only — a
 *  retried read is idempotent; the send path keeps the plain transport because the send engine owns its own
 *  resend/recovery logic. `retryDelayMs` exists for tests; production uses the default schedule. */
export function baseReadTransport(url: string, fetchImpl?: typeof fetch, retryDelayMs = BASE_READ_RETRY_DELAY_MS): HttpTransport {
  return lookupRefusalGuard(http(url, { fetchFn: throttleRetryableFetch(lookupRefusalRetryableFetch(fetchImpl)), retryCount: BASE_READ_RETRY_COUNT, retryDelay: retryDelayMs }))
}

/**
 * One canonical Base transport builder. With one URL it returns the historical transport byte-for-byte in behaviour;
 * with several it uses viem's ordered fallback transport. `shouldThrow: false` is intentional: JSON-RPC errors
 * (including provider-specific receipt/archive refusals) are endpoint failures and must be offered to the next node.
 */
export function baseRpcTransport(urls: readonly string[], fetchImpl?: typeof fetch, retryDelayMs = BASE_READ_RETRY_DELAY_MS): Transport {
  if (urls.length === 0) throw new Error('baseRpcTransport requires at least one RPC URL')
  if (urls.length === 1) return baseReadTransport(urls[0], fetchImpl, retryDelayMs)
  return lookupRefusalGuard(fallback(urls.map((url) => baseReadTransport(url, fetchImpl, retryDelayMs)), { rank: false, shouldThrow: () => false }))
}

type RpcReply = { result?: unknown; error?: { code?: number; message?: string } }
export type BaseRpcProbeResult = {
  url: string
  ok: boolean
  /** Whether this otherwise-safe endpoint accepts eth_getLogs searches. */
  logs: boolean
  logsReason?: string
  deepReceipts: boolean
  finalizedNumber?: bigint
  finalizedHash?: string
  latestNumber?: bigint
  failure?: 'safety' | 'transient'
  reason?: string
}

/** A hung endpoint must fail its probe, not stall a boot or stack periodic probes. */
const BASE_RPC_PROBE_CALL_TIMEOUT_MS = 15_000

async function rpcProbeCall(url: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(BASE_RPC_PROBE_CALL_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const reply = await response.json() as RpcReply
  if (reply.error) throw new Error(`RPC ${reply.error.code ?? ''} ${reply.error.message ?? ''}`.trim())
  return reply.result
}

/** Probe the inexpensive swap-contract path; never use token Transfer logs here (their volume makes good nodes look bad). */
export async function probeBaseRpcEndpoint(args: { url: string; swapAddress: string; fetchImpl?: typeof fetch }): Promise<BaseRpcProbeResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  try {
    if (await rpcProbeCall(args.url, 'eth_chainId', [], fetchImpl) !== '0x2105') {
      return { url: args.url, ok: false, logs: false, deepReceipts: false, failure: 'safety', reason: 'wrong chain id' }
    }
    const safe = await rpcProbeCall(args.url, 'eth_getBlockByNumber', ['safe', false], fetchImpl)
    const finalized = await rpcProbeCall(args.url, 'eth_getBlockByNumber', ['finalized', false], fetchImpl) as { number?: string; hash?: string } | null
    if (!safe || !finalized?.number || !finalized.hash) throw new Error('safe or finalized block missing')
    const latest = await rpcProbeCall(args.url, 'eth_blockNumber', [], fetchImpl)
    if (typeof latest !== 'string') throw new Error('latest block missing')
    const finalizedNumber = BigInt(finalized.number)
    const latestNumber = BigInt(latest)
    const fromBlock = finalizedNumber > 1_999n ? finalizedNumber - 1_999n : 0n
    let logs = false
    let logsReason: string | undefined
    try {
      const result = await rpcProbeCall(args.url, 'eth_getLogs', [{ address: args.swapAddress, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: finalized.number }], fetchImpl)
      if (Array.isArray(result)) logs = true
      else logsReason = 'malformed log result'
    } catch (error) {
      logs = false
      logsReason = error instanceof Error ? error.message : String(error)
    }
    const oldBlock = await rpcProbeCall(args.url, 'eth_getBlockByNumber', [`0x${(finalizedNumber > 200n ? finalizedNumber - 200n : 0n).toString(16)}`, true], fetchImpl) as { transactions?: Array<string | { hash?: string }> } | null
    const tx = oldBlock?.transactions?.[0]
    const hash = typeof tx === 'string' ? tx : tx?.hash
    // An empty old block gives no evidence of historical receipt support. Treat
    // it conservatively as shallow-only rather than calling the endpoint deep.
    const deepReceipts = Boolean(hash)
    if (hash) await rpcProbeCall(args.url, 'eth_getTransactionReceipt', [hash], fetchImpl)
    return { url: args.url, ok: true, logs, ...(logsReason ? { logsReason } : {}), deepReceipts, finalizedNumber, finalizedHash: finalized.hash, latestNumber }
  } catch (error) {
    return { url: args.url, ok: false, logs: false, deepReceipts: false, failure: 'transient', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The live endpoint set for a Base-mainnet process.  A request takes a snapshot of
 * the current list before it starts; a completed probe replaces that snapshot in
 * one assignment, so no request is ever routed through a half-updated list.
 *
 * This deliberately owns only provider availability.  Callers still own their
 * business-level startup gates (contract identity, nonce state, etc.).
 */
export class BaseRpcFailoverPool {
  private active: readonly string[]
  /** Safe active endpoints that the latest completed probe confirmed can search logs. */
  private activeLogUrls: readonly string[] = []
  /** True while log searches use an endpoint retained after a transient probe failure. */
  private logRetentionActive = false
  private timer?: ReturnType<typeof setTimeout>
  private probing?: Promise<void>
  private started = false
  private completedProbe = false
  private split = false
  private unverified = false
  private unverifiedSince?: number
  private logUnverifiedSince?: number
  private nextDelayMs: number
  private readonly transports = new Map<string, Transport>()

  constructor(private readonly opts: {
    urls: readonly string[]
    swapAddress: string
    probeIntervalMs: number
    alert: (message: string) => void
    log?: (message: string) => void
    fetchImpl?: typeof fetch
    maxHeadLagBlocks?: number
    degradedProbeIntervalMs?: number
    now?: () => number
  }) {
    if (!opts.urls.length) throw new Error('BaseRpcFailoverPool requires at least one RPC URL')
    if (!Number.isSafeInteger(opts.maxHeadLagBlocks ?? DEFAULT_BASE_RPC_MAX_HEAD_LAG_BLOCKS) ||
        (opts.maxHeadLagBlocks ?? DEFAULT_BASE_RPC_MAX_HEAD_LAG_BLOCKS) < 0) {
      throw new Error('BaseRpcFailoverPool maxHeadLagBlocks must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(opts.degradedProbeIntervalMs ?? DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS) ||
        (opts.degradedProbeIntervalMs ?? DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS) < 10_000 ||
        (opts.degradedProbeIntervalMs ?? DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS) > 3_600_000) {
      throw new Error('BaseRpcFailoverPool degradedProbeIntervalMs must be a safe integer from 10000 through 3600000')
    }
    this.active = [...opts.urls]
    this.nextDelayMs = opts.probeIntervalMs
  }

  /** A viem transport whose individual requests use the endpoint-list snapshot current at request start. */
  readonly transport: Transport = (config) => {
    const initial = this.makeTransport(this.active)(config)
    const requestSnapshot = async (urls: readonly string[], args: Parameters<typeof initial.request>[0]): Promise<{ url: string, result: unknown }> => {
      let failure: unknown
      for (const url of urls) {
        try {
          const result = await this.makeTransport([url])(config).request(args)
          return { url, result }
        } catch (error) { failure = error }
      }
      throw failure ?? new Error('Base RPC request has no active endpoint')
    }
    return {
      ...initial,
      request: async (args) => guardLookup(args.method, async () => {
        const logRequest = args.method === 'eth_getLogs'
        const snapshot = logRequest ? this.activeLogUrls : this.active
        if (snapshot.length === 0) {
          throw new Error(logRequest ? 'Base RPC has no active endpoint that serves log searches' : 'Base RPC request has no active endpoint')
        }
        const first = await requestSnapshot(snapshot, args)
        const currentUrls = logRequest ? this.activeLogUrls : this.active
        if (currentUrls.includes(first.url)) return first.result as never

        // The probe atomically replaced the snapshot while this read was in flight. Never return a response from an
        // endpoint now known unsafe; replay once through the current ordered set, and fail closed if it disappeared too.
        const current = logRequest ? this.activeLogUrls : this.active
        if (current.length === 0) throw new Error('Base RPC response came from an endpoint no longer active and no current endpoint is safe')
        const retried = await requestSnapshot(current, args)
        const finalUrls = logRequest ? this.activeLogUrls : this.active
        if (!finalUrls.includes(retried.url)) {
          throw new Error('Base RPC retry response came from an endpoint no longer active')
        }
        return retried.result as never
      }),
    }
  }

  get activeUrls(): readonly string[] { return this.active }
  /** True only while finalized-hash reports lack a strict majority. Reads continue; new value must not be committed. */
  isSplit(): boolean { return this.split }
  /** True when recovery reads are using a retained set that this probe could not verify, no endpoint is active, or log detection cannot run. */
  isUnverified(): boolean { return this.unverified || this.logRetentionActive || this.active.length === 0 || this.activeLogUrls.length === 0 }
  /** Exposed for deterministic lifecycle tests and operational status. */
  get nextProbeDelayMs(): number { return this.nextDelayMs }

  private makeTransport(urls: readonly string[]): Transport {
    const key = urls.join('\u0000')
    let transport = this.transports.get(key)
    if (!transport) {
      transport = baseRpcTransport(urls, this.opts.fetchImpl)
      this.transports.set(key, transport)
    }
    return transport
  }

  /** Probe immediately; concurrent callers share one pass so endpoint snapshots cannot race. */
  async probeNow(): Promise<void> {
    if (this.probing) return this.probing
    this.probing = this.performProbe()
    try { await this.probing } finally { this.probing = undefined }
  }

  private async performProbe(): Promise<void> {
    const hadPreviousSet = this.completedProbe
    const results = await Promise.all(this.opts.urls.map((url) => probeBaseRpcEndpoint({
      url, swapAddress: this.opts.swapAddress, fetchImpl: this.opts.fetchImpl,
    })))
    const previous = new Set(this.active)
    const previousLogUrls = new Set(this.activeLogUrls)
    const transientlyFailedPrevious = new Map<string, string>()
    const transientFailures = new Set<string>()
    const safetyFailures = new Set<string>()
    const headLagFailures = new Set<string>()
    let degraded = false
    const retainTransient = (url: string, reason: string): void => {
      transientFailures.add(url)
      if (hadPreviousSet && previous.has(url)) {
        transientlyFailedPrevious.set(url, reason)
        degraded = true
      } else {
        degraded = true
        this.opts.alert(`[base-rpc] excluding ${describeBaseSendRpc(url)}: ${reason}`)
      }
    }
    for (const result of results.filter((result) => !result.ok)) {
      if (result.failure === 'safety') {
        safetyFailures.add(result.url)
        degraded = true
        this.opts.alert(`[base-rpc] excluding ${describeBaseSendRpc(result.url)}: ${result.reason ?? 'safety probe failure'}`)
      } else retainTransient(result.url, result.reason ?? 'transient probe failure')
    }
    const passing = results.filter((result) => result.ok)
    for (const result of passing.filter((result) => !result.logs)) {
      this.opts.log?.(`[base-rpc] ${describeBaseSendRpc(result.url)} does not serve log searches`)
    }
    const maxLag = BigInt(this.opts.maxHeadLagBlocks ?? DEFAULT_BASE_RPC_MAX_HEAD_LAG_BLOCKS)
    const highestHead = passing.length
      ? passing.reduce((height, result) => result.latestNumber! > height ? result.latestNumber! : height, passing[0].latestNumber!)
      : 0n
    const timely = passing.filter((result) => {
      const lag = highestHead - result.latestNumber!
      if (lag <= maxLag) return true
      headLagFailures.add(result.url)
      degraded = true
      this.opts.alert(`[base-rpc] excluding ${describeBaseSendRpc(result.url)}: latest block lags highest observed latest head by ${lag} blocks (maximum ${maxLag})`)
      return false
    })
    let hashes: Array<{ result: BaseRpcProbeResult; hash?: string }> = []
    let commonHeight: bigint | undefined
    if (timely.length) {
      // Finalized heads can differ by a block. Compare the hash at the lowest common
      // finalized height, rather than comparing two different heights.
      commonHeight = timely.reduce((height, result) => result.finalizedNumber! < height ? result.finalizedNumber! : height, timely[0].finalizedNumber!)
      hashes = await Promise.all(timely.map(async (result) => {
        try {
          const block = await rpcProbeCall(result.url, 'eth_getBlockByNumber', [`0x${commonHeight!.toString(16)}`, false], this.opts.fetchImpl ?? fetch) as { hash?: string } | null
          if (!block?.hash) throw new Error('finalized hash missing')
          return { result, hash: block.hash.toLowerCase() }
        } catch (error) {
          retainTransient(result.url, `finalized hash cross-check failed: ${error instanceof Error ? error.message : String(error)}`)
          return { result, hash: undefined }
        }
      }))
    }
    const byHash = new Map<string, typeof hashes>()
    for (const item of hashes) if (item.hash) byHash.set(item.hash, [...(byHash.get(item.hash) ?? []), item])
    const primary = hashes.find((item) => item.result.url === this.opts.urls[0])
    const groups = [...byHash.values()]
    const largest = Math.max(...groups.map((group) => group.length), 0)
    const leaders = groups.filter((group) => group.length === largest)
    const winner = leaders.find((group) => group.some((item) => item === primary)) ?? (leaders.length === 1 ? leaders[0] : undefined)
    const returnedHashes = hashes.filter((item) => item.hash)
    this.split = returnedHashes.length >= 2 && groups.length >= 2 && largest * 2 <= returnedHashes.length
    if (this.split) {
      degraded = true
      this.opts.alert(`[base-rpc] CRITICAL: finalized hash split at block ${commonHeight}; no hash group has a strict majority, retaining the primary group for recovery reads`)
    }
    const selected = winner?.map((item) => item.result.url) ?? []
    for (const item of returnedHashes) {
      if (!winner?.includes(item)) {
        safetyFailures.add(item.result.url)
        degraded = true
        this.opts.alert(`[base-rpc] excluding ${describeBaseSendRpc(item.result.url)}: finalized hash disagrees at block ${commonHeight}`)
      }
    }
    if (winner && !winner.some((item) => item.result.deepReceipts)) {
      this.opts.alert('[base-rpc] no passing endpoint serves deep receipts; fresh receipts remain usable but reconciliation will fail closed on unavailable receipts')
    }
    if (winner && !selected.includes(this.opts.urls[0])) this.opts.alert('[base-rpc] primary endpoint failed or disagreed; operating on vetted fallback endpoint(s)')
    // A winning group is the proof that makes these endpoints safe for NEW BSV risk.
    // Retention is recovery liveness only: use it exclusively when this entire probe
    // could not establish even one winner, never alongside a verified group.
    const retained = selected.length === 0 ? [...transientlyFailedPrevious.keys()] : []
    if (retained.length) {
      for (const url of retained) {
        this.opts.alert(`[base-rpc] retaining ${describeBaseSendRpc(url)} after transient probe failure: ${transientlyFailedPrevious.get(url)}; no endpoint passed every check in this probe, so it is recovery-only`)
      }
    } else if (selected.length) {
      for (const [url, reason] of transientlyFailedPrevious) {
        this.opts.alert(`[base-rpc] excluding ${describeBaseSendRpc(url)}: ${reason}`)
      }
    }
    const activeSet = new Set(selected.length ? selected : retained)
    const next = this.opts.urls.filter((url) => activeSet.has(url) && !safetyFailures.has(url))
    const winnerLogCapable = new Set((winner ?? []).filter((item) => item.result.logs).map((item) => item.result.url))
    // A log-capable winner is the only fresh proof that an endpoint may accept new-risk log searches.
    const verifiedLog = this.opts.urls.filter((url) => next.includes(url) && winnerLogCapable.has(url))
    const resultByUrl = new Map(results.map((result) => [result.url, result]))
    // If that proof is temporarily unavailable, recovery may continue its event scans through the last
    // log-capable endpoint, but only if this probe did not find a safety problem with it.  This set is
    // intentionally independent from `active`: a no-logs winner can serve ordinary reads by itself.
    const retainedLog = verifiedLog.length || !hadPreviousSet ? [] : this.opts.urls.filter((url) => {
      const result = resultByUrl.get(url)
      return previousLogUrls.has(url) && !safetyFailures.has(url) &&
        (Boolean(result?.ok && !result.logs) || transientFailures.has(url) ||
          Boolean(result?.ok && result.logs && headLagFailures.has(url)))
    })
    const nextLogUrls = verifiedLog.length ? verifiedLog : retainedLog
    if (!verifiedLog.length) degraded = true
    const nextUnverified = selected.length === 0
    const now = (this.opts.now ?? Date.now)()
    if (nextUnverified) {
      if (this.unverifiedSince === undefined) this.unverifiedSince = now
    } else {
      this.unverifiedSince = undefined
    }
    if (!verifiedLog.length) {
      if (this.logUnverifiedSince === undefined) this.logUnverifiedSince = now
    } else {
      this.logUnverifiedSince = undefined
    }
    this.unverified = nextUnverified
    const alertLongUnverified = (): void => {
      if (this.unverifiedSince === undefined || now - this.unverifiedSince <= BASE_RPC_UNVERIFIED_CRITICAL_AFTER_MS) return
      const hosts = next.length ? next.map(describeBaseSendRpc).join(', ') : 'none'
      this.opts.alert(`[base-rpc] CRITICAL: Base RPC endpoints have remained unverified for over 10 minutes; retained hosts: ${hosts}`)
    }
    const alertLongLogUnverified = (): void => {
      if (this.logUnverifiedSince === undefined || now - this.logUnverifiedSince <= BASE_RPC_UNVERIFIED_CRITICAL_AFTER_MS) return
      this.opts.alert('[base-rpc] CRITICAL: no endpoint has passed a log search check for over 10 minutes; new risk paused')
    }
    if (!next.length) {
      this.active = [] // atomic endpoint-list swap; requests after this point fail closed.
      this.activeLogUrls = []
      this.logRetentionActive = false
      this.completedProbe = true
      this.nextDelayMs = this.opts.degradedProbeIntervalMs ?? DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS
      alertLongUnverified()
      alertLongLogUnverified()
      this.opts.alert('[base-rpc] no active endpoint serves log searches; new risk paused')
      throw new Error('Base RPC probe found no endpoint safe to serve or trade')
    }
    if (next.length !== this.opts.urls.length || retained.length || safetyFailures.size) degraded = true
    this.active = next // atomic endpoint-list swap; in-flight requests retain their prior snapshot.
    this.activeLogUrls = nextLogUrls
    this.logRetentionActive = retainedLog.length > 0
    this.completedProbe = true
    this.nextDelayMs = degraded ? (this.opts.degradedProbeIntervalMs ?? DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS) : this.opts.probeIntervalMs
    alertLongUnverified()
    alertLongLogUnverified()
    if (retainedLog.length) {
      const retainedOnlyForHeadLag = retainedLog.every((url) => headLagFailures.has(url))
      this.opts.alert(`[base-rpc] keeping ${retainedLog.map(describeBaseSendRpc).join(', ')} for log searches only after ${retainedOnlyForHeadLag ? 'a head-lag exclusion' : 'a transient probe failure'}; new risk paused`)
    } else if (nextLogUrls.length === 0) {
      this.opts.alert('[base-rpc] no active endpoint serves log searches; new risk paused')
    }
    this.opts.log?.(`[base-rpc] active endpoints: ${next.map(describeBaseSendRpc).join(', ')}`)
  }

  async start(): Promise<void> {
    await this.probeNow()
    this.started = true
    this.scheduleNextProbe()
  }

  private scheduleNextProbe(): void {
    if (!this.started) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.probeNow()
        .catch((error) => this.opts.alert(`[base-rpc] periodic probe failed; active endpoints are fail-closed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.scheduleNextProbe())
    }, this.nextDelayMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

/** Build the common mainnet probe/pool lifecycle from environment configuration. */
export function makeBaseRpcFailoverPool(args: {
  env?: Record<string, string | undefined>
  swapAddress: string
  alert: (message: string) => void
  log?: (message: string) => void
  override?: string
  fetchImpl?: typeof fetch
}): BaseRpcFailoverPool {
  const env = args.env ?? process.env
  return new BaseRpcFailoverPool({
    urls: resolveBaseRpcUrlsForChain(BASE_MAINNET_CHAIN_ID, env, args.override),
    swapAddress: args.swapAddress,
    probeIntervalMs: resolveBaseRpcProbeIntervalMs(env),
    alert: args.alert,
    log: args.log,
    fetchImpl: args.fetchImpl,
    maxHeadLagBlocks: resolveBaseRpcMaxHeadLagBlocks(env),
    degradedProbeIntervalMs: resolveBaseRpcDegradedProbeIntervalMs(env),
  })
}
