import type { Transaction } from '@bsv/sdk'
import { guardInitiatorRevealRunway } from './settlement-session'

const SLOW_PROGRESS_INTERVAL_MS = 10 * 60_000

export interface WaitForLockTxOptions {
  txid: string
  fetchTx: (txid: string) => Promise<Transaction | null>
  fastMaxTries: number
  fastRetryMs: number
  untilRevealRunway: boolean
  slowRetryMs: number
  maxWaitMs: number
  bsvRefundLocktime: number
  revealHeight: (maxRetryWaitMs?: number) => Promise<number>
  nowMs: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  log: (message: string) => void
  signal?: AbortSignal
  /** Injectable only so deadline races can use a synthetic clock in tests. */
  deadlineTimer?: (ms: number, elapsed: () => void) => () => void
}

type Bounded<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'deadline' }

/** Fetch an announced lock with the legacy fast loop and an optional runway-bound slow phase. */
export async function waitForLockTx(opts: WaitForLockTxOptions): Promise<Transaction> {
  const startedAt = opts.untilRevealRunway ? opts.nowMs() : 0
  const deadline = startedAt + opts.maxWaitMs
  const remainingMs = (): number => deadline - opts.nowMs()
  const startTimer = opts.deadlineTimer ?? ((ms: number, elapsed: () => void) => {
    const timer = setTimeout(elapsed, ms)
    return () => clearTimeout(timer)
  })
  const abortError = (): Error => opts.signal?.reason instanceof Error
    ? opts.signal.reason
    : new Error(opts.signal?.reason === undefined ? 'lock transaction wait aborted' : String(opts.signal.reason))
  const throwIfAborted = (): void => { if (opts.signal?.aborted) throw abortError() }

  // Both fulfillment and rejection are handled even after the timer/abort wins, so a late read is safely ignored.
  const boundedRead = <T>(read: (remaining: number, signal: AbortSignal) => Promise<T>): Promise<Bounded<T>> => {
    throwIfAborted()
    const remaining = remainingMs()
    if (remaining <= 0) return Promise.resolve({ kind: 'deadline' })
    return new Promise<Bounded<T>>((resolve, reject) => {
      let done = false
      let cancelTimer = (): void => {}
      const readAbort = new AbortController()
      const cleanup = (): void => {
        cancelTimer()
        opts.signal?.removeEventListener('abort', onAbort)
        readAbort.abort()
      }
      const finish = (result: Bounded<T>): void => {
        if (done) return
        done = true
        cleanup()
        resolve(result)
      }
      const fail = (error: unknown): void => {
        if (done) return
        done = true
        cleanup()
        reject(error)
      }
      const onAbort = (): void => fail(abortError())
      cancelTimer = startTimer(remaining, () => finish({ kind: 'deadline' }))
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (opts.signal?.aborted) { onAbort(); return }
      const readRemaining = remainingMs()
      if (readRemaining <= 0) { finish({ kind: 'deadline' }); return }
      let pending: Promise<T>
      try { pending = Promise.resolve(read(readRemaining, readAbort.signal)) } catch (error) { pending = Promise.reject(error) }
      pending.then(
        (value) => {
          if (opts.signal?.aborted) { fail(abortError()); return }
          finish(remainingMs() <= 0 ? { kind: 'deadline' } : { kind: 'value', value })
        },
        (error) => {
          if (opts.signal?.aborted) { fail(abortError()); return }
          finish(remainingMs() <= 0 ? { kind: 'deadline' } : { kind: 'error', error })
        },
      )
    })
  }

  let attempts = 0
  let lastFetchError = ''
  let stopReason: string | undefined
  const ceiling = (): void => { stopReason = `lock lookup ceiling ${opts.maxWaitMs}ms elapsed` }
  const baseError = (tries: number): string =>
    `responder's BSV lock tx ${opts.txid} not found on-chain after ${tries} tries${lastFetchError ? ` (last error: ${lastFetchError})` : ''} — refusing to reveal`
  const fetchLegacy = async (): Promise<Transaction | null> => {
    attempts += 1
    return opts.fetchTx(opts.txid).catch((error: unknown) => {
      lastFetchError = error instanceof Error ? error.message : String(error)
      return null
    })
  }
  const fetchBounded = async (): Promise<Transaction | null> => {
    const result = await boundedRead(() => { attempts += 1; return opts.fetchTx(opts.txid) })
    throwIfAborted()
    if (result.kind === 'deadline') { ceiling(); return null }
    if (result.kind === 'error') {
      lastFetchError = result.error instanceof Error ? result.error.message : String(result.error)
      return null
    }
    return result.value
  }
  const pauseBounded = async (ms: number): Promise<boolean> => {
    const result = await boundedRead((remaining, signal) => opts.sleep(Math.min(ms, remaining), signal))
    throwIfAborted()
    if (result.kind === 'deadline') { ceiling(); return false }
    if (result.kind === 'error') throw result.error
    return true
  }

  let lockTx: Transaction | null = null
  for (let i = 0; i < opts.fastMaxTries && !lockTx && !stopReason; i++) {
    if (i > 0) {
      if (i === 1) opts.log(`responder's BSV lock ${opts.txid.slice(0, 12)}… not visible yet — re-checking every ${opts.fastRetryMs}ms (up to ${opts.fastMaxTries} tries)…`)
      if (opts.untilRevealRunway) {
        const keepWaiting = await pauseBounded(opts.fastRetryMs)
        throwIfAborted()
        if (!keepWaiting) break
      } else if (opts.signal) {
        throwIfAborted()
        await opts.sleep(opts.fastRetryMs, opts.signal)
        throwIfAborted()
      } else {
        await opts.sleep(opts.fastRetryMs)
      }
    }
    if (opts.untilRevealRunway) {
      lockTx = await fetchBounded()
      opts.signal?.throwIfAborted()
    } else if (opts.signal) {
      throwIfAborted()
      lockTx = await fetchLegacy()
      throwIfAborted()
    } else {
      lockTx = await fetchLegacy()
    }
  }
  if (lockTx) { opts.signal?.throwIfAborted(); return lockTx }
  if (!opts.untilRevealRunway) throw new Error(baseError(opts.fastMaxTries))

  let lastProgressAt = Number.NEGATIVE_INFINITY
  const runwayIsOpen = async (): Promise<boolean> => {
    const result = await boundedRead((remaining) => opts.revealHeight(remaining))
    throwIfAborted()
    if (result.kind === 'deadline') { ceiling(); return false }
    const height = result.kind === 'value' ? result.value : undefined
    if (height !== undefined) {
      const gate = guardInitiatorRevealRunway(opts.bsvRefundLocktime, height)
      if (!gate.ok) { stopReason = `reveal runway closed: ${gate.reason}`; return false }
      if (opts.nowMs() - lastProgressAt >= SLOW_PROGRESS_INTERVAL_MS) {
        opts.log(`responder's BSV lock ${opts.txid.slice(0, 12)}… still not visible — ${opts.bsvRefundLocktime - height} block(s) of reveal runway left; slow re-check every ${opts.slowRetryMs}ms`)
        lastProgressAt = opts.nowMs()
      }
    }
    return true
  }

  if (!stopReason) {
    const open = await runwayIsOpen()
    throwIfAborted()
    if (open) {
      while (!stopReason) {
        const keepWaiting = await pauseBounded(opts.slowRetryMs)
        throwIfAborted()
        if (!keepWaiting) break
        const runwayOpen = await runwayIsOpen()
        throwIfAborted()
        if (!runwayOpen) break
        lockTx = await fetchBounded()
        opts.signal?.throwIfAborted()
        if (lockTx) { opts.signal?.throwIfAborted(); return lockTx }
      }
    }
  }

  throw new Error(`${baseError(attempts)} (${stopReason})`)
}
