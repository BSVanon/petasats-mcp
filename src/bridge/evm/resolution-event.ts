import { decodeEventLog, sha256, type Hex } from 'viem'
import { decodeLockupLog, encodeClaim, encodeRefund, ERC20_SWAP_ABI, type Erc20SwapParams } from './erc20swap'

export type SwapResolutionReason =
  | 'not-found'
  | 'invalid-anchor'
  | 'malformed-log'
  | 'contradictory'
  | 'read-error'
  | 'invalid-event-tx'
  | 'event-reverted'
  | 'event-tx-mismatch'
  | 'event-above-finalized'
  | 'invalid-event-log'
  | 'event-not-after-lock'
  | 'invalid-preimage'
  | 'calldata-mismatch'
  | 'still-locked'

/** Canonical finalized resolution shape shared by range scans and one-transaction hint verification. */
export type SwapResolutionOutcome =
  | { kind: 'claimed'; preimage: Hex; eventTxid: Hex; eventBlock?: number }
  | { kind: 'refunded'; eventTxid: Hex; eventBlock?: number }
  | { kind: 'unresolved'; reason: SwapResolutionReason; detail?: string }

/** The record's own Lockup coordinates. Resolution evidence must be strictly later in chain order. */
export interface SwapResolutionAnchor {
  blockNumber: bigint
  transactionHash: Hex
  /** Responders retain the observed index; initiator locks may use -1 and re-derive it from the receipt. */
  logIndex?: number
}

export interface ResolutionReceiptLog {
  address: string
  topics: readonly Hex[]
  data: Hex
  transactionHash?: Hex | null
  blockNumber?: bigint | null
  transactionIndex?: number | null
  logIndex?: number | null
}

export interface ResolutionReceipt {
  status: string
  transactionHash: Hex
  blockNumber: bigint
  transactionIndex: number
  logs: readonly ResolutionReceiptLog[]
}

export interface ProvenLockAnchor {
  blockNumber: bigint
  transactionHash: Hex
  transactionIndex: number
  logIndex: number
}

export function invalidSwapResolutionAnchor(anchor: SwapResolutionAnchor): boolean {
  return anchor.blockNumber <= 0n || !/^0x[0-9a-fA-F]{64}$/.test(anchor.transactionHash)
}

/**
 * Prove the record's exact Lockup from its receipt. This is a pure extraction of the original
 * `resolveSwapOutcome` checks: receipt position first, then exact tuple/log uniqueness, then the recorded-index rule.
 */
export function proveSwapLockAnchor(
  receipt: ResolutionReceipt,
  params: Erc20SwapParams,
  anchor: SwapResolutionAnchor,
  swapAddress: string,
): ProvenLockAnchor | Extract<SwapResolutionOutcome, { kind: 'unresolved' }> {
  const lockBlock = receipt.blockNumber
  const lockTransactionIndex = receipt.transactionIndex
  if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== anchor.transactionHash.toLowerCase() ||
      lockBlock !== anchor.blockNumber ||
      !Number.isSafeInteger(lockTransactionIndex) || lockTransactionIndex < 0) {
    return { kind: 'unresolved', reason: 'invalid-anchor', detail: 'recorded Lockup receipt position could not be proven' }
  }
  const matchingLocks = receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== swapAddress.toLowerCase()) return []
    const lockup = decodeLockupLog({ topics: [...log.topics], data: log.data })
    if (!lockup || log.transactionHash?.toLowerCase() !== anchor.transactionHash.toLowerCase() ||
        log.blockNumber !== lockBlock || log.transactionIndex !== lockTransactionIndex ||
        lockup.preimageHash.toLowerCase() !== params.preimageHash.toLowerCase() ||
        lockup.amount !== params.amount || lockup.tokenAddress.toLowerCase() !== params.tokenAddress.toLowerCase() ||
        lockup.claimAddress.toLowerCase() !== params.claimAddress.toLowerCase() ||
        lockup.refundAddress.toLowerCase() !== params.refundAddress.toLowerCase() || lockup.timelock !== params.timelock ||
        !Number.isSafeInteger(log.logIndex) || (log.logIndex as number) < 0) return []
    return [log.logIndex as number]
  })
  if (matchingLocks.length !== 1 ||
      (anchor.logIndex !== undefined && anchor.logIndex >= 0 && matchingLocks[0] !== anchor.logIndex)) {
    return { kind: 'unresolved', reason: 'invalid-anchor', detail: 'recorded receipt does not contain one exact Lockup at the recorded index' }
  }
  return {
    blockNumber: lockBlock,
    transactionHash: anchor.transactionHash,
    transactionIndex: lockTransactionIndex,
    logIndex: matchingLocks[0],
  }
}

/** Preserve the range resolver's exact same-block ordering semantics. */
export function strictlyAfterLock(
  log: Pick<ResolutionReceiptLog, 'blockNumber' | 'transactionIndex' | 'transactionHash' | 'logIndex'>,
  lock: ProvenLockAnchor,
): boolean | undefined {
  if (typeof log.blockNumber !== 'bigint') return undefined
  if (log.blockNumber > lock.blockNumber) return true
  if (log.blockNumber < lock.blockNumber) return false
  if (!Number.isSafeInteger(log.transactionIndex) || (log.transactionIndex as number) < 0) return undefined
  if ((log.transactionIndex as number) > lock.transactionIndex) return true
  if ((log.transactionIndex as number) < lock.transactionIndex) return false
  if (!log.transactionHash || log.transactionHash.toLowerCase() !== lock.transactionHash.toLowerCase() ||
      !Number.isSafeInteger(log.logIndex) || (log.logIndex as number) < 0) return undefined
  return (log.logIndex as number) > lock.logIndex
}

export interface HintResolutionReads {
  assertContractIdentity(): Promise<void>
  getTransactionReceipt(hash: Hex): Promise<ResolutionReceipt>
  finalizedBlockNumber(): Promise<bigint>
  transactionCalls(hash: Hex, to: Hex, data: Hex): Promise<boolean>
  isSwapLocked(params: Erc20SwapParams, opts: { blockNumber: bigint }): Promise<boolean>
}

type DecodedResolution =
  | { kind: 'claimed'; log: ResolutionReceiptLog; preimage: Hex }
  | { kind: 'refunded'; log: ResolutionReceiptLog }

function decodedResolution(log: ResolutionReceiptLog, params: Erc20SwapParams, swapAddress: Hex): DecodedResolution | undefined {
  if (log.address.toLowerCase() !== swapAddress.toLowerCase()) return undefined
  try {
    const decoded = decodeEventLog({
      abi: ERC20_SWAP_ABI,
      topics: [...log.topics] as [Hex, ...Hex[]],
      data: log.data,
    })
    if (decoded.eventName === 'Claim') {
      const args = decoded.args as { preimageHash: Hex; preimage: Hex }
      if (args.preimageHash.toLowerCase() !== params.preimageHash.toLowerCase()) return undefined
      return { kind: 'claimed', log, preimage: args.preimage }
    }
    if (decoded.eventName === 'Refund') {
      const args = decoded.args as { preimageHash: Hex }
      if (args.preimageHash.toLowerCase() !== params.preimageHash.toLowerCase()) return undefined
      return { kind: 'refunded', log }
    }
  } catch { /* a non-resolution receipt log is irrelevant */ }
  return undefined
}

/** Verify one operator-supplied resolution transaction without any historical log-range search. */
export async function resolveSwapOutcomeFromEventTx(
  params: Erc20SwapParams,
  anchor: SwapResolutionAnchor,
  eventTxid: Hex,
  swapAddress: Hex,
  reads: HintResolutionReads,
): Promise<SwapResolutionOutcome> {
  try {
    // Identity precedes every other hint-path chain read and every input-dependent classification.
    await reads.assertContractIdentity()
    if (invalidSwapResolutionAnchor(anchor)) {
      return { kind: 'unresolved', reason: 'invalid-anchor', detail: 'recorded lock block and transaction hash must be valid' }
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(eventTxid)) {
      return { kind: 'unresolved', reason: 'invalid-event-tx' }
    }

    const lockReceipt = await reads.getTransactionReceipt(anchor.transactionHash)
    const lock = proveSwapLockAnchor(lockReceipt, params, anchor, swapAddress)
    if ('kind' in lock) return lock

    const receipt = await reads.getTransactionReceipt(eventTxid)
    if (receipt.status !== 'success') return { kind: 'unresolved', reason: 'event-reverted' }
    if (receipt.transactionHash.toLowerCase() !== eventTxid.toLowerCase()) {
      return { kind: 'unresolved', reason: 'event-tx-mismatch' }
    }
    const finalized = await reads.finalizedBlockNumber()
    if (receipt.blockNumber > finalized) return { kind: 'unresolved', reason: 'event-above-finalized' }

    const resolutions = receipt.logs.flatMap((log) => {
      const decoded = decodedResolution(log, params, swapAddress)
      return decoded ? [decoded] : []
    })
    const claims = resolutions.filter((item): item is Extract<DecodedResolution, { kind: 'claimed' }> => item.kind === 'claimed')
    const refunds = resolutions.filter((item): item is Extract<DecodedResolution, { kind: 'refunded' }> => item.kind === 'refunded')
    if (claims.length > 0 && refunds.length > 0) return { kind: 'unresolved', reason: 'contradictory' }
    if (claims.length + refunds.length !== 1) return { kind: 'unresolved', reason: 'invalid-event-log' }

    const resolution = resolutions[0]
    const log = resolution.log
    if (log.transactionHash?.toLowerCase() !== eventTxid.toLowerCase() ||
        log.blockNumber !== receipt.blockNumber || log.transactionIndex !== receipt.transactionIndex ||
        !Number.isSafeInteger(log.logIndex) || (log.logIndex as number) < 0) {
      return { kind: 'unresolved', reason: 'invalid-event-log' }
    }
    if (strictlyAfterLock(log, lock) !== true) return { kind: 'unresolved', reason: 'event-not-after-lock' }

    let exactCall: boolean
    if (resolution.kind === 'claimed') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(resolution.preimage) ||
          sha256(resolution.preimage).toLowerCase() !== params.preimageHash.toLowerCase()) {
        return { kind: 'unresolved', reason: 'invalid-preimage' }
      }
      exactCall = await reads.transactionCalls(
        eventTxid,
        swapAddress,
        encodeClaim(params, Array.from(Buffer.from(resolution.preimage.slice(2), 'hex'))),
      )
    } else {
      exactCall = await reads.transactionCalls(eventTxid, swapAddress, encodeRefund(params))
    }
    if (!exactCall) return { kind: 'unresolved', reason: 'calldata-mismatch' }
    if (await reads.isSwapLocked(params, { blockNumber: finalized })) {
      return { kind: 'unresolved', reason: 'still-locked' }
    }

    const eventBlock = Number(receipt.blockNumber)
    if (!Number.isSafeInteger(eventBlock) || eventBlock < 1) return { kind: 'unresolved', reason: 'invalid-event-log' }
    return resolution.kind === 'claimed'
      ? { kind: 'claimed', preimage: resolution.preimage, eventTxid, eventBlock }
      : { kind: 'refunded', eventTxid, eventBlock }
  } catch (error) {
    return { kind: 'unresolved', reason: 'read-error', detail: error instanceof Error ? error.message : String(error) }
  }
}
