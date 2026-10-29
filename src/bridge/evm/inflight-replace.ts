/**
 * Same-nonce replacement for the counter-leased EVM send engine (inflight-sends.ts): authenticate the recorded bytes,
 * price the next generation from the entry's fee floor, record it write-ahead, then submit it.
 */

import {
  concatHex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from 'viem'
import type { EvmInflightSend } from './inflight-state'
import {
  EvmSubmitHashMismatchError,
  localTransactionHash,
  submitSignedTransaction,
  type SignedTransaction,
} from './inflight-submit'
import type { CounterSendDeps } from './inflight-sends'

/** The fee ceiling is deliberately retriable: a transient Base fee spike delays recovery without unbounded spend. */
export class EvmFeeCeilingError extends Error {
  readonly retriable = true
  constructor(readonly maxFeePerGas: bigint, readonly maxFeePerGasCeiling: bigint) {
    super(`EVM send deferred: computed maxFeePerGas ${maxFeePerGas} wei exceeds EVM_MAX_FEE_GWEI ceiling ${maxFeePerGasCeiling} wei; retry after the Base fee spike passes`)
    this.name = 'EvmFeeCeilingError'
  }
}

export function evmOperationKey(to: Address, data: Hex, operationSalt?: Hex): Hex {
  return keccak256(concatHex(operationSalt === undefined ? [to, data] : [to, data, operationSalt]))
}

const bump = (fee: bigint): bigint => (fee * 9n + 7n) / 8n
const max = (a: bigint, b: bigint): bigint => a > b ? a : b
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

async function authenticate(entry: EvmInflightSend, deps: CounterSendDeps): Promise<ReturnType<typeof parseTransaction>> {
  try {
    const transaction = parseTransaction(entry.signedTx as any)
    const recovered = await recoverTransactionAddress({ serializedTransaction: entry.signedTx as any })
    if (transaction.type !== 'eip1559' || !same(recovered, deps.sender) || transaction.chainId !== deps.chainId ||
        transaction.nonce !== entry.nonce || !transaction.to ||
        !deps.pinnedContracts.some((address) => same(address, transaction.to!)) ||
        !same(evmOperationKey(transaction.to, transaction.data ?? '0x', entry.operationSalt), entry.opKey) ||
        transaction.gas === undefined || transaction.maxFeePerGas === undefined ||
        transaction.maxPriorityFeePerGas === undefined) {
      throw new Error('stored transaction does not match the signer, chain, nonce, EIP-1559 shape, or pinned contract')
    }
    return transaction
  } catch (error) {
    const detail = describe(error)
    deps.log(`[evm-inflight] HEALTH CRITICAL — refusing to re-sign nonce ${entry.nonce}: ${detail}`)
    throw new Error(`EVM stored transaction authenticity check failed for nonce ${entry.nonce} (fail-closed): ${detail}`)
  }
}

export function hashMismatch(deps: CounterSendDeps, nonce: number, localHash: Hex, returned: string): EvmSubmitHashMismatchError {
  deps.log(`[evm-inflight] HEALTH CRITICAL — submit of nonce ${nonce} returned hash ${returned}, not the recorded local hash ${localHash}; entry kept`)
  return new EvmSubmitHashMismatchError(nonce, localHash, returned)
}

/**
 * A replacement whose submit outcome is unknown is still durably recorded, so its hash stays in the family (F-E).
 * `held`: the bump would exceed the fee ceiling, so nothing new was signed and the floor bytes were resubmitted as-is.
 */
export type ReplacementResult =
  | { kind: 'sent'; hash: Hex } | { kind: 'unknown'; hash: Hex } | { kind: 'held'; hash: Hex; error: EvmFeeCeilingError }
  | { kind: 'consumed' } | { kind: 'skipped' }

/**
 * Same-nonce replacement (I4), write-ahead: authenticate -> re-sign with bumped fees -> durable record -> submit.
 *
 * The bump is priced from the entry's fee floor: the last generation a node acknowledged or rejected as underpriced,
 * else the original. A replacement whose submit outcome is unknown never raises the floor, and while the newest
 * generation's outcome is unknown it is resubmitted as-is until the market moves a full bump above it. A run of
 * refused submits (no gas, a write-refusing RPC) therefore neither ratchets the fee nor grows the hash family, and
 * each new generation out-bids every recorded one by a full bump on both fees, so a node holding any of them takes it.
 * At the ceiling this never throws: the floor bytes are resubmitted as-is and held until the Base fee falls to the cap
 * of the version a node holds, so keep the ceiling far above Base fees.
 */
export async function replace(entry: EvmInflightSend, deps: CounterSendDeps): Promise<ReplacementResult> {
  const floorTx = entry.floorSignedTx ?? entry.signedTx
  const transaction = await authenticate({ ...entry, signedTx: floorTx }, deps)
  const fresh = await deps.publicClient.estimateFeesPerGas()
  if (fresh.maxFeePerGas === undefined || fresh.maxPriorityFeePerGas === undefined ||
      fresh.maxFeePerGas < 0n || fresh.maxPriorityFeePerGas < 0n) {
    throw new Error('EVM replacement refused: estimateFeesPerGas did not return non-negative EIP-1559 fees')
  }
  const maxFeePerGas = max(fresh.maxFeePerGas, bump(transaction.maxFeePerGas!))
  let maxPriorityFeePerGas = max(fresh.maxPriorityFeePerGas, bump(transaction.maxPriorityFeePerGas!))
  const floor: SignedTransaction = { hash: localTransactionHash(floorTx), signedTx: floorTx }
  const consumed = (): ReplacementResult => {
    deps.nonceCounter.recordConsumed({ chainId: deps.chainId, address: deps.sender, nonce: entry.nonce })
    return { kind: 'consumed' }
  }
  if (maxFeePerGas > deps.maxFeePerGasCeiling) {
    const error = new EvmFeeCeilingError(maxFeePerGas, deps.maxFeePerGasCeiling)
    deps.onFeeCeiling(error)
    const resubmitted = await submitSignedTransaction(deps.writer, floor)
    if (resubmitted.kind === 'hash-mismatch') throw hashMismatch(deps, entry.nonce, floor.hash, resubmitted.returned)
    if (resubmitted.kind === 'nonce-too-low') return consumed()
    return { kind: 'held', hash: floor.hash, error }
  }
  const record = (tx: SignedTransaction, floorSignedTx?: Hex): void => deps.nonceCounter.recordBroadcast({
    chainId: deps.chainId, address: deps.sender, nonce: entry.nonce, hash: tx.hash, signedTx: tx.signedTx,
    opKey: entry.opKey, retainConsumedAttribution: entry.retainConsumedAttribution,
    ...(entry.operationSalt !== undefined ? { operationSalt: entry.operationSalt } : {}),
    ...(floorSignedTx ? { floorSignedTx } : {}),
  })
  let signed: SignedTransaction | undefined
  if (entry.floorSignedTx !== undefined) {
    // The newest generation's outcome is unknown, so a node may hold it. Until the market moves a full bump above it,
    // resubmit those recorded bytes as-is rather than sign yet another generation. Once it has, the new generation
    // must out-tip it by a full bump as well, or a node holding it answers underpriced.
    const newest = await authenticate(entry, deps)
    if (fresh.maxFeePerGas < bump(newest.maxFeePerGas!)) {
      signed = { hash: localTransactionHash(entry.signedTx), signedTx: entry.signedTx }
    } else {
      maxPriorityFeePerGas = max(maxPriorityFeePerGas, bump(newest.maxPriorityFeePerGas!))
    }
  }
  if (!signed) {
    const { r: _r, s: _s, v: _v, yParity: _yParity, ...unsigned } = transaction as any
    const signedTx = await deps.writer.signTransaction({
      ...unsigned,
      account: deps.localAccount,
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    signed = { hash: localTransactionHash(signedTx), signedTx }
    // Write-ahead. Until a node answers for these bytes, the floor stays where it was.
    record(signed, same(signed.hash, floor.hash) ? undefined : floorTx)
  }
  deps.clearFeeCeiling()
  const submitted = await submitSignedTransaction(deps.writer, signed)
  if (submitted.kind === 'hash-mismatch') throw hashMismatch(deps, entry.nonce, signed.hash, submitted.returned)
  if (submitted.kind === 'nonce-too-low') return consumed()
  if (submitted.kind === 'unknown') {
    deps.log(`[evm-inflight] replacement of nonce ${entry.nonce} has an unknown submit outcome (${submitted.detail}); recorded, fee floor kept, returned pending`)
    return { kind: 'unknown', hash: signed.hash }
  }
  // Acknowledged, or underpriced against a same-nonce version a node holds: the next bump must price above these
  // bytes. A failed floor write only leaves the lower floor, and the next round resubmits these bytes as-is.
  if (!same(signed.hash, floor.hash)) {
    try { record(signed) }
    catch (error) {
      deps.log(`[evm-inflight] WARN — could not raise the fee floor of nonce ${entry.nonce} (${describe(error)}); the next round resubmits nonce ${entry.nonce}'s newest bytes as-is`)
    }
  }
  return submitted.kind === 'submitted' ? { kind: 'sent', hash: signed.hash } : { kind: 'skipped' }
}
