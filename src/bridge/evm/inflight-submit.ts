/**
 * Submit classification and receipt probing for the counter-leased EVM send engine (inflight-sends.ts).
 *
 * The engine durably records every signed transaction BEFORE its bytes leave the process. Everything here runs after
 * that record: it classifies what one `eth_sendRawTransaction` of the stored bytes proved, and it probes receipts
 * across every recorded generation of an operation, so a receipt node lagging the nonce node can never become a
 * duplicate send.
 */

import { keccak256, type Hex } from 'viem'
import type { EvmConsumedSend } from './inflight-state'

export type CounterSendOutcome =
  | { hash: Hex; nonce: number; blockNumber: bigint; status: 'success' | 'reverted'; consumesSendAllowance: boolean }
  | { hash: Hex; nonce: number; blockNumber: 0n; status: 'pending'; consumesSendAllowance: boolean }

export type EvmReceipt = { transactionHash?: Hex; blockNumber: bigint; status: 'success' | 'reverted' }

export interface ReceiptReader {
  getTransactionReceipt(args: { hash: Hex }): Promise<EvmReceipt>
}

export interface RawSubmitter {
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>
}

/** Locally signed bytes and their local hash, keccak256(signedTx) — the hash every EVM node derives for them. */
export interface SignedTransaction {
  hash: Hex
  signedTx: Hex
}

export const localTransactionHash = (signedTx: Hex): Hex => keccak256(signedTx)

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function isNotFound(error: unknown): boolean {
  const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /TransactionReceiptNotFound|transaction receipt.*not found|could not be found/i.test(detail)
}

/** Exact bytes already in the node's pool or chain; checked first, so a doubtful message never erases a record. */
export function isAlreadyKnown(error: unknown): boolean {
  return /already known|\bknown transaction|alreadyknown|transaction already imported/i.test(message(error))
}

export function isNonceTooLow(error: unknown): boolean {
  return /nonce too low|nonce has already been used/i.test(message(error))
}

export function isReplacementUnderpriced(error: unknown): boolean {
  return /replacement transaction underpriced|replacement fee too low/i.test(message(error))
}

/** A node acknowledged a different hash than the recorded bytes. The entry is kept; this is never retried blindly. */
export class EvmSubmitHashMismatchError extends Error {
  readonly retriable = false
  constructor(readonly nonce: number, readonly localHash: Hex, readonly returnedHash: string) {
    super(`EVM submit of nonce ${nonce} returned hash ${returnedHash}, not the recorded local hash ${localHash}; entry kept (fail-closed)`)
    this.name = 'EvmSubmitHashMismatchError'
  }
}

export type SubmitOutcome =
  | { kind: 'submitted' }
  | { kind: 'hash-mismatch'; returned: string }
  | { kind: 'nonce-too-low' }
  | { kind: 'underpriced' }
  | { kind: 'unknown'; detail: string }

/**
 * Submit the stored bytes exactly once and classify what that proved. Never throws: a transport error, timeout,
 * HTTP 5xx, or any unrecognized RPC error is `unknown` — the bytes may have been accepted.
 */
export async function submitSignedTransaction(writer: RawSubmitter, signed: SignedTransaction): Promise<SubmitOutcome> {
  let returned: unknown
  try {
    returned = await writer.sendRawTransaction({ serializedTransaction: signed.signedTx })
  } catch (error) {
    if (isAlreadyKnown(error)) return { kind: 'submitted' }
    if (isNonceTooLow(error)) return { kind: 'nonce-too-low' }
    if (isReplacementUnderpriced(error)) return { kind: 'underpriced' }
    return { kind: 'unknown', detail: message(error) }
  }
  if (typeof returned !== 'string' || returned.toLowerCase() !== signed.hash.toLowerCase()) {
    return { kind: 'hash-mismatch', returned: String(returned) }
  }
  return { kind: 'submitted' }
}

/** First receipt among one nonce's hash family. Read errors other than not-found propagate. */
export async function receiptForHashes(client: ReceiptReader, hashes: readonly Hex[]): Promise<{ receipt: EvmReceipt; queriedHash: Hex } | undefined> {
  for (const hash of hashes) {
    try {
      const receipt = await client.getTransactionReceipt({ hash })
      if (typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
        throw new Error(`EVM receipt transaction hash ${String(receipt.transactionHash)} does not match queried hash ${hash} (fail-closed)`)
      }
      return { receipt, queriedHash: hash }
    }
    catch (error) { if (!isNotFound(error)) throw error }
  }
  return undefined
}

export interface ProbeGeneration {
  nonce: number
  hashes: readonly Hex[]
}

export interface GenerationHit<G extends ProbeGeneration> {
  generation: G
  hash: Hex
  receipt: EvmReceipt
}

/**
 * Probe every hash of every generation of one operation. At most one generation can succeed (later duplicates of the
 * same call revert), so a success wins over a revert. `undefined` means every hash was definitively not found; any
 * other read error propagates, so an unreachable receipt node is never counted as a miss.
 */
export async function probeGenerations<G extends ProbeGeneration>(
  client: ReceiptReader,
  generations: readonly G[],
): Promise<GenerationHit<G> | undefined> {
  let reverted: GenerationHit<G> | undefined
  for (const generation of generations) {
    const found = await receiptForHashes(client, generation.hashes)
    if (!found) continue
    const hit = { generation, hash: found.receipt.transactionHash ?? found.queriedHash, receipt: found.receipt }
    if (found.receipt.status === 'success') return hit
    reverted ??= hit
  }
  return reverted
}

export function minedOutcome(hit: GenerationHit<ProbeGeneration>, consumesSendAllowance = false): CounterSendOutcome {
  return {
    hash: hit.hash, nonce: hit.generation.nonce, blockNumber: hit.receipt.blockNumber, status: hit.receipt.status,
    consumesSendAllowance,
  }
}

export function pendingOutcome(hash: Hex, nonce: number, consumesSendAllowance = false): CounterSendOutcome {
  return { hash, nonce, blockNumber: 0n, status: 'pending', consumesSendAllowance }
}

export interface ConsumedGenerationDeps {
  publicClient: ReceiptReader
  unresolvedConsumedResendMs: number
  now(): number
  log(message: string): void
  supersede(nonce: number): void
}

export type ConsumedGenerationVerdict = { kind: 'return'; outcome: CounterSendOutcome } | { kind: 'resend' }

/**
 * An attributed operation with no in-flight entry, whose recorded nonce(s) were consumed. Every generation is probed,
 * superseded ones included. Without a receipt the operation is pending (no broadcast, no charge). Exactly one resend
 * is permitted per generation, and only when that newest generation has stayed unresolved for the full threshold AND
 * this same call's fresh probe found none of its hashes. The generation is then superseded, never deleted.
 */
export async function resolveConsumedGenerations(
  deps: ConsumedGenerationDeps,
  opKey: Hex,
  generations: readonly EvmConsumedSend[],
): Promise<ConsumedGenerationVerdict> {
  // A later generation always has a higher nonce (selection never goes below a consumed nonce), unlike wall-clock
  // consumedAtMs, which a clock step could reorder.
  const newest = generations.reduce((best, candidate) => candidate.nonce > best.nonce ? candidate : best)
  // Newest first, so a revert found first is the newest generation's own. An older generation's revert resolves
  // nothing while the newest has no receipt: its consumed nonce may hold a success a lagging node has not shown yet.
  const hit = await probeGenerations(deps.publicClient, [...generations].sort((a, b) => b.nonce - a.nonce))
  if (hit && (hit.receipt.status === 'success' || hit.generation === newest)) return { kind: 'return', outcome: minedOutcome(hit) }
  if (newest.superseded) {
    deps.log(`[evm-inflight] WARN — resuming the one permitted resend of op ${opKey.slice(0, 12)} (nonce ${newest.nonce} still unresolved; its resend was never recorded)`)
    return { kind: 'resend' }
  }
  if (deps.now() - newest.consumedAtMs < deps.unresolvedConsumedResendMs) {
    return { kind: 'return', outcome: pendingOutcome(newest.hashes[newest.hashes.length - 1], newest.nonce) }
  }
  deps.log(
    `[evm-inflight] HEALTH CRITICAL — nonce ${newest.nonce} was consumed but no receipt for any of this op's hashes ` +
    `appeared within the threshold (foreign key use, a deep reorg, or a receipt node lagging that long); resending op ` +
    `${opKey.slice(0, 12)} at a new nonce`,
  )
  deps.supersede(newest.nonce)
  return { kind: 'resend' }
}
