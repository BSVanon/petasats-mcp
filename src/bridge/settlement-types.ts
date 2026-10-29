/**
 * Types shared by both sides of the public settlement protocol.
 *
 * Keeping this type-only seam outside the responder implementation lets the
 * buyer kit depend on the wire contract without bringing responder code into
 * its TypeScript program.
 */
import type { BsvHtlcUtxo } from '../settlement/htlc'
import type { BsvHtlcKind, SettlementRecord } from './settlement-session'

/** The taker's bridge negotiation payload, handed over AFTER it selects the MM's RFQ quote. */
export interface BridgeIntent {
  hashHex: string
  usdcAmount: string
  bsvAmount: number
  baseTimelockBlock: number
  bsvRefundLocktime: number
  machineEvmAddr: `0x${string}`
  machineBsvPubKeyHex: string
  erc20SwapAddress: `0x${string}`
  usdcTokenAddress: `0x${string}`
  baseChainId: number
}

/** The responder's bridge-level reply — the market maker's receiving addresses (NOT the signed RFQ quote). */
export interface BridgeQuote {
  responderEvmAddr: `0x${string}`
  responderBsvPubKeyHex: string
  responderBsvAddress: string
  // CVN-6 negotiation (red-team agents 2+3): the responder is the SOLE source of the HTLC kind + covenant fee budgets. It
  // publishes them here so the taker derives the IDENTICAL covenant script (no per-leg local-config divergence →
  // no stuck swaps) and commits the market maker's SIZED budget (no un-bumpable-fee strand). The taker still verifies the lock
  // on-chain against these, so a lying quote just fails-closed (refuse to reveal).
  htlcKind?: BsvHtlcKind
  bsvClaimFeeBudgetSats?: number
  bsvRefundFeeBudgetSats?: number
}

/**
 * The post-selection settlement handshake with the taker. In the file-mailbox runner these are the
 * intent/quote/base-locked/refund-skeleton/refund-sigA/bsv-locked messages; in production the RFQ
 * transport; in tests a fake. Locks + the reveal are OBSERVED ON-CHAIN — no message carries value.
 */
export interface FundBsvBridgeCoordinator {
  recvIntent(): Promise<BridgeIntent>
  sendQuote(q: BridgeQuote): Promise<void>
  recvBaseLocked(): Promise<{ txHash: `0x${string}`; blockNumber: number }>
  sendRefundSkeleton(m: { htlc: BsvHtlcUtxo; refundLocktime: number; toAddress: string; feeRate: number }): Promise<void>
  recvRefundSigA(): Promise<{ sigA: number[] }>
  sendBsvLocked(m: { bsvLockTxid: string; htlcScriptHex: string }): Promise<void>
  /**
   * OPTIONAL 0-conf fast HINT: a non-blocking pointer to the taker's BSV claim tx, so the MM can read
   * the revealed secret the instant the taker claims instead of waiting for the spend to CONFIRM. It is
   * ONLY a pointer — `watchReveal` still fetches the tx and re-derives `s` on-chain (SHA256(s)==H), so a
   * lying/absent hint costs nothing (falls through to the trustless outpoint watch). null if none yet.
   */
  recvRevealHint?(): Promise<{ bsvClaimTxid: string } | null>
}

export interface SwapRecordSink {
  write(record: SettlementRecord): void
  /** Optional expected snapshot makes recovery cleanup compare-and-clear; ordinary settled writers may omit it. */
  clear(swapId: string, expected?: SettlementRecord): void
}