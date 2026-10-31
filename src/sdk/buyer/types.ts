import type { ConvertRequest, PetaSats, Quote, SwapResult } from '../convert'
import type { SettlementState } from '../../bridge/settlement-session'

/** Public lifecycle states.  They are deliberately words a UI can display. */
export type BuyerSwapStage =
  | 'quoted' | 'admitted' | 'usdc_locked' | 'waiting_bsv_lock' | 'bsv_lock_confirming'
  | 'claiming' | 'claimed' | 'settled' | 'sweeping' | 'delivered' | 'refund_waiting' | 'refunded' | 'failed' | 'needs_attention'

export interface BuyerQuote extends Quote {
  doorQuoteId: string
  usdcBaseUnits: bigint
  bsvSats: bigint
  midUsdPerBsv?: number
  claimFeeBudgetSats?: number
}

export interface BuyerSwapRecord {
  schemaVersion?: number
  swapId: string
  requestId: string
  /** Persisted state is untrusted input; runtime validates it before acting on it. */
  stage: BuyerSwapStage | string
  amountIn: string
  quote: BuyerQuote
  deliverTo?: string
  createdAtMs: number
  updatedAtMs: number
  swapNamespace?: string
  handshakeDeadlineMs?: number
  baseLockTxid?: string
  /** Persisted Base refund transaction when a terminal recovery refunded the lock. */
  baseRefundTxid?: string
  bsvClaimTxid?: string
  /** Exact sats paid to the buyer by output 0 of the persisted covenant claim. */
  bsvClaimPayoutSats?: number
  bsvLockTxid?: string
  bsvLockOutpoint?: string
  /** Settlement timelocks are block heights, not wall-clock guesses. */
  bsvRefundLocktime?: number
  baseTimelockBlock?: number
  nextDeadline?: string
  reason?: string
  /** The initiator recovery record.  Its presence, rather than a txid, proves value may be at risk. */
  settlementHashHex?: string
  /** True only after the settlement write-ahead record was observed durable. */
  settlementRecordCreated?: boolean
  /** Last durable state observed for `settlementHashHex`; useful after the terminal record is cleared. */
  settlementState?: SettlementState
  /** Durable sweep outbox. The exact signed transaction is rebroadcast after a crash. */
  sweepOutbox?: { rawTx: string; atomicBeefHex?: string; txid: string; sats: string }
}

export interface DoorQuoteSuccess {
  quoteId: string
  bsvSats: number
  usdcBaseUnits: string
  expiresAtMs: number
  midUsdPerBsv?: number
}

export interface DoorClient {
  quote(usdcBaseUnits: bigint, requestId: string): Promise<DoorQuoteSuccess>
  admit(quoteId: string, usdcBaseUnits: bigint, requestId: string): Promise<{ swapNamespace: string; handshakeDeadlineMs: number }>
}

/** The executor is intentionally injected: unit tests never need an RPC or a real key. */
export interface BuyerExecutor {
  execute(input: { swapId: string; quote: BuyerQuote; swapNamespace: string; handshakeDeadlineMs: number; onSettlementLink?: (hashHex: string) => Promise<void>; onSettlement?: (record: { hashHex: string; state: SettlementState }) => void }): Promise<{
    ok: boolean
    baseLockTxid?: string
    bsvClaimTxid?: string
    bsvClaimPayoutSats?: number
    reason?: string
    /** True once a preimage might have been revealed.  A failure here is never refundable. */
    revealed?: boolean
    /** The executor proved its pre-lock USDC checkpoint was cleared after the exact lock tuple was absent. */
    nothingLocked?: boolean
  }>
  recover?(record: BuyerSwapRecord): Promise<BuyerRecoveryOutcome | undefined>
  /** Arm every durable settlement record; engines may return the current derived stage for linked kit swaps. */
  recoverAll?(records: BuyerSwapRecord[]): Promise<Map<string, BuyerRecoveryOutcome>>
  /** Clear an engine terminal tombstone only after this exact durable buyer row is written. */
  acknowledgeTerminal?(record: BuyerSwapRecord): Promise<void> | void
}

/** A recovery result is persisted by the kit, including a terminal settlement state after its source record is cleared. */
export interface BuyerRecoveryOutcome {
  stage: BuyerSwapStage
  baseLockTxid?: string
  baseRefundTxid?: string
  bsvClaimTxid?: string
  /** Exact sats paid to the buyer by output 0 of the persisted covenant claim. */
  bsvClaimPayoutSats?: number
  reason?: string
  settlementState?: SettlementState
  bsvLockOutpoint?: string
  bsvRefundLocktime?: number
  baseTimelockBlock?: number
}

export interface BuyerStore {
  list(): Promise<BuyerSwapRecord[]>
  get(swapId: string): Promise<BuyerSwapRecord | undefined>
  /** Must be durable before a money-moving executor step starts. */
  put(record: BuyerSwapRecord): Promise<void>
}

export interface BuyerWallet {
  baseAddress: string
  bsvAddress: string
  balances(): Promise<{ usdc: bigint; eth: bigint; claimedBsvSats: bigint }>
  /** Optional sweep hook; implementation must reject dust before broadcast. */
  withdrawBsv?(address: string, opts?: { onlyTxid?: string; beforeBroadcast?: () => void | Promise<void> }): Promise<{ txid?: string; sats: bigint; reason?: string }>
  buildSweep?(address: string, opts: { onlyTxid: string }): Promise<{ rawTx: string; atomicBeefHex?: string; txid: string; sats: bigint }>
  broadcastSweep?(outbox: { rawTx: string; atomicBeefHex?: string; txid: string; sats: string }): Promise<void>
  /** Must validate the same confirmation threshold as the claim path. */
  isSweepConfirmed?(txid: string, address: string): Promise<boolean>
}

export interface BuyerBaseWallet {
  transferUsdc?(to: `0x${string}`, amount: bigint, onRecorded?: BuyerWithdrawalRecorder): Promise<{ hash: string; status: string; blockNumber?: bigint }>
  transferEth?(to: `0x${string}`, amount: bigint, onRecorded?: BuyerWithdrawalRecorder, opts?: { pinnedFees?: BuyerEthTransferFees }): Promise<{ hash: string; status: string; blockNumber?: bigint }>
  priceEthTransfer?(to: `0x${string}`): Promise<BuyerEthTransferPlan>
}

/** Exact EIP-1559 fields used by an ETH-all withdrawal; they must also be used to sign it. */
export interface BuyerEthTransferFees {
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export interface BuyerEthTransferPlan extends BuyerEthTransferFees {
  l1FeeWei: bigint
  reserveWei: bigint
}

export type BuyerWithdrawalRecorder = (signed: { hash: `0x${string}`; signedTx: `0x${string}`; nonce: number }) => void | Promise<void>
export interface BuyerWithdrawalReconcileOutcome {
  hash: string
  asset: 'USDC' | 'ETH'
  to: string
  amount: string
  status: 'success' | 'reverted' | 'cancelled'
}
export type BuyerWithdrawalCancelResult =
  | { status: 'cancelling'; cancelHash: string }
  | { status: 'unaffordable' | 'unconfirmed'; cancelHash?: string }
  | { status: 'waiting'; cancelHash?: string }
  | { status: 'limit' | 'unsupported' }
export interface BuyerWithdrawalIntents {
  /** A receipt can settle an older withdrawal, but only the caller decides whether that ends its operation. */
  reconcile(): Promise<BuyerWithdrawalReconcileOutcome | undefined>
  record(input: { asset: 'USDC' | 'ETH'; to: string; amount: bigint; hash: string; signedTx: string; nonce: number }): Promise<void>
  done(hash: string, result: { status: 'success' | 'reverted'; blockNumber?: bigint }): Promise<void>
  /** Start a durable same-nonce cancellation for a recorded withdrawal. */
  cancel?(hash: string): Promise<BuyerWithdrawalCancelResult>
  /** Local, read-only records used to reject a likely duplicate retry. */
  list?(): Array<{ asset: 'USDC' | 'ETH'; to: string; amount: string; hash: string; createdAtMs: number; state: 'pending' | 'done'; status?: 'success' | 'reverted' | 'sent' | 'not-sent' | 'cancelled' }>
}

export interface BuyerKitConfig {
  capUsdPerSwap?: number
  /** Default one; an application can intentionally widen this only with its own scheduler. */
  maxActiveSwaps?: number
  now?: () => number
  baseWithdrawalForbidden?: readonly string[]
  newWallet?: boolean
  keysPath?: string
}

export interface StartSwapRequest {
  amountIn: bigint
  deliverTo?: string
  minBsvOut?: bigint
  /** Either this quote's id or minBsvOut is required.  Other quote fields are
   * compared to the locally retained quote before a door request is sent. */
  quote?: BuyerQuote
}

export interface BuyerKit extends PetaSats {
  startSwap(request: StartSwapRequest): Promise<{ swapId: string; stage: BuyerSwapStage; expectedMinutes: number }>
  status(swapId?: string): Promise<BuyerSwapRecord[]>
  recover(): Promise<BuyerSwapRecord[]>
  withdrawBsv(address: string): Promise<{ txid?: string; sats: bigint; reason?: string }>
  withdrawBase(request: { asset: 'USDC' | 'ETH'; to: string; amount: string }): Promise<{ asset: 'USDC' | 'ETH'; amount: bigint; to: string; txid: string; status: string }>
  walletInfo(): Promise<{ baseAddress: string; bsvAddress: string; usdc: bigint; eth: bigint; claimedBsvSats: bigint; capUsdPerSwap: number; spending_stopped?: boolean; stopped_at?: number; stop_reason?: string; limits?: unknown; new_wallet?: boolean; backup_note?: string }>
  assertCanPlanSwap?(deliverTo: string, amountIn?: bigint): Promise<void>
  stopSpending?(reason?: string): Promise<{ alreadyStopped: boolean; at?: number; reason?: string }>
}

export type { ConvertRequest, PetaSats, Quote, SwapResult }
