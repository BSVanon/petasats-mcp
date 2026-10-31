/** Runtime schemas for the JSON settlement handshake.  Keep this separate from the
 * coordinator so TypeScript's wire types never become a trust boundary. */
import type { BridgeIntent, BridgeQuote } from '../bridge/settlement-types'
import type { BsvHtlcUtxo } from '../settlement/htlc'

const own = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => own(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))
const hex = (v: unknown, bytes: number, prefix = false): v is string => typeof v === 'string' && new RegExp(`^${prefix ? '0x' : ''}[0-9a-fA-F]{${bytes * 2}}$`).test(v)
const boundedHex = (v: unknown, maxBytes: number): v is string => typeof v === 'string' && /^[0-9a-fA-F]*$/.test(v) && v.length <= maxBytes * 2 && v.length % 2 === 0
const n = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const address = (v: unknown): v is `0x${string}` => hex(v, 20, true)
const pubkey = (v: unknown): v is string => typeof v === 'string' && /^(?:02|03)[0-9a-fA-F]{64}$/.test(v)
const txid = (v: unknown): v is string => hex(v, 32)
const amount = (v: unknown): v is string => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,77})$/.test(v)

export function isBridgeIntent(v: unknown): v is BridgeIntent {
  if (!exact(v, ['hashHex', 'usdcAmount', 'bsvAmount', 'baseTimelockBlock', 'bsvRefundLocktime', 'machineEvmAddr', 'machineBsvPubKeyHex', 'erc20SwapAddress', 'usdcTokenAddress', 'baseChainId'])) return false
  return hex(v.hashHex, 32) && amount(v.usdcAmount) && n(v.bsvAmount) && n(v.baseTimelockBlock) && n(v.bsvRefundLocktime) && address(v.machineEvmAddr) && pubkey(v.machineBsvPubKeyHex) && address(v.erc20SwapAddress) && address(v.usdcTokenAddress) && n(v.baseChainId)
}

export function isBridgeQuote(v: unknown): v is BridgeQuote {
  if (!own(v)) return false
  const keys = Object.keys(v)
  // A responder can add compatibility metadata to its wire reply.  This public
  // boundary validates the fields this side consumes, rather than naming or
  // exporting another implementation's compatibility fields.
  if (keys.length > 32 || !Object.hasOwn(v, 'responderEvmAddr') || !Object.hasOwn(v, 'responderBsvPubKeyHex') || !Object.hasOwn(v, 'responderBsvAddress')) return false
  if (!address(v.responderEvmAddr) || !pubkey(v.responderBsvPubKeyHex) || typeof v.responderBsvAddress !== 'string' || v.responderBsvAddress.length < 1 || v.responderBsvAddress.length > 128) return false
  if (v.htlcKind !== undefined && v.htlcKind !== 'covenant') return false
  if ((v.bsvClaimFeeBudgetSats !== undefined && !n(v.bsvClaimFeeBudgetSats)) || (v.bsvRefundFeeBudgetSats !== undefined && !n(v.bsvRefundFeeBudgetSats))) return false
  return true
}

export const isBaseLocked = (v: unknown): v is { txHash: `0x${string}`; blockNumber: number } => exact(v, ['txHash', 'blockNumber']) && hex(v.txHash, 32, true) && n(v.blockNumber)
export const isRefundSigA = (v: unknown): v is { sigA: number[] } => exact(v, ['sigA']) && Array.isArray(v.sigA) && v.sigA.length > 0 && v.sigA.length <= 80 && v.sigA.every((b) => n(b) && b <= 255)
export const isBsvLocked = (v: unknown): v is { bsvLockTxid: string; htlcScriptHex: string } => exact(v, ['bsvLockTxid', 'htlcScriptHex']) && txid(v.bsvLockTxid) && boundedHex(v.htlcScriptHex, 10_000)
export const isRevealHint = (v: unknown): v is { bsvClaimTxid: string } => exact(v, ['bsvClaimTxid']) && txid(v.bsvClaimTxid)
export function isRefundSkeleton(v: unknown): v is { htlc: BsvHtlcUtxo; refundLocktime: number; toAddress: string; feeRate: number } {
  if (!exact(v, ['htlc', 'refundLocktime', 'toAddress', 'feeRate']) || !own(v.htlc) || !exact(v.htlc, ['txid', 'vout', 'satoshis', 'scriptHex'])) return false
  return txid(v.htlc.txid) && n(v.htlc.vout) && n(v.htlc.satoshis) && boundedHex(v.htlc.scriptHex, 10_000) && n(v.refundLocktime) && typeof v.toAddress === 'string' && v.toAddress.length > 0 && v.toAddress.length <= 128 && n(v.feeRate)
}
