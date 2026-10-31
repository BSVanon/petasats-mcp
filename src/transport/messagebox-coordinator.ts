import type { BsvHtlcUtxo } from '../settlement/htlc'
import type { FundBsvBridgeCoordinator, BridgeIntent, BridgeQuote } from '../bridge/settlement-types'
import type { BridgeInitiatorCoordinator } from '../bridge/initiator-executor'
import { makeMessageBoxChannel, type MessageBoxChannelOpts } from './messagebox-channel'
import { isBaseLocked, isBridgeIntent, isBridgeQuote, isBsvLocked, isRefundSigA, isRefundSkeleton, isRevealHint } from './settlement-message-validator'
/** The handshake message kinds (== the file-mailbox's named files). Both roles share these, so their boxes align. */
export const SWAP_MESSAGE_KINDS = {
  intent: 'intent',
  quote: 'quote',
  baseLocked: 'base-locked',
  refundSkeleton: 'refund-skeleton',
  refundSigA: 'refund-sig-a',
  bsvLocked: 'bsv-locked',
  reveal: 'reveal',
} as const

type RefundSkeletonMsg = { htlc: BsvHtlcUtxo; refundLocktime: number; toAddress: string; feeRate: number }

export interface MessageBoxInitiatorCoordinatorOpts extends MessageBoxChannelOpts {
  /** Private peer-compatibility adaptation, applied before the public quote schema. */
  normalizeQuote?: (quote: unknown) => unknown
}

export function makeMessageBoxResponderCoordinator(opts: MessageBoxChannelOpts): FundBsvBridgeCoordinator {
  const ch = makeMessageBoxChannel(opts)
  return {
    recvIntent: () => ch.recv<BridgeIntent>(SWAP_MESSAGE_KINDS.intent, isBridgeIntent),
    sendQuote: (q: BridgeQuote) => ch.send(SWAP_MESSAGE_KINDS.quote, q),
    recvBaseLocked: () => ch.recv<{ txHash: `0x${string}`; blockNumber: number }>(SWAP_MESSAGE_KINDS.baseLocked, isBaseLocked),
    sendRefundSkeleton: (m: RefundSkeletonMsg) => ch.send(SWAP_MESSAGE_KINDS.refundSkeleton, m),
    recvRefundSigA: () => ch.recv<{ sigA: number[] }>(SWAP_MESSAGE_KINDS.refundSigA, isRefundSigA),
    sendBsvLocked: (m: { bsvLockTxid: string; htlcScriptHex: string }) => ch.send(SWAP_MESSAGE_KINDS.bsvLocked, m),
    recvRevealHint: () => ch.tryRecv<{ bsvClaimTxid: string }>(SWAP_MESSAGE_KINDS.reveal, isRevealHint),
  }
}

export function makeMessageBoxInitiatorCoordinator(opts: MessageBoxInitiatorCoordinatorOpts): BridgeInitiatorCoordinator {
  if (!opts.peerIdentityPubKeyHex) {
    throw new Error('makeMessageBoxInitiatorCoordinator: peerIdentityPubKeyHex (the responder identity) is required — the initiator sends the intent first and must address it')
  }
  const ch = makeMessageBoxChannel(opts)
  const normalizeQuote = opts.normalizeQuote ?? ((quote: unknown) => quote)
  return {
    sendIntent: (i: BridgeIntent) => ch.send(SWAP_MESSAGE_KINDS.intent, i),
    recvQuote: async () => {
      const quote = await ch.recv<unknown>(SWAP_MESSAGE_KINDS.quote, (value): value is unknown => isBridgeQuote(normalizeQuote(value)))
      return normalizeQuote(quote) as BridgeQuote
    },
    sendBaseLocked: (m: { txHash: `0x${string}`; blockNumber: number }) => ch.send(SWAP_MESSAGE_KINDS.baseLocked, m),
    recvRefundSkeleton: () => ch.recv<RefundSkeletonMsg>(SWAP_MESSAGE_KINDS.refundSkeleton, isRefundSkeleton),
    sendRefundSigA: (m: { sigA: number[] }) => ch.send(SWAP_MESSAGE_KINDS.refundSigA, m),
    recvBsvLocked: () => ch.recv<{ bsvLockTxid: string; htlcScriptHex: string }>(SWAP_MESSAGE_KINDS.bsvLocked, isBsvLocked),
    sendRevealHint: (m: { bsvClaimTxid: string }) => ch.send(SWAP_MESSAGE_KINDS.reveal, m),
  }
}