/**
 * Fail-closed WhatsOnChain JSON GET client. Endpoint callers retain responsibility for validating successful bodies.
 */
export interface WocJsonClientOpts {
  /** OPTIONAL WhatsOnChain API key, sent as the `woc-api-key` header. */
  apiKey?: string
  /** Injectable for tests; production uses the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Per-request network timeout (default 20_000 ms). */
  timeoutMs?: number
  /** Total attempts before failing closed on a retryable error (default 3; clamped to >= 1). */
  maxAttempts?: number
  /** Base backoff between retries, doubled each attempt (default 400 ms). */
  backoffBaseMs?: number
  /** Optional cap for one computed exponential retry wait. */
  maxBackoffMs?: number
  /** Honor retryable-response Retry-After values up to this many milliseconds (default 0 = ignore). */
  maxRetryAfterMs?: number
  /** Optional mutable retry-wait budget, shareable by several getters. */
  retryBudget?: { remainingMs: number }
  /** Injectable sleep; production uses `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
}

export interface WocJsonRequestOpts {
  /** Treat an authoritative HTTP 404 as absence rather than a permanent error. */
  nullOn404?: boolean
  /** Require this exact successful status; other 2xx replies are fail-closed errors. */
  requiredStatus?: number
}

export interface WocJsonGetter {
  (url: string, opts?: WocJsonRequestOpts): Promise<unknown | null>
}

class RetryableWocError extends Error {
  /** Set only when a response carried a usable `Retry-After`, so the default path's error object is unchanged. */
  declare readonly retryAfterMs?: number

  constructor(message: string, retryAfterMs?: number) {
    super(message)
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

const isRetryableStatus = (status: number): boolean => status === 408 || status === 429 || (status >= 500 && status <= 599)

const retryAfterMs = (value: string | null): number | undefined => {
  if (value === null) return undefined
  if (/^\s*-/.test(value)) return undefined
  const seconds = /^\s*(\d+)\s*$/.exec(value)
  if (seconds) {
    const delay = Number(seconds[1]) * 1_000
    return Number.isFinite(delay) ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined
}

/** Build the shared bounded retry loop for WoC JSON GETs. All failures propagate when no authoritative answer exists. */
export const makeWocJsonGetter = (opts: WocJsonClientOpts): WocJsonGetter => {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 20_000
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 3))
  const backoffBaseMs = opts.backoffBaseMs ?? 400
  const maxBackoffMs = opts.maxBackoffMs
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 0
  const retryBudget = opts.retryBudget
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.apiKey && opts.apiKey.trim() !== '') headers['woc-api-key'] = opts.apiKey.trim()

  return async (url: string, requestOpts: WocJsonRequestOpts = {}): Promise<unknown | null> => {
    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        let response: Response
        try {
          response = await fetchImpl(url, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(timeoutMs),
          })
        } catch (error) {
          throw new RetryableWocError(`WoC fetch failed: ${error instanceof Error ? error.message : String(error)}`)
        }

        if (requestOpts.nullOn404 && response.status === 404) return null
        if (!response.ok || (requestOpts.requiredStatus !== undefined && response.status !== requestOpts.requiredStatus)) {
          const message = `WoC GET ${url} -> HTTP ${response.status}`
          throw isRetryableStatus(response.status)
            ? new RetryableWocError(message, maxRetryAfterMs > 0 ? retryAfterMs(response.headers?.get?.('Retry-After') ?? null) : undefined)
            : new Error(message)
        }

        return await response.json() as unknown
      } catch (error) {
        lastError = error
        if (error instanceof RetryableWocError && attempt < maxAttempts) {
          const computedBackoffMs = backoffBaseMs * 2 ** (attempt - 1)
          const cappedBackoffMs = maxBackoffMs === undefined
            ? computedBackoffMs
            : Math.min(computedBackoffMs, Math.max(0, maxBackoffMs))
          const delayMs = error.retryAfterMs === undefined
            ? cappedBackoffMs
            : Math.min(Math.max(cappedBackoffMs, error.retryAfterMs), maxRetryAfterMs)
          if (retryBudget !== undefined && retryBudget.remainingMs <= 0) throw error
          const waitedMs = retryBudget === undefined ? delayMs : Math.min(delayMs, retryBudget.remainingMs)
          await sleep(waitedMs)
          if (retryBudget !== undefined) retryBudget.remainingMs -= waitedMs
          continue
        }
        throw error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('WoC fetch: unreachable')
  }
}
