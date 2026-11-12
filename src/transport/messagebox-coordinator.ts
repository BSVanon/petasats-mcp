import type { BsvHtlcUtxo } from '../settlement/htlc'
import type { FundBsvBridgeCoordinator, BridgeIntent, BridgeIntentV2, BridgeQuote, BridgeQuoteV2 } from '../bridge/settlement-types'
import type { BridgeInitiatorCoordinator } from '../bridge/initiator-executor'
import {
  DEFAULT_MESSAGEBOX_POLL_MS,
  DEFAULT_MESSAGEBOX_TIMEOUT_MS,
  makeMessageBoxChannel,
  type MessageBoxChannelOpts,
} from './messagebox-channel'
import { isBaseLocked, isBridgeIntent, isBridgeIntentV2, isBridgeQuote, isBridgeQuoteV2, isBsvLocked, isRefundSigA, isRefundSkeleton, isRevealHint } from './settlement-message-validator'
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

/** Restock-only side-band. It is deliberately NOT part of SWAP_MESSAGE_KINDS: customer swaps remain byte-for-byte
 * on the established seven-message handshake and never send or poll this box. */
export const RESTOCK_MESSAGE_KINDS = { decline: 'restock-decline' } as const

export const RESTOCK_DECLINE_REASONS = ['insufficient-fundable', 'size-cap', 'price', 'halted', 'other'] as const
export type RestockDeclineReason = typeof RESTOCK_DECLINE_REASONS[number]

export interface RestockDecline {
  /** The fresh restock namespace / client oid. Repeated in the body so a misrouted authenticated message is ignored. */
  oid: string
  reason: RestockDeclineReason
  
  fundableBsvSats?: number
}

const RESTOCK_DECLINE_REASON_SET = new Set<string>(RESTOCK_DECLINE_REASONS)

export function isRestockDecline(value: unknown): value is RestockDecline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const decline = value as Record<string, unknown>
  if (typeof decline.oid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(decline.oid)) return false
  if (typeof decline.reason !== 'string' || !RESTOCK_DECLINE_REASON_SET.has(decline.reason)) return false
  if (decline.fundableBsvSats !== undefined && (!Number.isSafeInteger(decline.fundableBsvSats) || (decline.fundableBsvSats as number) < 0)) return false
  if (decline.fundableBsvSats !== undefined && decline.reason !== 'insufficient-fundable' && decline.reason !== 'size-cap') return false
  return Object.keys(decline).every((key) => key === 'oid' || key === 'reason' || key === 'fundableBsvSats')
}
type RefundSkeletonMsg = { htlc: BsvHtlcUtxo; refundLocktime: number; toAddress: string; feeRate: number }

export interface MessageBoxInitiatorCoordinatorOpts extends MessageBoxChannelOpts {
  /** Private peer-compatibility adaptation, applied before the public quote schema. */
  normalizeQuote?: (quote: unknown) => unknown
  settlementProtocolVersion?: 1 | 2
  /** Optional shorter receive period used by a caller that re-checks an on-chain deadline between BSV-lock polls. */
  bsvLockTimeoutMs?: number
}

export interface MessageBoxResponderCoordinatorOpts extends MessageBoxChannelOpts { settlementProtocolVersion?: 1 | 2 }

export function makeMessageBoxResponderCoordinator(opts: MessageBoxResponderCoordinatorOpts): FundBsvBridgeCoordinator {
  const ch = makeMessageBoxChannel(opts)
  return {
    recvIntent: () => opts.settlementProtocolVersion === 2 ? ch.recv<BridgeIntentV2>(SWAP_MESSAGE_KINDS.intent, isBridgeIntentV2) : ch.recv<BridgeIntent>(SWAP_MESSAGE_KINDS.intent, isBridgeIntent),
    sendQuote: (q: BridgeQuote) => ch.send(SWAP_MESSAGE_KINDS.quote, q),
    recvBaseLocked: () => ch.recv<{ txHash: `0x${string}`; blockNumber: number; bsvLockWaitMs?: number }>(SWAP_MESSAGE_KINDS.baseLocked, isBaseLocked),
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
      const validate = opts.settlementProtocolVersion === 2 ? isBridgeQuoteV2 : isBridgeQuote
      const quote = await ch.recv<unknown>(SWAP_MESSAGE_KINDS.quote, (value): value is unknown => validate(normalizeQuote(value)))
      return normalizeQuote(quote) as BridgeQuote | BridgeQuoteV2
    },
    sendBaseLocked: (m: { txHash: `0x${string}`; blockNumber: number; bsvLockWaitMs?: number }) => ch.send(SWAP_MESSAGE_KINDS.baseLocked, m),
    recvRefundSkeleton: () => ch.recv<RefundSkeletonMsg>(SWAP_MESSAGE_KINDS.refundSkeleton, isRefundSkeleton),
    sendRefundSigA: (m: { sigA: number[] }) => ch.send(SWAP_MESSAGE_KINDS.refundSigA, m),
    recvBsvLocked: (signal?: AbortSignal) => {
      // The exact-script chain observer can win this race. Give only this receive a local cancellation signal so its
      // long restock/buyer timer cannot outlive the decided swap; the coordinator's lifecycle signal still applies.
      const receiveSignal = signal && opts.signal ? AbortSignal.any([signal, opts.signal]) : signal ?? opts.signal
      const bsvLockChannel = signal === undefined && opts.bsvLockTimeoutMs === undefined
        ? ch
        : makeMessageBoxChannel({ ...opts, timeoutMs: opts.bsvLockTimeoutMs ?? opts.timeoutMs, signal: receiveSignal })
      return bsvLockChannel.recv<{ bsvLockTxid: string; htlcScriptHex: string }>(SWAP_MESSAGE_KINDS.bsvLocked, isBsvLocked)
    },
    sendRevealHint: (m: { bsvClaimTxid: string }) => ch.send(SWAP_MESSAGE_KINDS.reveal, m),
  }
}

export interface RestockMessageBoxInitiatorCoordinator {
  coordinator: BridgeInitiatorCoordinator
  /** Set only when a valid, authenticated decline for this exact namespace won the pre-quote race. */
  receivedDecline(): RestockDecline | undefined
}

/**
 * Restock initiator coordinator: preserve the normal handshake after quote, but before quote poll the restock-only
 * decline box as well. The quote is checked first on each poll; once received, no decline is read again, so a late
 * decline cannot overwrite a quote. Foreign senders are discarded by MessageBoxChannel's authenticated peer pin.
 */
export function makeRestockMessageBoxInitiatorCoordinator(opts: MessageBoxInitiatorCoordinatorOpts): RestockMessageBoxInitiatorCoordinator {
  if (!opts.peerIdentityPubKeyHex) {
    throw new Error('makeRestockMessageBoxInitiatorCoordinator: peerIdentityPubKeyHex (the responder identity) is required')
  }
  const base = makeMessageBoxInitiatorCoordinator(opts)
  const quoteChannel = makeMessageBoxChannel(opts)
  const declineChannel = makeMessageBoxChannel(opts)
  const pollMs = opts.pollMs ?? DEFAULT_MESSAGEBOX_POLL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MESSAGEBOX_TIMEOUT_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = opts.log ?? (() => {})
  const normalizeQuote = opts.normalizeQuote ?? ((quote: unknown) => quote)
  let decline: RestockDecline | undefined

  const recvQuote = async (): Promise<BridgeQuote | BridgeQuoteV2> => {
    const start = now()
    let polls = 0
    const maxPolls = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollMs))) + 2
    for (;;) {
      if (opts.signal?.aborted) throw new Error('messagebox-channel: receive cancelled')
      const validateQuote = opts.settlementProtocolVersion === 2 ? isBridgeQuoteV2 : isBridgeQuote
      const quote = await quoteChannel.tryRecv<unknown>(SWAP_MESSAGE_KINDS.quote, (value): value is unknown => validateQuote(normalizeQuote(value)))
      if (quote !== null) return normalizeQuote(quote) as BridgeQuote | BridgeQuoteV2

      // A malformed decline is control-plane noise, not a settlement message: acknowledge/drop it and keep waiting for
      // a valid quote or decline. In particular, never turn a stray side-band object into a swap failure.
      let raw: unknown | null = null
      try {
        raw = await declineChannel.tryRecv<unknown>(RESTOCK_MESSAGE_KINDS.decline)
      } catch (error) {
        log('restock', `ignored malformed restock decline: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (raw !== null) {
        if (!isRestockDecline(raw)) {
          log('restock', 'ignored malformed restock decline body')
        } else if (raw.oid !== opts.namespace) {
          log('restock', `ignored restock decline for namespace ${raw.oid}; waiting on ${opts.namespace}`)
        } else {
          decline = raw
          throw new Error(`restock declined by responder: ${raw.reason}`)
        }
      }

      if (now() - start > timeoutMs || ++polls > maxPolls) {
        throw new Error(`messagebox-channel: timed out waiting for 'quote' (${timeoutMs}ms / ${maxPolls} polls)`)
      }
      await sleep(pollMs)
    }
  }

  return { coordinator: { ...base, recvQuote }, receivedDecline: () => decline }
}

export interface RestockMessageBoxResponderCoordinator {
  coordinator: FundBsvBridgeCoordinator
  sendDecline(decline: RestockDecline): Promise<void>
}

/** Restock responder companion. Customer responders continue to use makeMessageBoxResponderCoordinator unchanged. */
export function makeRestockMessageBoxResponderCoordinator(opts: MessageBoxResponderCoordinatorOpts): RestockMessageBoxResponderCoordinator {
  const coordinator = makeMessageBoxResponderCoordinator(opts)
  const declineChannel = makeMessageBoxChannel(opts)
  return {
    coordinator,
    sendDecline: (decline) => declineChannel.send(RESTOCK_MESSAGE_KINDS.decline, decline),
  }
}
