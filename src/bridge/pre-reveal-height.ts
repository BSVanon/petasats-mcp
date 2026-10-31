import { retryOnSchedule } from '../wallet/bounded-retry'
/** Thirteen waits, fourteen reads: about one BSV block, bounded before an irreversible reveal. */
export const PRE_REVEAL_READ_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]
/** Read the height once after write-ahead; otherwise retry only a failed, side-effect-free pre-reveal read. */
export function makePreRevealHeightRead(opts: {
  read: () => Promise<number>
  revealed: () => boolean
  sleep: (ms: number) => Promise<void>
  log: (msg: string) => void
  delaysMs?: readonly number[]
}): () => Promise<number> {
  return () => opts.revealed()
    ? opts.read()
    : retryOnSchedule(opts.read, { delaysMs: opts.delaysMs ?? PRE_REVEAL_READ_RETRY_DELAYS_MS, sleep: opts.sleep, log: opts.log, retryable: () => true, what: 'BSV height before the reveal: the chain read failed', again: 'reading again' })
}
