import { Transaction, Utils } from '@bsv/sdk'
import type { EvmNewBroadcastAuthorizer } from './evm/inflight-sends'
import { SettlementSession, validateSettlementRecord, type SettlementRecord, type SettlementState } from './settlement-session'
import { readSettlementRecordFile } from './atomic-record-write'
import { DEFAULT_BSV_FINALITY_CONFIRMATIONS, adoptedClaimResult, swapAlreadyResolvedResult, type ResolutionFinalityClassification, type WatchtowerDeps, type WatchHeights, type WatchtowerStatus } from './watchtower'
import { testnetChainInfo, broadcastTestnet, fetchTestnetTxConfirmations } from './bsv-testnet'
import { Erc20SwapEvmClient, type SwapResolutionOutcome } from './evm/client'
import { encodeClaim, encodeRefund, type Erc20SwapParams } from './evm/erc20swap'
import { extractBridgeCovenantSecret } from '../settlement/htlc/bridge-covenant'
import { assertSameWatchtowerRecordIdentity } from './watchtower-record-identity'
import { persistWatchtowerAdapterRecord } from './watchtower-record-persistence'
import { assertInitiatorRefundSafeOnBsv } from './initiator-refund-safety'
/** DRY sentinel for the receive-leg claim — nothing sent (used by the reveal backstop in dry mode). */
const DRY_RECEIVE_CLAIM = 'dry-receive-claim-not-sent'
/** DRY sentinel for the responder BSV refund — a NON-txid string so runWatchtower's isRealRefundTxid gate treats it
 *  as "not broadcast" and NEVER persists it as a real broadcast (a real-shaped txid would poison the record → a
 *  later LIVE resume would start in confirmation mode having sent nothing; review 2026-08-31 MED). Mirrors the
 *  initiator's DRY_BASE_REFUND. */
const DRY_BSV_REFUND = 'dry-bsv-refund-not-sent'
/** DRY sentinel for the initiator BSV claim re-broadcast. */
const DRY_BSV_CLAIM = 'dry-bsv-claim-not-sent'
const LABEL_CLAIMS_NO_LIVE_LOCK: ReadonlySet<SettlementState> = new Set(['created', 'settled', 'refunded', 'aborted'])

export interface BsvWatchtowerOpts {
  /** Where to durably persist the record after every state-affecting mutation (JSON sidecar). */
  persistPath: string
  /** Optional exact mode retained across atomic replacements (the isolated signer journal uses 0640). */
  persistMode?: number
  /** DRY: revalidate + log but never broadcast (returns the pre-derived refund txid so the loop proceeds). */
  dry?: boolean
  /** Live Base height (optional — the responder's gate is BSV; defaults to 0, unused by evaluateWatch). */
  baseHeight?: () => Promise<number>
  emit?: (s: WatchtowerStatus) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  maxPolls?: number
  refundConfs?: number
  /** Last-moment ownership fence, invoked immediately before every irreversible BSV/EVM recovery send. */
  beforeSend?: () => void | Promise<void>
  /** Daemon-only disk trust boundary: fully validate every fresh pre-send read and surface contradictory labels. */
  strictPersistedRecordTrust?: boolean
  // ── injectable rails (default = the real testnet functions; tests pass fakes) ──
  bsvHeight?: () => Promise<number>
  broadcastBsv?: (txHex: string, atomicBeefHex?: string) => Promise<string>
  bsvConfirmations?: (txid: string) => Promise<number>
  
  bsvFinality?: (txid: string, minimumConfirmations: number) => Promise<boolean>
  /** Best-effort BSV reveal detection — default is the built-in lock-spender scan (needs resolveSpender+fetchTx). */
  checkReveal?: (rec: SettlementRecord) => Promise<string | null>
  /** BSV discovery for the post-refund REVEAL backstop: which txid spent the lock outpoint, and fetch it to extract
   *  the revealed `s`. Both required for the built-in checkReveal to auto-detect a counterparty claim. */
  resolveSpender?: (txid: string, vout: number) => Promise<string | null>
  fetchTx?: (txid: string) => Promise<Transaction | null>
  
  evm?: RecoveryClaimEvm
}

/**
 * The MINIMAL EVM surface an in-process recovery needs, PER ROLE: `claim` for the RESPONDER claim-backstop (doc 25
 * E4 — recovers the USDC receive leg after a counterparty reveal wins the post-refund race), `refund` for the
 * INITIATOR recovery (doc 25 initiator-recovery / review bf542a12 CRITICAL — reclaims a crashed restock's locked USDC
 * at/after the Base timelock, the mirror of E4's claim→signer routing for the value-RECOVERING leg). Both are
 * OPTIONAL — a given watcher wires only the leg its role needs (a responder claim-backstop never sets `refund`; the
 * initiator recovery never sets `claim` — it never claims its own lock). The keyed {@link Erc20SwapEvmClient}
 * satisfies BOTH structurally; the keyless brain adapters split by role — `makeBrainEvmRails` (claim → the isolated
 * signer's `evmClaim`) for the responder, `makeBrainInitiatorEvmRails` (refund → RE-REGISTER the EVM binding, then
 * the signer's `evmRefund` — durable across a signer restart, since the binding registry is in-memory-only) for the
 * initiator — so either in-process recovery can run KEY-FREE in the brain.
 */
export interface RecoveryClaimEvm {
  address(): string
  readonly swapAddress: string
  readonly chainId: number
  claim(params: Erc20SwapParams, secret: number[], priorBroadcastTxid?: `0x${string}`, authorizeNewBroadcast?: EvmNewBroadcastAuthorizer): Promise<EvmWriteResult>
  refund?(params: Erc20SwapParams, priorBroadcastTxid?: `0x${string}`, authorizeNewBroadcast?: EvmNewBroadcastAuthorizer): Promise<EvmWriteResult>
  /** Canonical exact-tuple live-state read. Required before a reverted write may enter finalized outcome classification. */
  isSwapLocked?(params: Erc20SwapParams): Promise<boolean>
  /** The same exact-tuple mapping read at the OP-stack finalized head. */
  isSwapLockedFinalized?(params: Erc20SwapParams): Promise<boolean>
  /** Bind a mined transaction to exact contract calldata. */
  transactionCalls?(hash: `0x${string}`, to: `0x${string}`, data: `0x${string}`): Promise<boolean>
  /** True only after the receipt block is at/below OP-stack `finalized`; requireSuccess=false permits a finalized
   * reverted receipt only for the narrow already-resolved convergence path. */
  txFinalized?(hash: `0x${string}`, requireSuccess?: boolean): Promise<boolean>
  /** Canonical Claim/Refund event scan from the recorded lock block through the OP-stack finalized head. */
  resolveSwapOutcome?(params: Erc20SwapParams, fromBlock: bigint): Promise<SwapResolutionOutcome>
}

export interface EvmWriteResult {
  hash: string
  status: 'success' | 'reverted' | 'pending'
  nonce?: number
  consumesSendAllowance?: boolean
}

function classifyFinalizedOutcome(
  outcome: SwapResolutionOutcome,
  favorable: 'claimed' | 'refunded',
): ResolutionFinalityClassification {
  if (outcome.kind === 'unresolved') {
    return { kind: 'unresolved', reason: `${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ''}` }
  }
  if (outcome.kind === favorable) return { kind: 'favorable' }
  return outcome.kind === 'claimed'
    ? {
        kind: 'competing',
        resolution: { outcome: 'claimed', eventTxid: outcome.eventTxid, preimageHex: outcome.preimage.slice(2) },
      }
    : { kind: 'competing', resolution: { outcome: 'refunded', eventTxid: outcome.eventTxid } }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Decode every surviving wire artifact and execute-validate its subject against THIS record. If both raw and Atomic
 * BEEF are present, both must identify and validate as the same claim; one corrupt copy fails closed. */
export function persistedBsvClaimArtifactTxid(rec: SettlementRecord): string {
  if (!rec.bsvClaimTxid) throw new Error('persisted claim has no bsvClaimTxid')
  const claims: Transaction[] = []
  if (rec.bsvClaimBeefHex) {
    try { claims.push(Transaction.fromAtomicBEEF(Utils.toArray(rec.bsvClaimBeefHex, 'hex') as number[])) }
    catch { throw new Error('persisted bsvClaimBeefHex is not a decodable Atomic BEEF') }
  }
  if (rec.bsvClaimTxHex) {
    try { claims.push(Transaction.fromHex(rec.bsvClaimTxHex)) }
    catch { throw new Error('persisted bsvClaimTxHex is not a decodable transaction') }
  }
  if (claims.length === 0) throw new Error('persisted claim has no raw or Atomic BEEF artifact')
  const validator = SettlementSession.fromRecord(rec)
  for (const claim of claims) validator.assertPersistedClaimValid(claim)
  const derived = claims[0].id('hex')
  if (claims.some((claim) => claim.id('hex').toLowerCase() !== derived.toLowerCase())) {
    throw new Error('persisted raw and Atomic BEEF claim artifacts identify different transactions')
  }
  return derived
}

/**
 * Build the WatchtowerDeps for a RESPONDER's BSV-refund watch over `session`. Reuses the rails;
 * `refundBsv` revalidates the persisted artifact (last gate) before broadcasting.
 */
export function makeBsvWatchtowerDeps(session: SettlementSession, opts: BsvWatchtowerOpts): WatchtowerDeps {
  const recoveryIdentity = session.toRecord()
  const bsvHeight = opts.bsvHeight ?? (async () => (await testnetChainInfo()).blocks)
  const baseHeight = opts.baseHeight ?? (async () => 0)
  const broadcastBsv: (txHex: string, atomicBeefHex?: string) => Promise<string> = opts.broadcastBsv ?? broadcastTestnet
  const bsvConfirmations = opts.bsvConfirmations ?? fetchTestnetTxConfirmations

  return {
    heights: async (): Promise<WatchHeights> => ({ bsvHeight: await bsvHeight(), baseHeight: await baseHeight() }),

    refundBsv: async (rec: SettlementRecord): Promise<string> => {
      if (!rec.bsvRefundTxHex) throw new Error('refundBsv: record has no pre-signed bsvRefundTxHex')
      session.assertPersistedRefundValid() // broadcast-side LAST GATE — never spend a bad/stale artifact
      if (opts.dry) return DRY_BSV_REFUND // NON-txid sentinel — nothing sent, and never persisted as a broadcast (see const)
      await opts.beforeSend?.()
      // RT-16 invariant: submit the persisted bytes VERBATIM. Recovery never rebuilds or fee-bumps this transaction,
      // so every duplicate broadcast is byte-identical and therefore has the same txid. A future fee-bump feature
      // must add explicit replacement-family tracking before it may change this line.
      return broadcastBsv(rec.bsvRefundTxHex)
    },

    // The responder doesn't refund the Base leg; wiring that is the initiator-side follow-up.
    refundBase: async (): Promise<string> => { throw new Error('refundBase: not wired for the BSV-responder watcher (initiator-side follow-up)') },

    refundConfirmations: async (_rec: SettlementRecord, refundTxid: string): Promise<number> => bsvConfirmations(refundTxid),

    refundBelongsToSwap: async (rec: SettlementRecord, refundTxid: string): Promise<boolean> => {
      if (!opts.resolveSpender || !rec.bsvLockOutpoint || !rec.bsvRefundTxHex) return false
      
      // Discovery is corroboration only; a counterparty claim spending the same outpoint can never pass this equality.
      SettlementSession.fromRecord(rec).assertPersistedRefundValid()
      let persistedRefund: Transaction
      try { persistedRefund = Transaction.fromHex(rec.bsvRefundTxHex) } catch { return false }
      if (persistedRefund.id('hex').toLowerCase() !== refundTxid.toLowerCase()) return false
      const [lockTxid, voutText] = rec.bsvLockOutpoint.split('_')
      const vout = Number(voutText)
      if (!lockTxid || !Number.isSafeInteger(vout) || vout < 0) return false
      const spender = await opts.resolveSpender(lockTxid, vout)
      return spender?.toLowerCase() === refundTxid.toLowerCase()
    },

    refundFinality: async (_rec, refundTxid, confirmations): Promise<boolean> => {
      if (confirmations < DEFAULT_BSV_FINALITY_CONFIRMATIONS) return false
      // A discovery-provider confirmation count is never a finality proof. The live daemon supplies the
      // ChainTracker-backed rail; an unwired standalone/test adapter stays armed and fails closed.
      return opts.bsvFinality
        ? opts.bsvFinality(refundTxid, DEFAULT_BSV_FINALITY_CONFIRMATIONS)
        : false
    },
    minimumRefundConfs: DEFAULT_BSV_FINALITY_CONFIRMATIONS,

    // BR-H3 initiator recovery. Prefer the exact self-contained Atomic BEEF that was accepted on first broadcast;
    // retain/pass the raw subject transaction for raw-only ladder tiers. If only the BEEF survived, derive the raw
    // subject from it. In either case the artifact must decode to the persisted txid before anything is submitted.
    rebroadcastClaim: async (rec: SettlementRecord): Promise<string> => {
      const artifactTxid = persistedBsvClaimArtifactTxid(rec)
      let rawHex = rec.bsvClaimTxHex
      if (rec.bsvClaimBeefHex) {
        let claim: Transaction
        try {
          claim = Transaction.fromAtomicBEEF(Utils.toArray(rec.bsvClaimBeefHex, 'hex') as number[])
        } catch {
          throw new Error('rebroadcastClaim: persisted bsvClaimBeefHex is not a decodable Atomic BEEF')
        }
        if (claim.id('hex') !== artifactTxid) throw new Error('rebroadcastClaim: persisted BEEF subject txid does not match validated artifact identity')
        rawHex = claim.toHex()
      } else if (rawHex) {
        let claim: Transaction
        try { claim = Transaction.fromHex(rawHex) } catch { throw new Error('rebroadcastClaim: persisted bsvClaimTxHex is not a decodable transaction') }
        if (claim.id('hex') !== artifactTxid) throw new Error('rebroadcastClaim: persisted raw claim txid does not match validated artifact identity')
      }
      if (!rawHex) throw new Error('rebroadcastClaim: record has no persisted claim BEEF or raw transaction')
      if (opts.dry) return DRY_BSV_CLAIM
      await opts.beforeSend?.()
      return broadcastBsv(rawHex, rec.bsvClaimBeefHex)
    },

    claimConfirmations: async (_rec: SettlementRecord, claimTxid: string): Promise<number> => bsvConfirmations(claimTxid),
    claimArtifactTxid: async (rec: SettlementRecord): Promise<string> => persistedBsvClaimArtifactTxid(rec),
    resolveSpender: opts.resolveSpender,
    fetchTx: opts.fetchTx,
    claimFinality: async (_rec, claimTxid, confirmations): Promise<boolean> => {
      if (confirmations < DEFAULT_BSV_FINALITY_CONFIRMATIONS) return false
      return opts.bsvFinality
        ? opts.bsvFinality(claimTxid, DEFAULT_BSV_FINALITY_CONFIRMATIONS)
        : false
    },
    minimumClaimConfs: DEFAULT_BSV_FINALITY_CONFIRMATIONS,

    checkReveal: opts.checkReveal ?? (async (rec: SettlementRecord): Promise<string | null> => {
      // RESPONDER reveal detection: did a counterparty CLAIM spend our BSV lock, revealing `s`? Only a hashlock
      // claim yields `s` (our own 2-of-2 refund does not, so an unspent lock or a refund-spend both return null).
      // Best-effort — needs the discovery rails + the persisted outpoint; absent → null (the confirmation gate still
      // resolves the race safely, just without the auto-claim backstop).
      if (!opts.resolveSpender || !opts.fetchTx || !rec.bsvLockOutpoint) return null
      const [lockTxid, voutStr] = rec.bsvLockOutpoint.split('_')
      const vout = Number(voutStr)
      if (!lockTxid || !Number.isInteger(vout)) return null
      const spender = await opts.resolveSpender(lockTxid, vout)
      if (!spender) return null
      const tx = await opts.fetchTx(spender)
      if (!tx) return null
      // COVENANT-ONLY (Step E): the taker's claim reveals `s` via the covenant forced-output claim (`<preimage> <s>
      
      // the BSV. (Legacy signature-claim origination removed; old-lock recovery is the standalone script.)
      const s = extractBridgeCovenantSecret(tx, lockTxid, vout, rec.hashHex)
      return s ? Utils.toHex(s) : null
    }),

    // The post-refund receive-leg claim — wired only when an EVM claim key is injected (see BsvWatchtowerOpts.evm).
    ...(opts.evm
      ? {
          claimReceiveLegOnReveal: async (rec: SettlementRecord, secretHex: string, priorBroadcastTxid?: `0x${string}`): Promise<string> => {
            const evm = opts.evm as RecoveryClaimEvm
            // Fail-closed: this watcher's key MUST be the swap's designated claimAddress, on the same contract+chain.
            if (!eqAddrLower(evm.address(), rec.baseClaimAddress)) throw new Error(`claimReceiveLeg: watcher address ${evm.address()} ≠ record claimAddress ${rec.baseClaimAddress} — cannot claim`)
            if (!eqAddrLower(evm.swapAddress, rec.erc20SwapAddress)) throw new Error(`claimReceiveLeg: client swapAddress ${evm.swapAddress} ≠ record ${rec.erc20SwapAddress}`)
            if (evm.chainId !== rec.baseChainId) throw new Error(`claimReceiveLeg: client chainId ${evm.chainId} ≠ record ${rec.baseChainId}`)
            if (opts.dry) return DRY_RECEIVE_CLAIM // nothing sent
            const params = baseRefundParamsFromRecord(rec) 
            if (!evm.isSwapLocked) throw new Error('claimReceiveLeg: canonical isSwapLocked(exact tuple) rail is required before send')
            let locked: boolean
            try { locked = await evm.isSwapLocked(params) } catch (e) {
              throw new Error(`claimReceiveLeg: pre-send isSwapLocked(exact tuple) read failed — NOT sending: ${e instanceof Error ? e.message : String(e)}`)
            }
            if (!locked) {
              // The tuple left escrow before this watcher sent anything: usually the brain's own claim already paid
              
              // bound to this exact tuple; receiveClaimFinality re-binds it before anything terminal. A refund, a
              // missing anchor, or any doubt stays on this zero-gas retry path.
              let why = 'no finalized outcome rail or lock-block anchor'
              if (evm.resolveSwapOutcome && Number.isSafeInteger(rec.baseLockBlock) && (rec.baseLockBlock as number) > 0) {
                // Cheap gate before the event scan: while the tuple is still escrowed at the finalized head, no
                // finalized Claim/Refund can exist yet, so skip the lock-block→finalized log scan on those polls.
                let finalizedLocked: boolean | undefined = false
                if (evm.isSwapLockedFinalized) {
                  try { finalizedLocked = await evm.isSwapLockedFinalized(params) } catch { finalizedLocked = undefined }
                }
                if (finalizedLocked === undefined) why = 'finalized exact-tuple read failed'
                else if (finalizedLocked) why = 'still locked at the finalized head, so its resolution is not final yet'
                else {
                  const outcome = await evm.resolveSwapOutcome(params, BigInt(rec.baseLockBlock as number))
                  if (outcome.kind === 'claimed') return adoptedClaimResult(outcome.eventTxid)
                  why = outcome.kind === 'refunded'
                    ? `finalized Refund ${outcome.eventTxid}`
                    : `finalized outcome unresolved: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`
                }
              }
              throw new Error(`claimReceiveLeg: isSwapLocked(exact tuple)=false — NOT sending or spending gas (${why})`)
            }
            await opts.beforeSend?.()
            const sent = await evm.claim(params, Utils.toArray(secretHex, 'hex'), priorBroadcastTxid ?? (rec.baseRecoveryClaimTxid as `0x${string}` | undefined))
            if (sent.status === 'pending') return sent.hash
            if (sent.status !== 'success') {
              // A revert alone is ambiguous (RPC/provider defects stay retryable). Finalized tuple absence only enters
              // the separate Claim/Refund event classifier; it does not itself prove success.
              if (evm.isSwapLockedFinalized) {
                try {
                  if (!await evm.isSwapLockedFinalized(params)) return swapAlreadyResolvedResult('claim', sent.hash)
                } catch { /* doubt remains retryable below */ }
              }
              throw new Error(`claimReceiveLeg: ERC20Swap.claim reverted (${sent.hash}); exact tuple is not proven resolved at the finalized head — retry next poll`)
            }
            return sent.hash
          },
          receiveClaimFinality: async (rec: SettlementRecord, claimTxid: string, alreadyResolved: boolean): Promise<ResolutionFinalityClassification> => {
            const evm = opts.evm as RecoveryClaimEvm
            if (!evm.transactionCalls || !evm.txFinalized || !evm.isSwapLockedFinalized || !rec.secretHex) {
              return { kind: 'unresolved', reason: 'exact-call/finality rails or recorded secret missing' }
            }
            const params = baseRefundParamsFromRecord(rec)
            const exactCall = await evm.transactionCalls(
              claimTxid as `0x${string}`,
              rec.erc20SwapAddress as `0x${string}`,
              encodeClaim(params, Utils.toArray(rec.secretHex, 'hex')),
            )
            if (!exactCall || !await evm.txFinalized(claimTxid as `0x${string}`, !alreadyResolved) ||
                await evm.isSwapLockedFinalized(params)) {
              if (evm.resolveSwapOutcome && Number.isSafeInteger(rec.baseLockBlock) && (rec.baseLockBlock as number) > 0) {
                const outcome = await evm.resolveSwapOutcome(params, BigInt(rec.baseLockBlock as number))
                if (outcome.kind === 'claimed') return { kind: 'favorable', eventTxid: outcome.eventTxid }
                if (outcome.kind === 'refunded') return classifyFinalizedOutcome(outcome, 'claimed')
              }
              return { kind: 'unresolved', reason: 'exact claim call, finalized receipt, replacement event, or finalized tuple-absence proof failed' }
            }
            // A successful exact claim transaction, finalized receipt, and finalized tuple absence already bind
            
            if (!alreadyResolved) return { kind: 'favorable' }
            if (!evm.resolveSwapOutcome || !Number.isSafeInteger(rec.baseLockBlock) || (rec.baseLockBlock as number) <= 0) {
              return { kind: 'unresolved', reason: 'outcome rail or bounded lock-block anchor missing for reverted-claim convergence' }
            }
            const outcome = await evm.resolveSwapOutcome(params, BigInt(rec.baseLockBlock as number))
            if (outcome.kind !== 'unresolved' && outcome.eventTxid.toLowerCase() === claimTxid.toLowerCase()) {
              return { kind: 'unresolved', reason: 'the reverted claim transaction cannot also be the canonical resolution event transaction' }
            }
            return classifyFinalizedOutcome(outcome, 'claimed')
          },
        }
      : {}),

    reloadPersistedRecord: async (): Promise<SettlementRecord> => {
      const fresh = sessionFromRecordFile(readSettlementRecordFile(opts.persistPath)).toRecord()
      if (opts.strictPersistedRecordTrust) {
        validateSettlementRecord(fresh)
        assertSameWatchtowerRecordIdentity(recoveryIdentity, fresh, 'BSV recovery strict reload')
        if (LABEL_CLAIMS_NO_LIVE_LOCK.has(fresh.state) && (fresh.bsvLockOutpoint || fresh.bsvRefundTxHex)) {
          throw new Error(`persisted state '${fresh.state}' contradicts responder live-lock artifacts; operator attention required`)
        }
      }
      return fresh
    },

    persist: async (rec: SettlementRecord): Promise<void> => persistWatchtowerAdapterRecord(opts.persistPath, recoveryIdentity, rec, opts.strictPersistedRecordTrust, opts.persistMode),

    emit: opts.emit ?? ((s): void => console.log(`  [wt] ${s.action} · ${s.note}${s.gate ? ` (bsv gate ${s.gate.atHeight}, ~${Math.round(s.gate.etaSeconds / 60)}m)` : ''}`)),
    now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
    sleep: opts.sleep ?? realSleep,
    pollMs: opts.pollMs ?? 15_000,
    maxPolls: opts.maxPolls ?? 240,
    refundConfs: Math.max(opts.refundConfs ?? DEFAULT_BSV_FINALITY_CONFIRMATIONS, DEFAULT_BSV_FINALITY_CONFIRMATIONS),
  }
}

/**
 * Reconstruct the EXACT ERC20Swap tuple the machine locked, from the persisted record — the SAME
 * field mapping SettlementSession.validateObservedBaseLock enforces (preimageHash/amount/token/
 * claim/refund/timelock). The Boltz contract's swap identity is keccak(tuple); a refund with any
 * field off reverts on-chain, so a drifted reconstruction fails CLOSED (revert → retry, never a
 * silent wrong-swap refund).
 */
export function baseRefundParamsFromRecord(rec: SettlementRecord): Erc20SwapParams {
  return {
    preimageHash: `0x${rec.hashHex}` as `0x${string}`,
    amount: BigInt(rec.amountUsdc),
    tokenAddress: rec.usdcTokenAddress as `0x${string}`,
    claimAddress: rec.baseClaimAddress as `0x${string}`,
    refundAddress: rec.baseRefundAddress as `0x${string}`,
    timelock: BigInt(rec.baseTimelockBlock),
  }
}

const eqAddrLower = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** DRY sentinel returned instead of a real tx hash — its confirmations naturally read 0 (never mined). */
const DRY_BASE_REFUND = 'dry-base-refund-not-sent'

export interface BaseWatchtowerOpts {
  /** The machine's EVM client (mainnet RPC + machine key + the DEPLOYED ERC20Swap). Default rails read from it. */
  evm?: Erc20SwapEvmClient
  /** Where to durably persist the record after every state-affecting mutation (JSON sidecar). */
  persistPath: string
  /** DRY: validate the refund tuple encodes + heartbeat, but NEVER send (returns a non-broadcast sentinel). */
  dry?: boolean
  emit?: (s: WatchtowerStatus) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  maxPolls?: number
  refundConfs?: number
  /** Last-moment ownership fence, invoked immediately before the irreversible Base refund send. */
  beforeSend?: () => void | Promise<void>
  /** Daemon-only disk trust boundary: fully validate every fresh pre-send read and verify non-live labels on-chain. */
  strictPersistedRecordTrust?: boolean
  assertInitiatorRefundSafe?: (rec: SettlementRecord) => Promise<void>
  onInitiatorRefundSafetyResult?: (error?: string) => void
  // ── injectable rails (default = the EVM client's methods; tests pass fakes, no network) ──
  baseHeight?: () => Promise<number>
  baseRefund?: (params: Erc20SwapParams, priorBroadcastTxid?: `0x${string}`) => Promise<{ hash: string; status: 'success' | 'reverted' | 'pending'; nonce?: number }>
  baseConfirmations?: (txid: string) => Promise<number>
  /** Canonical live-state read used by the initiator refund-safety gate. The Boltz contract deletes the
   *  `swaps[hashValues(...)]` entry on claim OR refund, so only `true` proves the USDC is still escrowed and
   *  refundable. Defaults to the EVM client's keyless-safe `isSwapLocked` read. */
  baseIsSwapLocked?: (params: Erc20SwapParams) => Promise<boolean>
  /** Test/integration seam for binding a persisted hash to refund(exact tuple) on the configured swap contract. */
  baseRefundTransactionMatches?: (refundTxid: string, params: Erc20SwapParams) => Promise<boolean>
  /** OP-stack finality proof for a receipt. `requireSuccess=false` is used only for the mined-revert/already-resolved
   * convergence path, which separately proves the exact tuple absent at the finalized head. */
  baseTransactionFinalized?: (txid: string, requireSuccess?: boolean) => Promise<boolean>
  /** Canonical exact-tuple mapping read at the OP-stack finalized head. */
  baseIsSwapLockedFinalized?: (params: Erc20SwapParams) => Promise<boolean>
  /** Finalized canonical Claim/Refund event outcome, bounded from the recorded lock block. */
  baseResolveSwapOutcome?: (params: Erc20SwapParams, fromBlock: bigint) => Promise<SwapResolutionOutcome>
}

/**
 * Build the WatchtowerDeps for an INITIATOR's (machine's) Base USDC-refund watch over `session` —
 * the mirror of makeBsvWatchtowerDeps. If a swap stalls after the machine locks USDC, this
 * auto-calls `ERC20Swap.refund()` the moment the Base timelock (`baseTimelockBlock`) matures and
 * treats recovery as the refund's CONFIRMATION, not its broadcast.
 *
 * MONEY-SAFETY: the composed runWatchtower path NEVER broadcasts unless BOTH gates pass: (1) the Base
 * timelock is mature (evaluateWatch), and (2) the contract's canonical live-state read says the exact
 * tuple is still locked (checkReveal below). Boltz deletes `swaps[hashValues(...)]` on claim OR refund,
 * so `isSwapLocked === true` proves the initiator's USDC remains escrowed and refundable; false or any
 * read/RPC error fails closed for that poll. This is deliberately RPC-independent of historical logs.
 * refundBase then asserts the same contract+chain, validates the tuple, preserves DRY's no-send rule,
 * and throws on an on-chain revert so the loop retries rather than treating a failed refund as done.
 */
export function makeBaseWatchtowerDeps(session: SettlementSession, opts: BaseWatchtowerOpts): WatchtowerDeps {
  const recoveryIdentity = session.toRecord()
  const evm = opts.evm
  const baseHeight = opts.baseHeight ?? (async () => Number(await must(evm).currentBlockNumber()))
  const baseRefund = opts.baseRefund ?? (async (params: Erc20SwapParams, priorBroadcastTxid?: `0x${string}`) => {
    const sent = await must(evm).refund(params, priorBroadcastTxid)
    return { hash: sent.hash, status: sent.status }
  })
  const baseConfirmations = opts.baseConfirmations ?? (async (txid: string) => must(evm).txConfirmations(txid as `0x${string}`))
  const baseIsSwapLocked = opts.baseIsSwapLocked ?? (async (params: Erc20SwapParams) => must(evm).isSwapLocked(params))
  const baseRefundTransactionMatches = opts.baseRefundTransactionMatches ?? (async (txid: string, params: Erc20SwapParams) =>
    must(evm).transactionCalls(txid as `0x${string}`, must(evm).swapAddress, encodeRefund(params)))
  const baseTransactionFinalized = opts.baseTransactionFinalized ?? (async (txid: string, requireSuccess = true) =>
    must(evm).txFinalized(txid as `0x${string}`, requireSuccess))
  const baseIsSwapLockedFinalized = opts.baseIsSwapLockedFinalized ?? (async (params: Erc20SwapParams) =>
    must(evm).isSwapLockedFinalized(params))
  const baseResolveSwapOutcome = opts.baseResolveSwapOutcome ?? (async (params: Erc20SwapParams, fromBlock: bigint) =>
    must(evm).resolveSwapOutcome(params, fromBlock))

  return {
    // Initiator gate is the BASE height; bsvHeight is unused by evaluateWatch for this role.
    heights: async (): Promise<WatchHeights> => ({ bsvHeight: 0, baseHeight: await baseHeight() }),

    refundBase: async (rec: SettlementRecord): Promise<string> => {
      // Fail-closed: the client MUST point at the same contract + chain the record was locked on.
      if (evm) {
        if (!eqAddrLower(evm.swapAddress, rec.erc20SwapAddress)) throw new Error(`refundBase: client swapAddress ${evm.swapAddress} ≠ record ${rec.erc20SwapAddress}`)
        if (evm.chainId !== rec.baseChainId) throw new Error(`refundBase: client chainId ${evm.chainId} ≠ record ${rec.baseChainId}`)
      }
      const params = baseRefundParamsFromRecord(rec)
      encodeRefund(params) // validate the tuple encodes (throws on a malformed reconstruction) — also the DRY proof
      if (opts.dry) return DRY_BASE_REFUND // nothing sent; confirmations of the sentinel read 0
      await opts.beforeSend?.()
      const sent = await baseRefund(params, rec.refundTxid as `0x${string}` | undefined)
      if (sent.status === 'pending') return sent.hash
      if (sent.status !== 'success') {
        // Finalized tuple absence only enters the separate Claim/Refund event classifier. Any read error or `true`
        // keeps the old retry path (never abandon live escrow on doubt; never infer success from absence).
        try {
          if (await baseTransactionFinalized(sent.hash, false) && !await baseIsSwapLockedFinalized(params)) {
            return swapAlreadyResolvedResult('refund', sent.hash)
          }
        } catch { /* doubt remains retryable below */ }
        throw new Error(`refundBase: ERC20Swap.refund reverted (${sent.hash}); exact tuple is not proven resolved at the finalized head — retry next poll`)
      }
      return sent.hash
    },

    // The initiator doesn't refund the BSV leg; that's the responder-side (makeBsvWatchtowerDeps).
    refundBsv: async (): Promise<string> => { throw new Error('refundBsv: not wired for the Base-initiator watcher (responder-side path)') },

    refundConfirmations: async (_rec: SettlementRecord, refundTxid: string): Promise<number> => (refundTxid === DRY_BASE_REFUND ? 0 : baseConfirmations(refundTxid)),

    refundBelongsToSwap: async (rec: SettlementRecord, refundTxid: string): Promise<boolean> => {
      const params = baseRefundParamsFromRecord(rec)
      // A successful/confirmed hash is still untrusted: prove it called refund(exact tuple) on this contract, then
      // prove the contract's canonical live mapping says that exact tuple is no longer at risk.
      const transactionMatches = await baseRefundTransactionMatches(refundTxid, params)
      const stillLocked = await baseIsSwapLockedFinalized(params)
      return transactionMatches && !stillLocked
    },

    refundFinality: async (_rec, refundTxid): Promise<boolean> => baseTransactionFinalized(refundTxid, true),
    // The `finalized` receipt proof is the authoritative Base finality gate. Keep an eight-confirmation floor as a
    // second RPC sanity check, matching the existing OP-stack pre-lock gate's minimum-confirmation default.
    minimumRefundConfs: 8,
    assertInitiatorRefundSafe: opts.assertInitiatorRefundSafe ?? ((record) => assertInitiatorRefundSafeOnBsv(record)),
    ...(opts.onInitiatorRefundSafetyResult ? { onInitiatorRefundSafetyResult: opts.onInitiatorRefundSafetyResult } : {}),
    alreadyResolvedFinality: async (rec, result): Promise<ResolutionFinalityClassification> => {
      if (result.operation !== 'refund' || !Number.isSafeInteger(rec.baseLockBlock) || (rec.baseLockBlock as number) <= 0) {
        return { kind: 'unresolved', reason: 'refund operation or bounded lock-block anchor missing' }
      }
      const params = baseRefundParamsFromRecord(rec)
      if (!await baseRefundTransactionMatches(result.txid, params) || !await baseTransactionFinalized(result.txid, false) ||
          await baseIsSwapLockedFinalized(params)) {
        return { kind: 'unresolved', reason: 'exact refund call, finalized reverted receipt, or finalized tuple-absence proof failed' }
      }
      const outcome = await baseResolveSwapOutcome(params, BigInt(rec.baseLockBlock as number))
      if (outcome.kind !== 'unresolved' && outcome.eventTxid.toLowerCase() === result.txid.toLowerCase()) {
        return { kind: 'unresolved', reason: 'the reverted refund transaction cannot also be the canonical resolution event transaction' }
      }
      return classifyFinalizedOutcome(outcome, 'refunded')
    },

    // runWatchtower invokes checkReveal only after the timelock gate matures and immediately before the first
    // refund broadcast. For the INITIATOR, it is the blocking live-state safety gate rather than an event scan:
    // true => still escrowed/safe, false/error => throw so the core logs NOT-refunding + keeps polling.
    checkReveal: async (rec: SettlementRecord): Promise<null> => {
      if (rec.state === 'revealed' || rec.bsvClaimTxid || rec.bsvClaimTxHex || rec.bsvClaimBeefHex) throw new Error('initiator refund safety: durable BSV claim/reveal evidence exists; NOT refunding')
      const params = baseRefundParamsFromRecord(rec)
      let locked: boolean
      try {
        locked = await baseIsSwapLocked(params)
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        throw new Error(`initiator refund safety: isSwapLocked read failed — USDC lock state unknown; NOT refunding this poll: ${reason}`)
      }
      if (!locked) {
        throw new Error('initiator refund safety: isSwapLocked returned false — swap was claimed/already refunded or never locked; NOT refunding this poll')
      }
      return null
    },

    reloadPersistedRecord: async (): Promise<SettlementRecord> => {
      const fresh = sessionFromRecordFile(readSettlementRecordFile(opts.persistPath)).toRecord()
      if (opts.strictPersistedRecordTrust) {
        validateSettlementRecord(fresh)
        assertSameWatchtowerRecordIdentity(recoveryIdentity, fresh, 'Base recovery strict reload')
        if (LABEL_CLAIMS_NO_LIVE_LOCK.has(fresh.state)) {
          const params = baseRefundParamsFromRecord(fresh)
          if (await baseIsSwapLocked(params)) {
            throw new Error(`persisted state '${fresh.state}' contradicts isSwapLocked(exact tuple)=true; operator attention required`)
          }
          if (fresh.state === 'refunded') {
            if (!fresh.refundTxid || await baseConfirmations(fresh.refundTxid) < Math.max(fresh.refundConfirmationTarget ?? 8, 8) ||
                !await baseTransactionFinalized(fresh.refundTxid, true) ||
                !await baseRefundTransactionMatches(fresh.refundTxid, params)) {
              throw new Error('persisted refunded state lacks a confirmed refund(exact tuple) binding; operator attention required')
            }
          }
        }
      }
      return fresh
    },

    persist: async (rec: SettlementRecord): Promise<void> => persistWatchtowerAdapterRecord(opts.persistPath, recoveryIdentity, rec, opts.strictPersistedRecordTrust),

    emit: opts.emit ?? ((s): void => console.log(`  [wt] ${s.action} · ${s.note}${s.gate ? ` (base gate ${s.gate.atHeight}, ~${Math.round(s.gate.etaSeconds / 60)}m)` : ''}`)),
    now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
    sleep: opts.sleep ?? realSleep,
    pollMs: opts.pollMs ?? 15_000,
    maxPolls: opts.maxPolls ?? 240,
    refundConfs: Math.max(opts.refundConfs ?? 8, 8),
  }
}

/** Guard: a rail that falls back to the EVM client needs the client to be present. */
function must(evm: Erc20SwapEvmClient | undefined): Erc20SwapEvmClient {
  if (!evm) throw new Error('makeBaseWatchtowerDeps: pass opts.evm, or inject the base* rails explicitly')
  return evm
}

/** Load a persisted SettlementRecord + rehydrate the session (a restarted watcher resumes here). */
export function sessionFromRecordFile(json: string): SettlementSession {
  const rec = JSON.parse(json) as SettlementRecord
  return SettlementSession.fromRecord(rec)
}
