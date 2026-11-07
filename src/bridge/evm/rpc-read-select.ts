import { DEFAULT_BASE_MAINNET_PUBLIC_RPC_URLS, resolveBaseMainnetRpcUrls } from './rpc-config'
import { rpcProbeCall } from './rpc-probe'

const DEFAULT_BASE_MAINNET_READ_RPC = 'https://base-rpc.publicnode.com'

export type BaseReadUrlSelection = {
  url: string
  index: number
  host: string
  qualified: boolean
}

/** Resolve the read-only job endpoints without changing the fail-closed sender configuration. */
export function resolveBaseMainnetReadUrls(env: Record<string, string | undefined> = process.env): string[] {
  const primary = env.BASE_MAINNET_RPC?.trim() || DEFAULT_BASE_MAINNET_READ_RPC
  const configured = env.BASE_MAINNET_RPC_FALLBACKS === undefined
    ? { ...env, BASE_MAINNET_RPC: primary, BASE_MAINNET_RPC_FALLBACKS: DEFAULT_BASE_MAINNET_PUBLIC_RPC_URLS.join(',') }
    : { ...env, BASE_MAINNET_RPC: primary }
  return [...new Set(resolveBaseMainnetRpcUrls(configured))]
}

const HEX_QUANTITY = /^0x[0-9a-f]+$/i
const HEX_HASH = /^0x[0-9a-f]{64}$/i

function isFreshBaseHead(block: unknown, now: number, maxHeadAgeMs: number): boolean {
  if (typeof block !== 'object' || block === null) return false
  const { number, hash, timestamp } = block as { number?: unknown; hash?: unknown; timestamp?: unknown }
  // A real latest block carries its number, hash and timestamp; a partial object is a malformed answer.
  if (typeof number !== 'string' || !HEX_QUANTITY.test(number) || typeof hash !== 'string' || !HEX_HASH.test(hash)
    || typeof timestamp !== 'string' || !HEX_QUANTITY.test(timestamp)) return false
  try {
    if (!Number.isFinite(now) || !Number.isFinite(maxHeadAgeMs) || maxHeadAgeMs < 0) return false
    const timestampMs = BigInt((block as { timestamp: string }).timestamp) * 1000n
    const difference = timestampMs - BigInt(Math.trunc(now))
    const absoluteDifference = difference < 0n ? -difference : difference
    return absoluteDifference <= BigInt(Math.trunc(maxHeadAgeMs))
  } catch {
    return false
  }
}

/** Select one responsive, fresh Base endpoint so a read-only job observes one endpoint for its complete run. */
export async function selectBaseReadUrl(
  urls: readonly string[],
  opts: { fetchImpl?: typeof fetch; now?: number | (() => number); timeoutMs?: number; maxHeadAgeMs?: number; maxTotalMs?: number } = {},
): Promise<BaseReadUrlSelection> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const fixedNow = opts.now
  const clock = typeof fixedNow === 'function' ? fixedNow : typeof fixedNow === 'number' ? () => fixedNow : Date.now
  const timeoutMs = opts.timeoutMs ?? 5_000
  const maxHeadAgeMs = opts.maxHeadAgeMs ?? 120_000
  // The whole selection stays well inside the jobs' timer periods however long the configured list is.
  const maxTotalMs = opts.maxTotalMs ?? 60_000
  const fallback = urls[0]
  if (!fallback) throw new Error('selectBaseReadUrl requires at least one URL')
  const started = performance.now()

  for (const [index, url] of urls.entries()) {
    if (performance.now() - started >= maxTotalMs) break
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('read endpoint deadline elapsed'))
        }, timeoutMs)
      })
      const qualifies = await Promise.race([
        (async () => {
          const chainId = await rpcProbeCall(url, 'eth_chainId', [], fetchImpl, { signal: controller.signal, timeoutMs, strict: true })
          if (chainId !== '0x2105') return false
          const block = await rpcProbeCall(url, 'eth_getBlockByNumber', ['latest', false], fetchImpl, { signal: controller.signal, timeoutMs, strict: true })
          // Read the clock when the head arrives, so time spent on earlier members never skews this member's check.
          return isFreshBaseHead(block, clock(), maxHeadAgeMs)
        })(),
        deadline,
      ])
      if (qualifies) return { url, index, host: new URL(url).host, qualified: true }
    } catch {
      // Endpoint faults are deliberately silent: the jobs retain their historical primary fallback below.
    } finally {
      if (timer) clearTimeout(timer)
      controller.abort()
    }
  }
  return { url: fallback, index: 0, host: new URL(fallback).host, qualified: false }
}

export function formatBaseReadSelectionLog(selection: BaseReadUrlSelection, memberCount: number): string {
  if (!selection.qualified) return `Base read endpoint ${selection.host} (member 1 of ${memberCount}; no member answered the freshness check)`
  if (selection.index === 0) return `Base read endpoint ${selection.host} (member 1 of ${memberCount})`
  return `Base read endpoint ${selection.host} (member ${selection.index + 1} of ${memberCount}; earlier members did not answer)`
}
