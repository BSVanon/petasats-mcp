/** Run one request with a cancellable local timeout composed with its lifecycle signal. */
export async function withRequestTimeout<T>(
  timeoutMs: number,
  lifecycle: AbortSignal | undefined,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error(`request timeout must be finite and non-negative (got ${String(timeoutMs)})`)
  lifecycle?.throwIfAborted()
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(lifecycle?.reason)
  lifecycle?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs)
  let onRequestAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onRequestAbort = () => reject(controller.signal.reason instanceof Error
      ? controller.signal.reason
      : new Error(controller.signal.reason === undefined ? 'request aborted' : String(controller.signal.reason)))
    controller.signal.addEventListener('abort', onRequestAbort, { once: true })
    if (controller.signal.aborted) onRequestAbort()
  })
  let succeeded = false
  let lastValue: unknown
  try {
    // Some defence-in-depth callers wrap clients whose method cannot consume AbortSignal. The race enforces the local
    // bound even for such a non-cooperative request; cooperative fetch clients still receive the same signal as before.
    const value = await Promise.race([request(controller.signal), aborted])
    succeeded = true
    lastValue = value
    return value
  } finally {
    lifecycle?.removeEventListener('abort', onAbort)
    if (onRequestAbort) controller.signal.removeEventListener('abort', onRequestAbort)
    if (succeeded && typeof Response !== 'undefined' && lastValue instanceof Response) {
      // A fetch Response's body is read AFTER this returns and stays tied to this signal, so aborting here would abort
      // that read. Leave the deadline running, unref'd like AbortSignal.timeout, so it still bounds the body read
      // without holding the process open; aborting an exchange whose body was already read is a no-op. A lifecycle
      // stop no longer reaches that body read (its listener is gone); the deadline alone bounds it, as in 6876de9.
      timer.unref()
    } else if (succeeded) {
      // Any other result is complete: nothing is left for the deadline to bound, so release it now.
      clearTimeout(timer)
    } else {
      clearTimeout(timer)
      controller.abort()
    }
  }
}

/** A sleep which clears its timer and listener on either completion or lifecycle cancellation. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve()
    }
    const onAbort = (): void => finish(signal?.reason instanceof Error ? signal.reason : new Error(signal?.reason === undefined ? 'operation aborted' : String(signal.reason)))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    if (!settled) timer = setTimeout(() => finish(), Math.max(0, ms))
  })
}
