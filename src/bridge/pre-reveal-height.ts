import { retryOnSchedule } from '../wallet/bounded-retry'
/** Thirteen waits, fourteen reads: about one BSV block, bounded before an irreversible reveal. */
export const PRE_REVEAL_READ_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]
/** Read the height once after write-ahead; otherwise retry only a failed, side-effect-free pre-reveal read. */
export function makePreRevealHeightRead(opts: {
  read: (signal?: AbortSignal) => Promise<number>
  revealed: () => boolean
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
  log: (msg: string) => void
  delaysMs?: readonly number[]
}): (maxRetryWaitMs?: number, signal?: AbortSignal) => Promise<number> {
  // The optional budget is used only by the runway-bound lock wait; every existing reveal call keeps the full schedule.
  return (maxRetryWaitMs?: number, signal = opts.signal) => {
    const configured = opts.delaysMs ?? PRE_REVEAL_READ_RETRY_DELAYS_MS
    let delaysMs = configured
    if (maxRetryWaitMs !== undefined) {
      let remaining = Math.max(0, maxRetryWaitMs)
      const bounded: number[] = []
      for (const delay of configured) {
        if (remaining <= 0) break
        const boundedDelay = Math.min(delay, remaining)
        bounded.push(boundedDelay)
        remaining -= boundedDelay
      }
      delaysMs = bounded
    }
    return opts.revealed()
      ? opts.read(signal)
      : retryOnSchedule(() => opts.read(signal), { delaysMs, sleep: (ms) => opts.sleep(ms, signal), log: opts.log, retryable: () => true, what: 'BSV height before the reveal: the chain read failed', again: 'reading again' })
  }
}
