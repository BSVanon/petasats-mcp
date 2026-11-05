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
export const BASE_RPC_UNVERIFIED_CRITICAL_AFTER_MS = 10 * 60_000
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
  // Each endpoint already gets the bounded Base read retry schedule.  Do not also accept viem fallback's default
  // outer retries: that multiplies a refusal across the whole endpoint set and makes an unknown lookup unbounded.
  return lookupRefusalGuard(fallback(urls.map((url) => baseReadTransport(url, fetchImpl, retryDelayMs)), {
    rank: false, shouldThrow: () => false, retryCount: 0, retryDelay: retryDelayMs,
  }))
}
