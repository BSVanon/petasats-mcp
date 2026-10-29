export const DOOR_QUOTE_BOX_PREFIX = 'petasats:door:quote'
export const DOOR_SWAP_BOX_PREFIX = 'petasats:door:swap'
export const DOOR_QUOTE_REQUEST_BOX = `${DOOR_QUOTE_BOX_PREFIX}:req`
export const DOOR_SWAP_REQUEST_BOX = `${DOOR_SWAP_BOX_PREFIX}:req`
export const doorQuoteReplyBox = (requestId: string): string => `${DOOR_QUOTE_BOX_PREFIX}:res:${requestId}`
export const doorSwapReplyBox = (requestId: string): string => `${DOOR_SWAP_BOX_PREFIX}:res:${requestId}`
export const DOOR_REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/
export type DoorDirection = 'usdc_to_bsv'
export type DoorAsset = 'USDC'
export interface DoorQuoteRequest { v: 1; requestId: string; direction: DoorDirection; asset: DoorAsset; usdcBaseUnits: string }
export type DoorQuoteReply =
  | { v: 1; requestId: string; ok: true; quoteId: string; direction: DoorDirection; asset: DoorAsset; amountUsd: number; bsvSats: number; usdcBaseUnits: string; midUsdPerBsv: number; expiresAtMs: number }
  | { v: 1; requestId: string; ok: false; reason: string }
export interface DoorSwapRequest { v: 1; requestId: string; quoteId: string; direction: DoorDirection; usdcBaseUnits: string }
export type DoorSwapReply =
  | { v: 1; requestId: string; ok: true; swapNamespace: string; handshakeDeadlineMs: number }
  | { v: 1; requestId: string; ok: false; reason: string }

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}: expected object`)
  return value as Record<string, unknown>
}
function fields(o: Record<string, unknown>, wanted: readonly string[], label: string): void {
  const actual = Object.keys(o)
  if (actual.length !== wanted.length || actual.some((key) => !wanted.includes(key))) throw new Error(`${label}: unknown or missing field`)
}
function str(o: Record<string, unknown>, key: string, label: string): string {
  if (typeof o[key] !== 'string') throw new Error(`${label}.${key}: expected string`)
  return o[key] as string
}
function num(o: Record<string, unknown>, key: string, label: string): number {
  if (typeof o[key] !== 'number' || !Number.isFinite(o[key])) throw new Error(`${label}.${key}: expected finite number`)
  return o[key] as number
}
function id(value: string, label: string): string { if (!DOOR_REQUEST_ID_RE.test(value)) throw new Error(`${label}: invalid id`); return value }
function positive(value: number, label: string): number { if (!(value > 0)) throw new Error(`${label}: expected positive number`); return value }
function version(o: Record<string, unknown>, label: string): void { if (o.v !== 1) throw new Error(`${label}.v: unsupported version`) }
function direction(o: Record<string, unknown>, label: string): DoorDirection { const value = str(o, 'direction', label); if (value !== 'usdc_to_bsv') throw new Error(`${label}.direction: unsupported direction`); return value }
function asset(o: Record<string, unknown>, label: string): DoorAsset { const value = str(o, 'asset', label); if (value !== 'USDC') throw new Error(`${label}.asset: unsupported asset`); return value }
const USDC_BASE_UNITS_RE = /^[1-9][0-9]*$/
const MAX_USDC_BASE_UNITS = 1_000_000_000n
function usdcBaseUnits(o: Record<string, unknown>, label: string): string {
  const value = str(o, 'usdcBaseUnits', label)
  if (!USDC_BASE_UNITS_RE.test(value) || BigInt(value) > MAX_USDC_BASE_UNITS) throw new Error(`${label}.usdcBaseUnits: expected canonical positive decimal within cap`)
  return value
}

export function isDoorRequestId(value: unknown): value is string { return typeof value === 'string' && DOOR_REQUEST_ID_RE.test(value) }
export function isDoorSwapNamespace(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) }
export function encodeDoor(value: DoorQuoteRequest | DoorQuoteReply | DoorSwapRequest | DoorSwapReply): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}
function decode(body: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(body, 'base64').toString('utf8')) } catch { throw new Error(`${label}: malformed base64 JSON`) }
  return object(parsed, label)
}
export function decodeDoorQuoteRequest(body: string): DoorQuoteRequest {
  const o = decode(body, 'door quote request'); fields(o, ['v', 'requestId', 'direction', 'asset', 'usdcBaseUnits'], 'door quote request'); version(o, 'door quote request')
  const requestId = id(str(o, 'requestId', 'door quote request'), 'door quote request.requestId')
  const d = direction(o, 'door quote request')
  return { v: 1, requestId, direction: d, asset: asset(o, 'door quote request'), usdcBaseUnits: usdcBaseUnits(o, 'door quote request') }
}
export function decodeDoorQuoteReply(body: string): DoorQuoteReply {
  const o = decode(body, 'door quote reply'); version(o, 'door quote reply')
  const requestId = id(str(o, 'requestId', 'door quote reply'), 'door quote reply.requestId')
  if (o.ok === false) { fields(o, ['v', 'requestId', 'ok', 'reason'], 'door quote reply'); return { v: 1, requestId, ok: false, reason: str(o, 'reason', 'door quote reply') } }
  if (o.ok !== true) throw new Error('door quote reply.ok: expected boolean')
  fields(o, ['v', 'requestId', 'ok', 'quoteId', 'direction', 'asset', 'amountUsd', 'bsvSats', 'usdcBaseUnits', 'midUsdPerBsv', 'expiresAtMs'], 'door quote reply')
  const bsvSats = positive(num(o, 'bsvSats', 'door quote reply'), 'door quote reply.bsvSats')
  if (!Number.isSafeInteger(bsvSats)) throw new Error('door quote reply.bsvSats: expected safe integer')
  const units = usdcBaseUnits(o, 'door quote reply')
  return { v: 1, requestId, ok: true, quoteId: id(str(o, 'quoteId', 'door quote reply'), 'door quote reply.quoteId'), direction: direction(o, 'door quote reply'), asset: asset(o, 'door quote reply'), amountUsd: positive(num(o, 'amountUsd', 'door quote reply'), 'door quote reply.amountUsd'), bsvSats, usdcBaseUnits: units, midUsdPerBsv: positive(num(o, 'midUsdPerBsv', 'door quote reply'), 'door quote reply.midUsdPerBsv'), expiresAtMs: positive(num(o, 'expiresAtMs', 'door quote reply'), 'door quote reply.expiresAtMs') }
}
export function decodeDoorSwapRequest(body: string): DoorSwapRequest {
  const o = decode(body, 'door swap request'); fields(o, ['v', 'requestId', 'quoteId', 'direction', 'usdcBaseUnits'], 'door swap request'); version(o, 'door swap request')
  return { v: 1, requestId: id(str(o, 'requestId', 'door swap request'), 'door swap request.requestId'), quoteId: id(str(o, 'quoteId', 'door swap request'), 'door swap request.quoteId'), direction: direction(o, 'door swap request'), usdcBaseUnits: usdcBaseUnits(o, 'door swap request') }
}
export function decodeDoorSwapReply(body: string): DoorSwapReply {
  const o = decode(body, 'door swap reply'); version(o, 'door swap reply'); const requestId = id(str(o, 'requestId', 'door swap reply'), 'door swap reply.requestId')
  if (o.ok === false) { fields(o, ['v', 'requestId', 'ok', 'reason'], 'door swap reply'); return { v: 1, requestId, ok: false, reason: str(o, 'reason', 'door swap reply') } }
  if (o.ok !== true) throw new Error('door swap reply.ok: expected boolean')
  fields(o, ['v', 'requestId', 'ok', 'swapNamespace', 'handshakeDeadlineMs'], 'door swap reply')
  const swapNamespace = str(o, 'swapNamespace', 'door swap reply')
  if (!isDoorSwapNamespace(swapNamespace)) throw new Error('door swap reply.swapNamespace: invalid namespace')
  return { v: 1, requestId, ok: true, swapNamespace, handshakeDeadlineMs: positive(num(o, 'handshakeDeadlineMs', 'door swap reply'), 'door swap reply.handshakeDeadlineMs') }
}
