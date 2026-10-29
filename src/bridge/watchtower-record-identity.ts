import type { SettlementRecord } from './settlement-session'

/** The complete EVM swap tuple plus its owner role. Hashlocks are intentionally not unique swap identifiers. */
export interface WatchtowerRecordIdentity {
  hashHex: string
  role: SettlementRecord['role']
  amountUsdc: string
  usdcTokenAddress: string
  baseClaimAddress: string
  baseRefundAddress: string
  baseTimelockBlock: number
  baseChainId: number
  erc20SwapAddress: string
}

const normalizedHex = (value: string): string => value.toLowerCase()

export function watchtowerRecordIdentity(record: SettlementRecord): WatchtowerRecordIdentity {
  return {
    hashHex: normalizedHex(record.hashHex),
    role: record.role,
    amountUsdc: record.amountUsdc,
    usdcTokenAddress: normalizedHex(record.usdcTokenAddress),
    baseClaimAddress: normalizedHex(record.baseClaimAddress),
    baseRefundAddress: normalizedHex(record.baseRefundAddress),
    baseTimelockBlock: record.baseTimelockBlock,
    baseChainId: record.baseChainId,
    erc20SwapAddress: normalizedHex(record.erc20SwapAddress),
  }
}

/** Stable map key for one exact recovery subject. */
export function watchtowerRecordKey(record: SettlementRecord): string {
  const id = watchtowerRecordIdentity(record)
  return JSON.stringify([
    id.hashHex,
    id.role,
    id.amountUsdc,
    id.usdcTokenAddress,
    id.baseClaimAddress,
    id.baseRefundAddress,
    id.baseTimelockBlock,
    id.baseChainId,
    id.erc20SwapAddress,
  ])
}

export function sameWatchtowerRecordIdentity(a: SettlementRecord, b: SettlementRecord): boolean {
  return watchtowerRecordKey(a) === watchtowerRecordKey(b)
}

export function assertSameWatchtowerRecordIdentity(
  expected: SettlementRecord,
  actual: SettlementRecord,
  context: string,
): void {
  if (!sameWatchtowerRecordIdentity(expected, actual)) {
    throw new Error(`${context}: persisted record full swap tuple changed (hash/role/amount/token/claim/refund/timelock/chain/contract); refusing stale recovery`)
  }
}
