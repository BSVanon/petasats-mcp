export interface ParsedRetryAfter {
  base: string
  retryAfterS?: number
}

/** Append a coarse, bounded retry hint without changing the strict door wire shape. */
export function withRetryAfter(reason: string, retryAfterMs: number): string {
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return reason
  let seconds = Math.min(86_400, Math.max(1, Math.ceil(retryAfterMs / 1_000)))
  if (seconds > 60) seconds = Math.ceil(seconds / 60) * 60
  return `${reason} (retry after ${seconds}s)`
}

/** Parse only the canonical end suffix; every other reason remains byte-for-byte the base. */
export function parseRetryAfter(reason: string): ParsedRetryAfter {
  const match = / \(retry after (\d{1,5})s\)$/.exec(reason)
  return match
    ? { base: reason.slice(0, -match[0].length), retryAfterS: Number(match[1]) }
    : { base: reason }
}
