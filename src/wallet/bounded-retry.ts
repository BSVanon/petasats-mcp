/**
 * Bounded retry on a fixed delay schedule (D2 drill, 2026-09-27). Runs `call`; when it throws an error `retryable`
 * accepts, it waits the next delay and calls again. Anything else, or a retryable error after the last delay, rethrows
 * unchanged, so the caller's own failure path runs. `sleep` is injected so the caller's clock (and tests) own time.
 *
 * Shared by the brain's re-ask of the isolated signer (signer-ipc/transient-refusal.ts) and the brain's own pre-lock
 * chain reads (market-maker/pre-lock-reads.ts).
 */
import { logSafeError } from '../observability/log-safe'

export interface RetryScheduleOpts {
  /** The waits between attempts: `delaysMs.length + 1` attempts in all. */
  delaysMs: readonly number[]
  sleep: (ms: number) => Promise<void>
  log: (msg: string) => void
}

export async function retryOnSchedule<T>(
  call: () => Promise<T>,
  opts: RetryScheduleOpts & {
    /** Only an error this accepts is retried. */
    retryable: (error: unknown) => boolean
    /** The log line's lead ("fund-lock: the signer refused for a transient reason") and its verb ("asking again"). */
    what: string
    again: string
  },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (attempt >= opts.delaysMs.length || !opts.retryable(error)) throw error
      const delayMs = opts.delaysMs[attempt]
      opts.log(`${opts.what} (attempt ${attempt + 1} of ${opts.delaysMs.length + 1}); ${opts.again} in ${Math.round(delayMs / 1000)}s: ${logSafeError(error)}`)
      await opts.sleep(delayMs)
    }
  }
}
