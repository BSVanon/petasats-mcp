import { renameSync } from 'fs'
import { join } from 'path'
import { writeSettlementRecordAtomically } from '../../bridge/atomic-record-write'
import { secureFileText, type BuyerHome } from './local-state'
import { listBuyerWithdrawalIntents } from './withdrawal-intent'
import type { BuyerSweepPlan } from './types'

export interface CloseSend { asset: 'USDC' | 'ETH' | 'BSV'; amount: string; to: string; txid: string }
export interface CloseFinal { usdc: string; eth_wei: string; bsv_sats: string }
/** A BSV sweep saved before its broadcast, so a send whose result was lost (a crash, a relay error) is still reported. */
export interface CloseBsvOutbox { txid: string; sats: string; inputs: string[] }

/** close.json in the buyer home: one record per close-down, pinned to one pair of destination addresses. */
export interface CloseRecord {
  baseAddress: string
  bsvAddress: string
  startedAt: number
  sends: CloseSend[]
  closedAt?: number
  /** Balances left behind at close time (usually "0"; dust that cannot be swept otherwise stays here forever). */
  final?: CloseFinal
  bsvOutbox?: CloseBsvOutbox
}

const DECIMAL = /^(?:0|[1-9]\d*)$/
const TXID = /^[0-9a-f]{64}$/i
// The largest valid Date (±8,640,000,000,000,000ms, per ECMA-262): close.ts formats closedAt with new Date(...).toISOString().
// Exported so stop.ts can refuse the same out-of-range STOP.at before close.ts ever copies it into closedAt (m2).
export const MAX_VALID_DATE_MS = 8_640_000_000_000_000
// One coin a sweep spends: "<txid>.<vout>", as runtime.ts builds each input for beforeBroadcast.
const OUTPOINT = /^[0-9a-f]{64}\.(?:0|[1-9]\d*)$/i
const ASSETS = new Set(['USDC', 'ETH', 'BSV'])
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isDecimal = (value: unknown): value is string => typeof value === 'string' && DECIMAL.test(value)
const isSend = (value: unknown): value is CloseSend =>
  isObject(value) && typeof value.asset === 'string' && ASSETS.has(value.asset) && isDecimal(value.amount) && typeof value.to === 'string' && typeof value.txid === 'string'
const isFinal = (value: unknown): value is CloseFinal => isObject(value) && isDecimal(value.usdc) && isDecimal(value.eth_wei) && isDecimal(value.bsv_sats)
const isOutbox = (value: unknown): value is CloseBsvOutbox => isObject(value) && isDecimal(value.sats) && isSweepShape(value.txid, BigInt(value.sats), value.inputs)

/**
 * The one shape check for a BSV sweep, used before its broadcast (close.ts) and for the one saved in close.json: a
 * 64-hex txid, at least 1 sat, and one or more inputs, each "<64-hex txid>.<vout>".
 */
export function isSweepShape(txid: unknown, sats: unknown, inputs: unknown): boolean {
  return typeof txid === 'string' && TXID.test(txid) && typeof sats === 'bigint' && sats >= 1n &&
    Array.isArray(inputs) && inputs.length > 0 && inputs.every((input) => typeof input === 'string' && OUTPOINT.test(input))
}

const recordErrors = new WeakSet<object>()
/**
 * Marks an error from reading the kit's own records that is not a filesystem error: a record that does not parse or
 * is not valid. No retry clears it, so close.ts refuses without retry_after_seconds. A filesystem error keeps its code.
 */
export function markRecordError(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code !== 'string') recordErrors.add(error)
  return error
}
export const isRecordError = (error: unknown): boolean => typeof error === 'object' && error !== null && recordErrors.has(error)

/** The kit's Base withdrawal records, with a record error marked as above. */
export function kitWithdrawals(paths: BuyerHome): ReturnType<typeof listBuyerWithdrawalIntents> {
  try { return listBuyerWithdrawalIntents(paths) } catch (error) { throw markRecordError(error) }
}

export function closeRecordPath(paths: BuyerHome): string {
  return join(paths.home, 'close.json')
}

/** undefined when there is no close.json; throws for anything else that is not a valid record. */
export function readCloseRecord(paths: BuyerHome): CloseRecord | undefined {
  let text: string
  try {
    text = secureFileText(closeRecordPath(paths))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value = JSON.parse(text) as unknown
  // closedAt names the archive file and feeds a Date, and final feeds BigInt: check their types, not only presence.
  if (!isObject(value) || typeof value.baseAddress !== 'string' || typeof value.bsvAddress !== 'string' || typeof value.startedAt !== 'number' ||
    !Number.isSafeInteger(value.startedAt) || value.startedAt > MAX_VALID_DATE_MS || !Array.isArray(value.sends) || !value.sends.every(isSend) ||
    (value.closedAt !== undefined && (typeof value.closedAt !== 'number' || !Number.isSafeInteger(value.closedAt) || value.closedAt < 0 || value.closedAt > MAX_VALID_DATE_MS)) ||
    (value.final !== undefined && !isFinal(value.final)) || (value.bsvOutbox !== undefined && !isOutbox(value.bsvOutbox))) {
    throw new Error('close.json has invalid contents')
  }
  return {
    baseAddress: value.baseAddress, bsvAddress: value.bsvAddress, startedAt: value.startedAt, sends: value.sends,
    ...(value.closedAt === undefined ? {} : { closedAt: value.closedAt }), ...(value.final === undefined ? {} : { final: value.final }),
    ...(value.bsvOutbox === undefined ? {} : { bsvOutbox: value.bsvOutbox }),
  }
}

export function writeCloseRecord(paths: BuyerHome, record: CloseRecord): void {
  writeSettlementRecordAtomically(closeRecordPath(paths), JSON.stringify(record, null, 2) + '\n', 0o600)
}

/** The user resumed after this close-down finished: keep it as close-<closedAt>.json so a new one may use a new pair. */
export function archiveCloseRecord(paths: BuyerHome, closedAt: number): void {
  renameSync(closeRecordPath(paths), join(paths.home, `close-${closedAt}.json`))
}

/** The sends on disk, for a refusal that has no record in hand. Best effort: never throws. */
export function sendsOnDisk(paths: BuyerHome): CloseSend[] {
  try { return readCloseRecord(paths)?.sends ?? [] } catch { return [] }
}

/** Adds a send once: a txid already listed (in any letter case) is never listed again. */
export function withSend(record: CloseRecord, send: CloseSend): CloseRecord {
  const txid = send.txid.toLowerCase()
  return record.sends.some((s) => s.txid.toLowerCase() === txid) ? record : { ...record, sends: [...record.sends, send] }
}

/**
 * Adds every Base withdrawal of this close-down that resolved as sent, wherever it was resolved (a close_kit call,
 * another tool's reconcile, or the terminal's `withdrawal <hash> sent`): to the pinned Base address and created at or
 * after startedAt. A withdrawal made before this close-down started is never listed.
 */
export function withBaseSends(paths: BuyerHome, record: CloseRecord): CloseRecord {
  const base = record.baseAddress.toLowerCase()
  return kitWithdrawals(paths)
    .filter((w) => w.state === 'done' && (w.status === 'success' || w.status === 'sent') && w.to.toLowerCase() === base && w.createdAtMs >= record.startedAt)
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .reduce((next, w) => withSend(next, { asset: w.asset, amount: w.amount, to: w.to, txid: w.hash }), record)
}

/**
 * A pin nothing has used yet may move to a new pair: no send, no saved BSV sweep, no final balances, and no Base
 * withdrawal to the pinned address created at or after startedAt (pending or done).
 */
export function pinUnused(paths: BuyerHome, record: CloseRecord): boolean {
  const base = record.baseAddress.toLowerCase()
  return record.sends.length === 0 && !record.bsvOutbox && !record.final &&
    !kitWithdrawals(paths).some((w) => w.to.toLowerCase() === base && w.createdAtMs >= record.startedAt)
}

/**
 * The record once a new BSV sweep is saved, before its broadcast. A sweep spends all of its inputs at once, so a saved
 * earlier sweep that shares no input with the new one went out (its inputs are spent): it is listed once. One that
 * shares an input never went out, and the new sweep replaces it; the same txid is the same sweep rebuilt.
 * The sent list comes from the kit's own records; a block explorer shows the addresses' full history.
 */
export function withBsvSweep(record: CloseRecord, sweep: BuyerSweepPlan): CloseRecord {
  const saved = record.bsvOutbox
  const next = saved && saved.txid.toLowerCase() !== sweep.txid.toLowerCase() && !saved.inputs.some((input) => sweep.inputs.includes(input))
    ? withSend(record, { asset: 'BSV', amount: saved.sats, to: record.bsvAddress, txid: saved.txid })
    : record
  return { ...next, bsvOutbox: { txid: sweep.txid, sats: sweep.sats.toString(), inputs: [...sweep.inputs] } }
}

/** The saved sweep went out: list it once (or the send the kit returned for it) and clear the entry. */
export function withBsvSweepSent(record: CloseRecord, send?: CloseSend): CloseRecord {
  const { bsvOutbox: saved, ...rest } = record
  const sent = send ?? (saved ? { asset: 'BSV' as const, amount: saved.sats, to: record.bsvAddress, txid: saved.txid } : undefined)
  return sent ? withSend(rest, sent) : rest
}
