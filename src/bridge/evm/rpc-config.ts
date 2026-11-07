import { createHash } from 'node:crypto'
import { fallback, http, type HttpTransport, type Transport } from 'viem'
import { guardLookup, lookupRefusalGuard, lookupRefusalRetryableFetch } from './lookup-refusal'
import { baseBlocksForSecs } from '../base-block-time'
/** The deliberate default — a single stable endpoint, not the flaky `sepolia.base.org` round-robin. */
export const PINNED_BASE_SEPOLIA_RPC = 'https://base-sepolia-rpc.publicnode.com'
export const BASE_MAINNET_CHAIN_ID = 8453
export const BASE_SEPOLIA_CHAIN_ID = 84532
/** Provider-keyless Base endpoints, ordered by observed log span and then read-only fallback value. */
export const DEFAULT_BASE_MAINNET_PUBLIC_RPC_URLS = [
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
  'https://mainnet.base.org',
  'https://base-public.nodies.app',
] as const

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
    // The value is withheld: an endpoint URL may carry a provider key.
    throw new Error(`${varName} is not a valid URL (value withheld; it has ${url.length} characters)`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${varName} must be http(s), got '${parsed.protocol}' for ${parsed.host || 'an endpoint with no host'}`)
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
export const DEFAULT_BASE_RPC_MAX_HEAD_LAG_BLOCKS = baseBlocksForSecs(60)
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

/**
 * Remove one Base endpoint's provider credential from arbitrary error text.  A path segment or query value long enough
 * to be a credential (16+ characters decoded, e.g. https://rpc.example.com/base/<key> or ?apikey=<key>) makes the
 * endpoint private; short parts such as "base" or "v2" are not secrets and are left alone everywhere in the text.
 * Endpoints with no such part deliberately pass through unchanged so their diagnostics remain byte-for-byte stable.
 */
export function redactBaseRpcUrlText(value: string, url: string): string {
  let parsed: URL
  try { parsed = new URL(url) } catch { return value }

  const decodedLength = (part: string): number => { try { return decodeURIComponent(part).length } catch { return part.length } }
  const pathSegments = parsed.pathname.split('/').filter((segment) => decodedLength(segment) >= 16)
  const queryValues = [...parsed.searchParams.values()].filter((candidate) => candidate.length >= 16)
  if (pathSegments.length === 0 && queryValues.length === 0) return value

  const safe = describeBaseSendRpc(url)
  const replacements = new Map<string, string>()
  const withoutQuery = new URL(parsed)
  withoutQuery.search = ''
  withoutQuery.hash = ''
  for (const candidate of [url, parsed.toString(), url.split(/[?#]/, 1)[0], withoutQuery.toString()]) {
    if (candidate) replacements.set(candidate, safe)
  }
  for (const segment of pathSegments) {
    replacements.set(segment, '<redacted>')
    try { replacements.set(decodeURIComponent(segment), '<redacted>') } catch {}
  }
  for (const candidate of queryValues) replacements.set(candidate, '<redacted>')
  for (const rawPart of parsed.search.slice(1).split('&')) {
    const rawValue = rawPart.slice(rawPart.indexOf('=') + 1)
    if (!rawValue) continue
    try {
      if (decodeURIComponent(rawValue).length >= 16) replacements.set(rawValue, '<redacted>')
    } catch {}
  }

  let result = value
  for (const [candidate, replacement] of [...replacements].sort(([left], [right]) => right.length - left.length)) {
    result = result.split(candidate).join(replacement)
  }
  return result
}

/** Mutate viem's nested error objects without changing their class, name, or code. */
export function redactBaseRpcError(error: unknown, url: string): void {
  const seen = new Set<object>()
  let candidate = error
  while (typeof candidate === 'object' && candidate !== null && !seen.has(candidate)) {
    seen.add(candidate)
    const record = candidate as Record<string, unknown>
    for (const field of ['message', 'shortMessage', 'details', 'url', 'stack'] as const) {
      if (typeof record[field] !== 'string') continue
      try { record[field] = redactBaseRpcUrlText(record[field], url) } catch {}
    }
    if (Array.isArray(record.metaMessages)) {
      try {
        record.metaMessages = record.metaMessages.map((entry) =>
          typeof entry === 'string' ? redactBaseRpcUrlText(entry, url) : entry,
        )
      } catch {}
    }
    candidate = record.cause
  }
}

/** Add in-place credential scrubbing to a viem HTTP transport without changing its request semantics. */
export function redactedBaseHttpTransport(url: string, transport: HttpTransport): HttpTransport {
  return ((config) => {
    const inner = transport(config)
    const request = async (args: Parameters<typeof inner.request>[0]) => {
      try { return await inner.request(args) }
      catch (error) {
        redactBaseRpcError(error, url)
        throw error
      }
    }
    const configRequest = async (args: Parameters<typeof inner.config.request>[0]) => {
      try { return await inner.config.request(args) }
      catch (error) {
        redactBaseRpcError(error, url)
        throw error
      }
    }
    return { ...inner, config: { ...inner.config, request: configRequest }, request }
  }) as HttpTransport
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
  return lookupRefusalGuard(redactedBaseHttpTransport(url, http(url, {
    fetchFn: throttleRetryableFetch(lookupRefusalRetryableFetch(fetchImpl)), retryCount: BASE_READ_RETRY_COUNT, retryDelay: retryDelayMs,
  })))
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
