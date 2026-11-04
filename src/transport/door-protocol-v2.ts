/** Exact, isolated public-door v2 and capability wire codecs. V1 stays in door-protocol.ts. */
import { DOOR_REQUEST_ID_RE, isDoorSwapNamespace, type DoorAsset, type DoorDirection } from './door-protocol'
import type { SettlementMode } from '../bridge/settlement-types'

export const DOOR_CAPABILITIES_BOX_PREFIX = 'petasats:door:capabilities'
export const DOOR_QUOTE_V2_BOX_PREFIX = 'petasats:door:v2:quote'
export const DOOR_SWAP_V2_BOX_PREFIX = 'petasats:door:v2:swap'
export const FAST_CAP_USDC_BASE_UNITS = 25_000_000n

export interface DoorCapabilitiesRequest {
  v: 1
  requestId: string
  supportedDoorVersions: [2, 1]
}
export interface DoorCapabilitiesReply { v: 1; requestId: string; selectedDoorVersion: 2 }
export interface DoorQuoteRequestV2 { v: 2; requestId: string; direction: DoorDirection; asset: DoorAsset; usdcBaseUnits: string }
export type DoorQuoteReplyV2 =
  | { v: 2; requestId: string; ok: true; quoteId: string; direction: DoorDirection; asset: DoorAsset; amountUsd: number; bsvSats: number; usdcBaseUnits: string; midUsdPerBsv: number; expiresAtMs: number; fastOffered: boolean; fastCapUsdcBaseUnits: string }
  | { v: 2; requestId: string; ok: false; reason: string }
export interface DoorSwapRequestV2 { v: 2; requestId: string; quoteId: string; direction: DoorDirection; usdcBaseUnits: string; requestedSettlementMode: SettlementMode }
export type DoorSwapReplyV2 =
  | { v: 2; requestId: string; ok: true; swapNamespace: string; handshakeDeadlineMs: number; settlementMode: SettlementMode; fastCapUsdcBaseUnits: string }
  | { v: 2; requestId: string; ok: false; reason: string }

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}: expected object`)
  return value as Record<string, unknown>
}
function decode(body: string, label: string): Record<string, unknown> {
  try { return object(JSON.parse(Buffer.from(body, 'base64').toString('utf8')), label) } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label}:`)) throw error
    throw new Error(`${label}: malformed base64 JSON`)
  }
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
function id(value: string, label: string): string {
  if (!DOOR_REQUEST_ID_RE.test(value)) throw new Error(`${label}: invalid id`)
  return value
}
function positive(value: number, label: string): number {
  if (!(value > 0)) throw new Error(`${label}: expected positive number`)
  return value
}
const POSITIVE_UNITS = /^[1-9][0-9]*$/
const NONNEGATIVE_UNITS = /^(?:0|[1-9][0-9]*)$/
function units(o: Record<string, unknown>, key: string, label: string, allowZero = false, max = 1_000_000_000n): string {
  const value = str(o, key, label)
  const re = allowZero ? NONNEGATIVE_UNITS : POSITIVE_UNITS
  if (!re.test(value) || BigInt(value) > max) throw new Error(`${label}.${key}: expected canonical ${allowZero ? 'non-negative' : 'positive'} decimal within cap`)
  return value
}
function requestId(o: Record<string, unknown>, label: string): string { return id(str(o, 'requestId', label), `${label}.requestId`) }
function direction(o: Record<string, unknown>, label: string): DoorDirection {
  if (o.direction !== 'usdc_to_bsv') throw new Error(`${label}.direction: unsupported direction`)
  return 'usdc_to_bsv'
}
function asset(o: Record<string, unknown>, label: string): DoorAsset {
  if (o.asset !== 'USDC') throw new Error(`${label}.asset: unsupported asset`)
  return 'USDC'
}
function mode(o: Record<string, unknown>, key: string, label: string): SettlementMode {
  if (o[key] !== 'fast' && o[key] !== 'confirmed') throw new Error(`${label}.${key}: unsupported settlement mode`)
  return o[key] as SettlementMode
}

export function encodeDoorV2(value: DoorCapabilitiesRequest | DoorCapabilitiesReply | DoorQuoteRequestV2 | DoorQuoteReplyV2 | DoorSwapRequestV2 | DoorSwapReplyV2): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}
export function decodeDoorCapabilitiesRequest(body: string): DoorCapabilitiesRequest {
  const label = 'door capabilities request'; const o = decode(body, label)
  fields(o, ['v', 'requestId', 'supportedDoorVersions'], label)
  if (o.v !== 1 || !Array.isArray(o.supportedDoorVersions) || o.supportedDoorVersions.length !== 2 || o.supportedDoorVersions[0] !== 2 || o.supportedDoorVersions[1] !== 1) throw new Error(`${label}: unsupported versions`)
  return { v: 1, requestId: requestId(o, label), supportedDoorVersions: [2, 1] }
}
export function decodeDoorCapabilitiesReply(body: string): DoorCapabilitiesReply {
  const label = 'door capabilities reply'; const o = decode(body, label)
  fields(o, ['v', 'requestId', 'selectedDoorVersion'], label)
  if (o.v !== 1 || o.selectedDoorVersion !== 2) throw new Error(`${label}: unsupported selection`)
  return { v: 1, requestId: requestId(o, label), selectedDoorVersion: 2 }
}
export function decodeDoorQuoteRequestV2(body: string): DoorQuoteRequestV2 {
  const label = 'door v2 quote request'; const o = decode(body, label)
  fields(o, ['v', 'requestId', 'direction', 'asset', 'usdcBaseUnits'], label)
  if (o.v !== 2) throw new Error(`${label}.v: unsupported version`)
  return { v: 2, requestId: requestId(o, label), direction: direction(o, label), asset: asset(o, label), usdcBaseUnits: units(o, 'usdcBaseUnits', label) }
}
export function decodeDoorQuoteReplyV2(body: string): DoorQuoteReplyV2 {
  const label = 'door v2 quote reply'; const o = decode(body, label)
  if (o.v !== 2) throw new Error(`${label}.v: unsupported version`)
  const rid = requestId(o, label)
  if (o.ok === false) { fields(o, ['v', 'requestId', 'ok', 'reason'], label); return { v: 2, requestId: rid, ok: false, reason: str(o, 'reason', label) } }
  if (o.ok !== true) throw new Error(`${label}.ok: expected boolean`)
  fields(o, ['v', 'requestId', 'ok', 'quoteId', 'direction', 'asset', 'amountUsd', 'bsvSats', 'usdcBaseUnits', 'midUsdPerBsv', 'expiresAtMs', 'fastOffered', 'fastCapUsdcBaseUnits'], label)
  const amountUnits = units(o, 'usdcBaseUnits', label)
  const fastCap = units(o, 'fastCapUsdcBaseUnits', label, true, FAST_CAP_USDC_BASE_UNITS)
  if (typeof o.fastOffered !== 'boolean') throw new Error(`${label}.fastOffered: expected boolean`)
  if (o.fastOffered !== (BigInt(fastCap) > 0n && BigInt(amountUnits) <= BigInt(fastCap))) throw new Error(`${label}: fast offer/cap contradiction`)
  const bsvSats = positive(num(o, 'bsvSats', label), `${label}.bsvSats`)
  if (!Number.isSafeInteger(bsvSats)) throw new Error(`${label}.bsvSats: expected safe integer`)
  return { v: 2, requestId: rid, ok: true, quoteId: id(str(o, 'quoteId', label), `${label}.quoteId`), direction: direction(o, label), asset: asset(o, label), amountUsd: positive(num(o, 'amountUsd', label), `${label}.amountUsd`), bsvSats, usdcBaseUnits: amountUnits, midUsdPerBsv: positive(num(o, 'midUsdPerBsv', label), `${label}.midUsdPerBsv`), expiresAtMs: positive(num(o, 'expiresAtMs', label), `${label}.expiresAtMs`), fastOffered: o.fastOffered, fastCapUsdcBaseUnits: fastCap }
}
export function decodeDoorSwapRequestV2(body: string): DoorSwapRequestV2 {
  const label = 'door v2 swap request'; const o = decode(body, label)
  fields(o, ['v', 'requestId', 'quoteId', 'direction', 'usdcBaseUnits', 'requestedSettlementMode'], label)
  if (o.v !== 2) throw new Error(`${label}.v: unsupported version`)
  return { v: 2, requestId: requestId(o, label), quoteId: id(str(o, 'quoteId', label), `${label}.quoteId`), direction: direction(o, label), usdcBaseUnits: units(o, 'usdcBaseUnits', label), requestedSettlementMode: mode(o, 'requestedSettlementMode', label) }
}
export function decodeDoorSwapReplyV2(body: string): DoorSwapReplyV2 {
  const label = 'door v2 swap reply'; const o = decode(body, label)
  if (o.v !== 2) throw new Error(`${label}.v: unsupported version`)
  const rid = requestId(o, label)
  if (o.ok === false) { fields(o, ['v', 'requestId', 'ok', 'reason'], label); return { v: 2, requestId: rid, ok: false, reason: str(o, 'reason', label) } }
  if (o.ok !== true) throw new Error(`${label}.ok: expected boolean`)
  fields(o, ['v', 'requestId', 'ok', 'swapNamespace', 'handshakeDeadlineMs', 'settlementMode', 'fastCapUsdcBaseUnits'], label)
  const ns = str(o, 'swapNamespace', label); if (!isDoorSwapNamespace(ns)) throw new Error(`${label}.swapNamespace: invalid namespace`)
  const selected = mode(o, 'settlementMode', label)
  const cap = units(o, 'fastCapUsdcBaseUnits', label, true, FAST_CAP_USDC_BASE_UNITS)
  if ((selected === 'fast') !== (BigInt(cap) > 0n)) throw new Error(`${label}: settlement mode/cap contradiction`)
  return { v: 2, requestId: rid, ok: true, swapNamespace: ns, handshakeDeadlineMs: positive(num(o, 'handshakeDeadlineMs', label), `${label}.handshakeDeadlineMs`), settlementMode: selected, fastCapUsdcBaseUnits: cap }
}
