/**
 * buy_gas state. <home>/gas-topup.json holds the current gas order: it is written atomically, owner-only, and before
 * the order is posted. gas-topups.jsonl is the append-only history of finished orders. A file that cannot be read is
 * never overwritten: every caller refuses with one fixed message that tells the user to inspect it.
 */
import { closeSync, constants, fstatSync, fsyncSync, openSync, writeSync } from 'fs'
import { join } from 'path'
import type { Address } from 'viem'
import { syncNewEntry, writeSettlementRecordAtomically } from '../../bridge/atomic-record-write'
import { buildGasOrder, hashAppData, orderUid } from './gas-topup-order'
import { secureFileText } from './local-state'

export type GasTopUpStatus = 'signed' | 'posted' | 'filled' | 'expired' | 'rejected'
export interface GasTopUpRecord {
  uid: string
  owner: string
  sellAmount: string
  buyAmountMin: string
  validTo: number
  permitNonce: string
  appDataHash: string
  /** The exact appData JSON that was hashed and signed; re-posting sends it again unchanged. */
  appData: string
  /** The order signature, kept so a re-post sends the same signed order and never a second one. */
  signature: string
  quoteId?: number
  signedAt: number
  postedAt?: number
  /** The order book's last answer, reported only: it never ends the record. */
  status: GasTopUpStatus
  reason?: string
  executedBuyAmount?: string
  /** Set once the chain shows the order can no longer spend: filled on chain, or past validTo plus the grace. */
  over?: true
  /** The Base block (a decimal string) of the read that set over; a new order is signed only from a read at or after it. */
  overAtBlock?: string
}

export const GAS_TOPUP_FILE = 'gas-topup.json'
export const GAS_TOPUP_HISTORY_FILE = 'gas-topups.jsonl'
/** withdrawBase's one fixed message while a gas order may still take the USDC; close.ts maps it to in_progress. */
export const GAS_TOPUP_WAIT_MESSAGE = 'a gas purchase (buy_gas) is still finishing and may still use 0.50 USDC of this balance; nothing was sent; call again in 30 s'
export const GAS_TOPUP_SWAP_MESSAGE = 'a gas purchase is still finishing; call again in 30 s'
export const BUY_GAS_HINT = "send a little ETH to the kit's Base address, or, with the user's yes, call buy_gas (it uses 0.50 USDC of the kit's own balance to buy ETH for gas)"
/** An expired order whose filledAmount reads 0 while the permit nonce has moved: a fill may have been cleared after validTo. */
export const GAS_TOPUP_MAY_HAVE_FILLED = 'the order may have filled before it expired; check wallet_info for the ETH'

const STATUSES = new Set<GasTopUpStatus>(['signed', 'posted', 'filled', 'expired', 'rejected'])
const DECIMAL = /^(?:0|[1-9]\d{0,77})$/
const O_NOFOLLOW = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

export class GasTopUpUnreadableError extends Error {
  constructor(home: string, detail: string) {
    super(`${GAS_TOPUP_FILE} in ${home} cannot be read (${detail}). It records this kit's gas purchase. Inspect it: an order it lists can spend 0.50 USDC until it fills or expires, at most 20 minutes after it was signed. Then move it aside, for example rename it to ${GAS_TOPUP_FILE}.bad, and call again. Nothing was sent.`)
    this.name = 'GasTopUpUnreadableError'
  }
}

export function gasTopUpPath(home: string): string {
  return join(home, GAS_TOPUP_FILE)
}

/**
 * A record of any status keeps blocking (a new gas order, USDC withdrawals, close-down and new swaps) until the chain
 * shows that its order can no longer spend. The order book's answers never end it.
 */
export function isOpenGasTopUp(record: Pick<GasTopUpRecord, 'over'>): boolean {
  return record.over !== true
}

function validRecord(value: unknown): value is GasTopUpRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Partial<Record<keyof GasTopUpRecord, unknown>>
  const safeInteger = (x: unknown): boolean => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
  return typeof r.uid === 'string' && /^0x[0-9a-fA-F]{112}$/.test(r.uid)
    && typeof r.owner === 'string' && /^0x[0-9a-fA-F]{40}$/.test(r.owner)
    && r.sellAmount === '500000'
    && typeof r.buyAmountMin === 'string' && DECIMAL.test(r.buyAmountMin)
    && safeInteger(r.validTo) && (r.validTo as number) > 0 && (r.validTo as number) <= 0xffff_ffff
    && typeof r.permitNonce === 'string' && DECIMAL.test(r.permitNonce)
    && typeof r.appDataHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r.appDataHash)
    && typeof r.appData === 'string' && r.appData.length > 0
    && typeof r.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(r.signature)
    && (r.quoteId === undefined || safeInteger(r.quoteId))
    && safeInteger(r.signedAt) && (r.postedAt === undefined || safeInteger(r.postedAt))
    && typeof r.status === 'string' && STATUSES.has(r.status as GasTopUpStatus)
    && (r.reason === undefined || typeof r.reason === 'string')
    && (r.executedBuyAmount === undefined || (typeof r.executedBuyAmount === 'string' && DECIMAL.test(r.executedBuyAmount)))
    && (r.overAtBlock === undefined || (typeof r.overAtBlock === 'string' && DECIMAL.test(r.overAtBlock)))
    && (r.over === undefined || (r.over === true && r.overAtBlock !== undefined))
}

/** undefined when there is no file; GasTopUpUnreadableError for anything else that is not a valid record. */
export function readGasTopUp(home: string): GasTopUpRecord | undefined {
  let text: string
  try {
    text = secureFileText(gasTopUpPath(home))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new GasTopUpUnreadableError(home, error instanceof Error ? error.message : String(error))
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new GasTopUpUnreadableError(home, 'it is not valid JSON') }
  if (!validRecord(value)) throw new GasTopUpUnreadableError(home, 'its contents are not a gas purchase record')
  return value
}

/**
 * The one check every caller (buy_gas, its waits, close-down) makes before acting on the record: its shape, that it is
 * this kit's, and that its fields rebuild exactly the order its uid names. Anything else is GasTopUpUnreadableError.
 */
export function loadGasTopUp(home: string, owner: string): GasTopUpRecord | undefined {
  const record = readGasTopUp(home)
  if (!record) return undefined
  if (record.owner.toLowerCase() !== owner.toLowerCase()) throw new GasTopUpUnreadableError(home, "it names another wallet's order")
  let matches = false
  try {
    const appData = hashAppData(record.appData)
    const order = buildGasOrder({ owner: owner as Address, buyAmount: BigInt(record.buyAmountMin), validTo: record.validTo, appDataHash: appData.hash })
    matches = appData.hash === record.appDataHash.toLowerCase() && orderUid(order, owner as Address) === record.uid.toLowerCase()
  } catch { matches = false } // a field no order can carry (a buy amount past uint256, say)
  if (!matches) throw new GasTopUpUnreadableError(home, 'its order does not match its uid')
  return record
}

export function writeGasTopUp(home: string, record: GasTopUpRecord): void {
  writeSettlementRecordAtomically(gasTopUpPath(home), JSON.stringify(record, null, 2) + '\n', 0o600)
}

function historyText(home: string): string {
  try { return secureFileText(join(home, GAS_TOPUP_HISTORY_FILE)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function parseHistory(text: string): GasTopUpRecord[] {
  const records: GasTopUpRecord[] = []
  for (const line of text.split('\n')) {
    try { const value = JSON.parse(line) as unknown; if (validRecord(value)) records.push(value) } catch { /* a torn line */ }
  }
  return records
}

/** Every history line that parses; a torn last line from a crash is skipped, never repaired in place. */
export function readGasTopUpHistory(home: string): GasTopUpRecord[] {
  return parseHistory(historyText(home))
}

/** Append a finished record once (by uid and status), fsynced, before a new record replaces it. */
export function archiveGasTopUp(home: string, record: GasTopUpRecord): void {
  if (isOpenGasTopUp(record)) throw new Error('an open gas purchase is never archived')
  const path = join(home, GAS_TOPUP_HISTORY_FILE)
  const existing = historyText(home)
  if (parseHistory(existing).some((line) => line.uid === record.uid && line.status === record.status)) return
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW, 0o600)
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`unsafe local file ${path}; replace it with a regular file`)
    writeSync(fd, `${existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}${JSON.stringify(record)}\n`)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  if (existing.length === 0) syncNewEntry(path)
}
