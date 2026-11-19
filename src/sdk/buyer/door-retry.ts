import { parseRetryAfter } from '../../transport/door-retry-after'
import { DoorDeclineError } from './door-client'

const MAX_RETRY_AFTER_S = 20
const MAX_RETRIES = 2
const MAX_WAIT_MS = 45_000

export interface DoorRetryOptions {
  stage: 'quote' | 'admission'
  wait: (ms: number, shouldStop: () => boolean, signal?: AbortSignal) => Promise<boolean>
  shouldStop: () => boolean
  signal?: AbortSignal
  log: (message: string) => void
  canWait?: (waitMs: number) => boolean
}

function baseReason(error: DoorDeclineError): string {
  const match = /^The counterparty declined this request: (.*)\. Nothing was locked\.$/.exec(error.decline.message)
  return parseRetryAfter(match?.[1] ?? error.decline.message).base
}

/** Retry only explicitly hinted door declines, before the caller crosses its admission/lock boundary. */
export async function callDoorWithRetry<T>(call: () => Promise<T>, opts: DoorRetryOptions): Promise<T> {
  let retries = 0
  let waitedMs = 0
  for (;;) {
    try { return await call() } catch (error) {
      if (!(error instanceof DoorDeclineError)) throw error
      const seconds = error.decline.retry_after_s
      const waitMs = seconds === undefined ? 0 : seconds * 1_000
      if (seconds === undefined || seconds > MAX_RETRY_AFTER_S || retries >= MAX_RETRIES || waitedMs + waitMs > MAX_WAIT_MS || opts.canWait?.(waitMs) === false) throw error
      opts.log(`retrying door ${opts.stage} after ${baseReason(error)}; waiting ${seconds}s`)
      // canWait is checked again after the wait: a late timer must not send a request on a quote that is no longer valid.
      if (opts.shouldStop() || !await opts.wait(waitMs, opts.shouldStop, opts.signal) || opts.shouldStop() || opts.canWait?.(0) === false) throw error
      retries++
      waitedMs += waitMs
    }
  }
}

/** Abortable production wait; STOP is polled so it prevents the next request. */
export async function waitForDoorRetry(ms: number, shouldStop: () => boolean, signal?: AbortSignal): Promise<boolean> {
  for (let remaining = ms; remaining > 0;) {
    if (shouldStop() || signal?.aborted) return false
    const slice = Math.min(100, remaining)
    const completed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(true) }, slice)
      const aborted = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); resolve(false) }
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
    if (!completed) return false
    remaining -= slice
  }
  return !shouldStop() && !signal?.aborted
}
