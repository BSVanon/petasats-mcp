/**
 * One log-safe line from an error or a failure reason. viem errors span many lines and embed the RPC URL and request
 * body, and a keyed RPC URL carries its key in the path, query, or userinfo — so whitespace is collapsed, every URL is
 * cut to scheme + host, and the line is capped. For log lines only: never match a check against this text.
 */
export function logSafeError(error: unknown, maxChars = 300): string {
  const raw = error instanceof Error ? error.message : String(error)
  const line = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/((?:https?|wss?):\/\/)(?:[^@/\s?#]*@)?([^/\s?#]+)\S*/gi, '$1$2/…')
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line
}
