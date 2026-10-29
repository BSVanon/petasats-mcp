import { type Address, type Hex } from 'viem'
import { MAX_EVM_INFLIGHT_SENDS, type EvmInflightSend } from './inflight-state'
import type { EvmNonceChainState, EvmNonceCounter, EvmNonceSelection } from './nonce-counter'
import { NonceStateDurabilityError } from './nonce-state-file'
import type { EvmSendLock } from './send-lock'
import { evmOperationKey, hashMismatch, replace, type EvmFeeCeilingError } from './inflight-replace'
import {
  minedOutcome,
  pendingOutcome,
  probeGenerations,
  receiptForHashes,
  resolveConsumedGenerations,
  submitSignedTransaction,
  type CounterSendOutcome,
  type EvmReceipt,
  type SignedTransaction,
} from './inflight-submit'

export { EvmSubmitHashMismatchError, type CounterSendOutcome } from './inflight-submit'
export { EvmFeeCeilingError, evmOperationKey } from './inflight-replace'

export const DEFAULT_EVM_RECEIPT_WAIT_MS = 10_000
export const DEFAULT_EVM_HEAD_BUMP_AFTER_MS = 30_000
export const DEFAULT_EVM_REFRESH_BUDGET_MS = 20_000
export const DEFAULT_EVM_UNRESOLVED_CONSUMED_RESEND_MS = 600_000
export const EVM_RECEIPT_WAIT_MS = DEFAULT_EVM_RECEIPT_WAIT_MS
export const EVM_HEAD_BUMP_AFTER_MS = DEFAULT_EVM_HEAD_BUMP_AFTER_MS

function boundedMs(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim()
  const value = raw ? Number(raw) : fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a safe integer in [${min}, ${max}] milliseconds (got '${raw ?? ''}')`)
  }
  return value
}

export const resolveEvmReceiptWaitMs = (env: Record<string, string | undefined> = process.env): number =>
  boundedMs(env, "EVM_RECEIPT_WAIT_MS", DEFAULT_EVM_RECEIPT_WAIT_MS, 2_000, 60_000)

export const resolveEvmHeadBumpAfterMs = (env: Record<string, string | undefined> = process.env): number =>
  boundedMs(env, "EVM_HEAD_BUMP_AFTER_MS", DEFAULT_EVM_HEAD_BUMP_AFTER_MS, 10_000, 600_000)

export const resolveEvmRefreshBudgetMs = (env: Record<string, string | undefined> = process.env): number =>
  boundedMs(env, "EVM_REFRESH_BUDGET_MS", DEFAULT_EVM_REFRESH_BUDGET_MS, 2_000, 30_000)

/** How long an attributed op's consumed nonce may stay without any receipt before one resend at a new nonce. Capped
 * at 10 minutes (~300 Base blocks), so even two unresolved generations stay far inside the 3600-block claim budget. */
export const resolveEvmUnresolvedConsumedResendMs = (env: Record<string, string | undefined> = process.env): number =>
  boundedMs(env, "EVM_UNRESOLVED_CONSUMED_RESEND_MS", DEFAULT_EVM_UNRESOLVED_CONSUMED_RESEND_MS, 120_000, 600_000)

/** Reconciliation is safe to retry because this is checked only before the engine authorizes or broadcasts a new nonce. */
export class EvmRefreshBudgetError extends Error {
  readonly retriable = true
  constructor(readonly elapsedMs: number, readonly budgetMs: number) {
    super(`EVM send deferred: nonce refresh took ${elapsedMs}ms, exceeding the ${budgetMs}ms pre-broadcast budget; retry`)
    this.name = 'EvmRefreshBudgetError'
  }
}

export interface EvmNewBroadcastCharge {
  release?: () => void
  consumed?: () => void
}

export type EvmNewBroadcastAuthorizer = () => EvmNewBroadcastCharge | Promise<EvmNewBroadcastCharge>

export interface CounterSendDeps {
  sendLock: EvmSendLock
  nonceCounter: EvmNonceCounter
  chainId: number
  sender: Address
  to: Address
  data: Hex
  pinnedContracts: readonly Address[]
  localAccount: unknown
  writer: {
    signTransaction(args: any): Promise<Hex>
    sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>
  }
  publicClient: {
    getTransactionReceipt(args: { hash: Hex }): Promise<EvmReceipt>
    waitForTransactionReceipt(args: { hash: Hex; timeout: number }): Promise<EvmReceipt>
    estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>
  }
  readChainState(): Promise<EvmNonceChainState>
  /** Prepare, price (fee ladder + ceiling), and sign at `nonce`. Must not submit anything to the network. */
  signNew(nonce: number): Promise<SignedTransaction>
  observeSelection(selection: EvmNonceSelection): void
  maxFeePerGasCeiling: bigint
  receiptWaitMs: number
  headBumpAfterMs: number
  refreshBudgetMs: number
  unresolvedConsumedResendMs: number
  retainConsumedAttribution: boolean
  /** Optional operator identity. Omitted callers retain the historical calldata-only operation key byte-for-byte. */
  operationSalt?: Hex
  authorizeNewBroadcast?: EvmNewBroadcastAuthorizer
  /** Runs after the signed bytes are durably attributed, but before their first raw submission. */
  onRecorded?: (signed: SignedTransaction & { nonce: number }) => void | Promise<void>
  now(): number
  log(message: string): void
  onFeeCeiling(error: EvmFeeCeilingError): void
  clearFeeCeiling(): void
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

function mined(entry: EvmInflightSend, receipt: EvmReceipt, consumesSendAllowance = false): CounterSendOutcome {
  return {
    hash: receipt.transactionHash ?? entry.hash,
    nonce: entry.nonce,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    consumesSendAllowance,
  }
}

function commit(charge: EvmNewBroadcastCharge | undefined, nonce: number, deps: CounterSendDeps): void {
  try { charge?.consumed?.() }
  catch (error) {
    deps.log(`[evm-inflight] new nonce ${nonce} was durably recorded but its allowance commit failed: ${describe(error)}`)
  }
}

/**
 * Counter-only send path. The flock covers every state read, durable record, submit, and atomic state update. Every
 * signed transaction is recorded BEFORE its bytes are submitted (write-ahead), so a lost acknowledgement, a transport
 * error, or a process death at any point leaves an entry the op resolves on retry instead of a duplicate at a new nonce.
 */
export async function sendCounterLeasedTransaction(deps: CounterSendDeps): Promise<CounterSendOutcome> {
  const opKey = evmOperationKey(deps.to, deps.data, deps.operationSalt)
  const startedAt = deps.now()
  let sent: { entry: EvmInflightSend; consumesSendAllowance: boolean } | undefined
  let immediate: CounterSendOutcome | undefined
  let resendPermitted = false

  await deps.sendLock.runExclusive(async () => {
    for (let refresh = 0; refresh <= MAX_EVM_INFLIGHT_SENDS + 1; refresh += 1) {
      const chain = await deps.readChainState()
      const selection = deps.nonceCounter.selectNonce(chain)
      deps.observeSelection(selection)
      const inflight = selection.inflight ?? []
      const target = inflight.find((entry) => same(entry.opKey, opKey))
      // Every consumed generation of this op, superseded ones included. Approve keeps no consumed attribution.
      const generations = deps.retainConsumedAttribution
        ? (selection.consumed ?? []).filter((entry) => same(entry.opKey, opKey))
        : []
      const head = inflight[0]

      if (!target && generations.length > 0 && !resendPermitted) {
        const verdict = await resolveConsumedGenerations({
          publicClient: deps.publicClient,
          unresolvedConsumedResendMs: deps.unresolvedConsumedResendMs,
          now: deps.now,
          log: deps.log,
          supersede: (nonce) => deps.nonceCounter.supersedeConsumed({ chainId: deps.chainId, address: deps.sender, nonce, opKey }),
        }, opKey, generations)
        if (verdict.kind === 'return') {
          immediate = verdict.outcome
          return
        }
        resendPermitted = true // exactly one new-nonce send for this op, charged normally below
      }

      if (target) {
        try {
          const hit = await probeGenerations(deps.publicClient, [target, ...generations])
          // Only the in-flight generation's own receipt, or a success of any generation, resolves the op. An older
          // generation's revert resolves nothing while the in-flight bytes are unmined: they can still mine.
          if (hit && (hit.generation === target || hit.receipt.status === 'success')) {
            if (hit.generation === target) {
              deps.nonceCounter.recordConsumed({ chainId: deps.chainId, address: deps.sender, nonce: target.nonce })
            }
            immediate = minedOutcome(hit)
            return
          }
        } catch {
          immediate = pendingOutcome(target.hash, target.nonce)
          return
        }
      }

      if (head) {
        const headReceipt = target === head ? undefined : await receiptForHashes(deps.publicClient, head.hashes)
        if (headReceipt) {
          deps.nonceCounter.recordConsumed({ chainId: deps.chainId, address: deps.sender, nonce: head.nonce })
          continue
        }
        if (deps.now() - head.broadcastAtMs >= deps.headBumpAfterMs) {
          const replacement = await replace(head, deps)
          if (replacement.kind === 'consumed') continue
          if (target === head && (replacement.kind === 'unknown' || replacement.kind === 'held')) {
            immediate = pendingOutcome(replacement.hash, head.nonce)
            return
          }
          // No new nonce behind a head held at the fee ceiling: it could not mine first, and a queue there would
          // hold committed charges and late locks. Deferred (retriable), as every op was before the hold existed.
          if (replacement.kind === 'held') throw replacement.error
          if (target === head && replacement.kind === 'sent') {
            // The replacement (or original) can mine between the submit and this re-read. selectNonce then moves
            // attributed operations into `consumed`; approve deliberately has no consumed attribution, so keep the
            // in-memory family as its receipt fallback. Never misclassify one of our mined hashes as "vanished".
            const refreshed = deps.nonceCounter.selectNonce(await deps.readChainState())
            const latest = refreshed.inflight?.find((entry) => entry.nonce === head.nonce && same(entry.opKey, opKey))
            const consumed = refreshed.consumed?.find((entry) => entry.nonce === head.nonce && same(entry.opKey, opKey))
            const hashes = [...new Set([
              ...head.hashes, ...(latest?.hashes ?? []), ...(consumed?.hashes ?? []), replacement.hash,
            ])]
            const minedHash = await receiptForHashes(deps.publicClient, hashes)
            if (minedHash) {
              immediate = {
                hash: minedHash.receipt.transactionHash ?? minedHash.queriedHash, nonce: head.nonce,
                blockNumber: minedHash.receipt.blockNumber, status: minedHash.receipt.status, consumesSendAllowance: false,
              }
              return
            }
            // Consumed with no receipt yet (a lagging receipt node or a foreign tx): pending, never a throw or resend.
            if (!latest) {
              immediate = pendingOutcome(replacement.hash, head.nonce)
              return
            }
            sent = { entry: latest, consumesSendAllowance: false }
            return
          }
        }
      }

      if (target) {
        immediate = pendingOutcome(target.hash, target.nonce)
        return
      }
      if (inflight.length >= MAX_EVM_INFLIGHT_SENDS) throw new Error(`EVM inflight table reached hard cap ${MAX_EVM_INFLIGHT_SENDS} (fail-closed)`)
      if (inflight.some((entry) => entry.nonce === selection.nonce)) {
        throw new Error(`EVM nonce ${selection.nonce} remains reserved for another operation (fail-closed)`)
      }
      const elapsedMs = deps.now() - startedAt
      if (elapsedMs > deps.refreshBudgetMs) throw new EvmRefreshBudgetError(elapsedMs, deps.refreshBudgetMs)
      const charge = deps.authorizeNewBroadcast ? await deps.authorizeNewBroadcast() : undefined
      let signed: SignedTransaction
      try {
        signed = await deps.signNew(selection.nonce)
        deps.nonceCounter.recordBroadcast({
          chainId: deps.chainId, address: deps.sender, nonce: selection.nonce,
          hash: signed.hash, signedTx: signed.signedTx, opKey,
          ...(deps.operationSalt !== undefined ? { operationSalt: deps.operationSalt } : {}),
          retainConsumedAttribution: deps.retainConsumedAttribution,
        })
        await deps.onRecorded?.({ ...signed, nonce: selection.nonce })
      } catch (error) {
        // Nothing was submitted. A record whose rename landed but may not be durable is already visible (a later head
        // bump may submit it), so it is charged like any recorded send; every other failure here precedes the record.
        if (error instanceof NonceStateDurabilityError) commit(charge, selection.nonce, deps)
        else charge?.release?.()
        throw error
      }
      const submitted = await submitSignedTransaction(deps.writer, signed)
      if (submitted.kind === 'nonce-too-low') {
        // These fresh bytes were submitted exactly once and rejected, so they never entered a mempool: the only case
        // that may erase a record. nextNonce stays advanced and the high-water mark rises past the rejected nonce.
        try {
          deps.nonceCounter.removeInflight({ chainId: deps.chainId, address: deps.sender, nonce: selection.nonce, opKey, hash: signed.hash })
        } catch (error) {
          commit(charge, selection.nonce, deps)
          throw error
        }
        charge?.release?.()
        deps.log(`[evm-inflight] WARN — nonce ${selection.nonce} was consumed by a transaction this signer did not record; re-selecting a nonce for op ${opKey.slice(0, 12)}`)
        continue
      }
      commit(charge, selection.nonce, deps) // from the durable record onward the new broadcast is charged (I6)
      deps.clearFeeCeiling() // after the commit, so nothing that can throw sits between the record and the charge
      if (submitted.kind === 'hash-mismatch') throw hashMismatch(deps, selection.nonce, signed.hash, submitted.returned)
      if (submitted.kind !== 'submitted') {
        // Outcome unknown (transport error, timeout, 5xx, unrecognized): keep the entry and hash, never release.
        deps.log(`[evm-inflight] new nonce ${selection.nonce} has an unknown submit outcome (${submitted.kind === 'unknown' ? submitted.detail : 'underpriced'}); recorded, returned pending`)
        immediate = pendingOutcome(signed.hash, selection.nonce, true)
        return
      }
      sent = {
        entry: {
          nonce: selection.nonce, hash: signed.hash, hashes: [signed.hash], signedTx: signed.signedTx,
          opKey, firstBroadcastAtMs: deps.now(), broadcastAtMs: deps.now(),
          ...(deps.operationSalt !== undefined ? { operationSalt: deps.operationSalt } : {}),
          retainConsumedAttribution: deps.retainConsumedAttribution,
        },
        consumesSendAllowance: true,
      }
      return
    }
    throw new Error('EVM nonce state did not converge after bounded refreshes (fail-closed)')
  })

  if (immediate) return immediate
  if (!sent) throw new Error('EVM counter send completed without an outcome (fail-closed)')
  try {
    const receipt = await deps.publicClient.waitForTransactionReceipt({ hash: sent.entry.hash, timeout: deps.receiptWaitMs })
    // The wait runs outside the lock, so another caller may have bumped this nonce meanwhile: read the durable family
    // before consuming the entry, not just the hashes captured before the wait.
    let family: readonly Hex[] = sent.entry.hashes
    await deps.sendLock.runExclusive(async () => {
      const identity = { chainId: deps.chainId, address: deps.sender, nonce: sent!.entry.nonce }
      family = [...sent!.entry.hashes, ...deps.nonceCounter.recordedHashes({ ...identity, opKey })]
      deps.nonceCounter.recordConsumed(identity)
    })
    // viem resolves a same-sender, same-nonce transaction it finds in a block as a replacement of the awaited hash.
    // A hash outside this op's recorded family consumed the nonce without performing the op (F-D): never report its
    // receipt as this op's outcome. The attribution kept by recordConsumed resolves or resends the op on its next call.
    const minedHash = receipt.transactionHash ?? sent.entry.hash
    if (!family.some((hash) => same(hash, minedHash))) {
      deps.log(`[evm-inflight] HEALTH CRITICAL — nonce ${sent.entry.nonce} was mined by ${minedHash}, which this signer never recorded for op ${opKey.slice(0, 12)} (foreign key use); returned pending`)
      return pendingOutcome(sent.entry.hash, sent.entry.nonce, sent.consumesSendAllowance)
    }
    return mined(sent.entry, receipt, sent.consumesSendAllowance)
  } catch {
    return pendingOutcome(sent.entry.hash, sent.entry.nonce, sent.consumesSendAllowance)
  }
}
