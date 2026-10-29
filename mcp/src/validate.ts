/** Arg validation + MCP result helpers for the PetaSats tool handlers. */

/** A caller supplied a missing/ill-typed argument — reported back as a tool error, not a crash. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}

type Args = Record<string, unknown> | undefined

export function requireString(a: Args, key: string): string {
  const v = a?.[key]
  if (typeof v !== 'string' || v.length === 0) throw new ToolInputError(`missing or empty required string '${key}'`)
  return v
}

export function optionalString(a: Args, key: string): string | undefined {
  const v = a?.[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ToolInputError(`'${key}' must be a string`)
  return v
}

export function optionalObject(a: Args, key: string): Record<string, unknown> | undefined {
  const v = a?.[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw new ToolInputError(`'${key}' must be an object`)
  return v as Record<string, unknown>
}

/** Parse a required non-negative integer amount supplied as a decimal STRING (atomic units, no float loss). */
export function requireAmount(a: Args, key: string): bigint {
  const v = a?.[key]
  const s = typeof v === 'number' ? String(v) : v
  if (typeof s !== 'string' || !/^[0-9]+$/.test(s)) throw new ToolInputError(`'${key}' must be a non-negative integer amount as a string (atomic units)`)
  const n = BigInt(s)
  if (n < 1n) throw new ToolInputError(`'${key}' must be >= 1`)
  return n
}

/** bigint-safe JSON (atomic amounts are bigints; JSON can't serialize them → emit as strings). */
function jsonSafe(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v
}

/** A successful MCP tool result (text content carrying the JSON payload). */
export function success(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, jsonSafe, 2) }] }
}

/** A tool-level error result (isError=true so the agent sees it as a failure, not a value). */
export function toolError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, jsonSafe, 2) }], isError: true }
}

export function toolErrorData(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ error }, jsonSafe, 2) }], isError: true }
}
