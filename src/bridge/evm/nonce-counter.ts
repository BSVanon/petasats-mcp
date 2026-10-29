import { join, resolve } from 'node:path'
import { resolveMakerSignerStatePath } from './signer-state-path'
import { type Address, type Hex } from 'viem'
import {
  pruneInflight,
  putConsumed,
  putInflight,
  type EvmConsumedSend,
  type EvmInflightSend,
  type EvmNonceState,
} from './inflight-state'
import {
  assertIdentity,
  assertNonce,
  nonceStateFsOps,
  readNonceStateFile,
  writeNonceStateFile,
  type NonceStateFsOps,
} from './nonce-state-file'

export type { EvmConsumedSend, EvmInflightSend, EvmNonceState } from './inflight-state'
export { NonceStateDurabilityError, type NonceStateFsOps } from './nonce-state-file'
export { initializeMissingNonceStateFile } from './nonce-state-file'

export const DEFAULT_EVM_NONCE_GAP_ALERT_MS = 60_000

export interface EvmNonceCounter {
  readonly path: string
  selectNonce(args: EvmNonceChainState): EvmNonceSelection
  recordBroadcast(args: { chainId: number; address: Address; nonce: number; hash?: Hex; signedTx?: Hex; opKey?: Hex; operationSalt?: Hex; retainConsumedAttribution?: boolean; floorSignedTx?: Hex }): void
  recordConsumed(args: { chainId: number; address: Address; nonce: number }): void
  /**
   * New-nonce "nonce too low" only: erase the one entry whose freshly signed bytes were submitted once and rejected
   * (they never entered a mempool). Refuses unless the entry at `nonce` is this op with exactly this one hash.
   * nextNonce stays advanced and the high-water mark rises past the rejected nonce.
   */
  removeInflight(args: { chainId: number; address: Address; nonce: number; opKey: Hex; hash: Hex }): void
  /** Mark exactly one tombstone generation {opKey, nonce} superseded, keeping its hashes for later receipt probes. */
  supersedeConsumed(args: { chainId: number; address: Address; nonce: number; opKey: Hex }): void
  /** Read-only: every hash recorded for this op at `nonce`, whether still in flight or already consumed. */
  recordedHashes(args: { chainId: number; address: Address; nonce: number; opKey: Hex }): Hex[]
  assertReady(args: EvmNonceChainState): EvmNonceSelection
}

export interface FileEvmNonceCounterOpts {
  gapAlertMs?: number
  now?: () => number
  log?: (message: string) => void
  /** Test seam: observe or fail individual filesystem calls. Production omits it. */
  fsOps?: Partial<NonceStateFsOps>
}

export interface EvmNonceChainState {
  chainId: number
  address: Address
  chainPending: number
  chainLatest: number
}

export interface EvmNonceGapObservation {
  kind: 'counter-ahead-with-inflight'
  chainLatest: number
  chainPending: number
  nextNonce: number
  observedForMs: number
  alert: boolean
}

export interface EvmNonceSelection {
  nonce: number
  source: 'first-boot' | 'chain' | 'counter' | 'dropped-gap-resync'
  inflight?: EvmInflightSend[]
  consumed?: EvmConsumedSend[]
  gapObservation?: EvmNonceGapObservation
}

export function resolveMakerEvmNonceStatePath(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const raw = env.MAKER_EVM_NONCE_STATE?.trim() || join(resolveMakerSignerStatePath(env, cwd), 'evm-nonce.json')
  if (raw.includes('\0') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    throw new Error(`MAKER_EVM_NONCE_STATE must be a local filesystem path shared by the signer and watchtower daemon (got '${raw}')`)
  }
  return resolve(cwd, raw)
}

export function resolveMakerEvmNonceGapAlertMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.MAKER_EVM_NONCE_GAP_ALERT_MS?.trim()
  const value = raw ? Number(raw) : DEFAULT_EVM_NONCE_GAP_ALERT_MS
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`MAKER_EVM_NONCE_GAP_ALERT_MS must be a positive safe integer (got '${raw ?? ''}')`)
  }
  return value
}

/** A nonce proven consumed puts the chain's latest nonce at >= nonce + 1; never lower an existing mark. */
function raisedHighWater(state: EvmNonceState, consumedNonce: number): number {
  if (consumedNonce >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`EVM nonce counter cannot safely persist nonce ${consumedNonce} + 1 (fail-closed)`)
  }
  return Math.max(state.latestHighWater ?? 0, consumedNonce + 1)
}

/** File implementation. The caller must hold the shared send lock across every method call and the raw broadcast. */
export class FileEvmNonceCounter implements EvmNonceCounter {
  readonly path: string
  private readonly tmpPath: string
  private readonly gapAlertMs: number
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly fsOps: NonceStateFsOps
  private assertedReady = false

  constructor(path: string, opts: FileEvmNonceCounterOpts = {}) {
    if (!path.trim() || path.includes('\0') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) {
      throw new Error(`EVM nonce counter path must be a non-empty local filesystem path (got '${path}')`)
    }
    this.path = resolve(path)
    this.tmpPath = `${this.path}.tmp`
    this.gapAlertMs = opts.gapAlertMs ?? DEFAULT_EVM_NONCE_GAP_ALERT_MS
    if (!Number.isSafeInteger(this.gapAlertMs) || this.gapAlertMs < 1) {
      throw new Error(`EVM nonce counter gapAlertMs must be a positive safe integer (got ${String(this.gapAlertMs)})`)
    }
    this.now = opts.now ?? (() => Date.now())
    this.log = opts.log ?? console.error
    this.fsOps = nonceStateFsOps(opts.fsOps)
  }

  private readState(): EvmNonceState | undefined {
    return readNonceStateFile(this.path, this.tmpPath, this.fsOps)
  }

  /** Durable replace; throws (NonceStateDurabilityError after the rename) so no bytes are submitted on a doubtful record. */
  private writeState(state: EvmNonceState): void {
    writeNonceStateFile(this.path, this.tmpPath, state, this.fsOps)
  }

  private validateChainState(args: EvmNonceChainState): void {
    assertIdentity(args.chainId, args.address)
    assertNonce(args.chainPending, 'chainPending')
    assertNonce(args.chainLatest, 'chainLatest')
    if (args.chainPending < args.chainLatest) {
      throw new Error(
        `EVM nonce counter: chainPending ${args.chainPending} is below chainLatest ${args.chainLatest} ` +
        '(impossible/inconsistent RPC state; fail-closed)',
      )
    }
  }

  private assertStateIdentity(state: EvmNonceState, args: EvmNonceChainState): void {
    if (state.chainId !== args.chainId || state.address.toLowerCase() !== args.address.toLowerCase()) {
      throw new Error(
        `EVM nonce counter ${this.path} belongs to chainId ${state.chainId} address ${state.address}, not ` +
        `chainId ${args.chainId} address ${args.address} (foreign counter; fail-closed)`,
      )
    }
  }

  private reconcile(state: EvmNonceState | undefined, args: EvmNonceChainState): EvmNonceSelection {
    if (!state) {
      if (this.assertedReady) {
        throw new Error(`EVM nonce counter ${this.path} disappeared after readiness was established (lost mid-life; fail-closed)`)
      }
      // Absence is distinguishable from a genuine first boot only for a never-used account. Any confirmed history,
      // or even a pending nonce on an otherwise-new account, could be a lost counter plus a stale/partial RPC view.
      // Never select from it: the operator must stop senders, confirm nothing is pending, and run the explicit init.
      if (args.chainLatest !== 0 || args.chainPending !== 0) {
        throw new Error(
          `EVM nonce counter ${this.path} is missing for an account with chain history/pending activity ` +
          `(latest=${args.chainLatest}, pending=${args.chainPending}); refusing new sends until ` +
          'scripts/init-evm-nonce-state.ts is reviewed and run with --yes after confirming nothing is pending',
        )
      }
      this.log(
        `[evm-nonce-counter] ${this.path} is absent and latest=pending=0; initializing a brand-new account at nonce 0.`,
      )
      return { nonce: 0, source: 'first-boot', inflight: [] }
    }
    this.assertStateIdentity(state, args)
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error(`EVM nonce counter clock must return a non-negative safe integer (got ${String(now)})`)
    }

    // Fault model:
    //  * pending >= nextNonce: an external send or chain progress wins.
    //  * pending < nextNonce and pending > latest: at least one tx is in flight. A stale pending read may be hiding
    //    our exact prior nonce, so moving down can collide; retain the monotone max.
    //  * pending === latest < nextNonce: the provider reports no in-flight tx at all. Only this proof permits
    //    reclaiming a dropped-nonce gap. There is deliberately no elapsed-time resync path.
    //  * latest below the persisted high-water mark: this read is provably stale (a load-balanced node lagging an
    //    earlier observation), so it proves nothing and selection never goes below the mark.
    const floor = Math.max(state.latestHighWater ?? 0, args.chainLatest)
    const inflight = pruneInflight(state.inflight, args.chainLatest)
    const pendingReserved = inflight.some((entry) => entry.nonce === args.chainPending)
    const provenDroppedGap = args.chainLatest === args.chainPending && args.chainPending < state.nextNonce &&
      !pendingReserved && args.chainLatest >= floor
    const nonce = provenDroppedGap ? args.chainPending : Math.max(state.nextNonce, args.chainPending, floor)
    // The successful-broadcast state must be able to represent nonce+1 before we risk broadcasting this nonce.
    if (nonce >= Number.MAX_SAFE_INTEGER) throw new Error(`EVM nonce counter cannot safely persist nonce ${nonce} + 1 (fail-closed)`)
    const counterAheadWithInflight = args.chainPending < state.nextNonce && args.chainPending > args.chainLatest
    const observedForMs = Math.max(0, now - state.lastBroadcastAtMs)
    return {
      nonce,
      source: provenDroppedGap ? 'dropped-gap-resync' : nonce === args.chainPending ? 'chain' : 'counter',
      inflight,
      consumed: state.consumed ?? [],
      ...(counterAheadWithInflight ? {
        gapObservation: {
          kind: 'counter-ahead-with-inflight' as const,
          chainLatest: args.chainLatest,
          chainPending: args.chainPending,
          nextNonce: state.nextNonce,
          observedForMs,
          alert: observedForMs >= this.gapAlertMs,
        },
      } : {}),
    }
  }

  selectNonce(args: EvmNonceChainState): EvmNonceSelection {
    this.validateChainState(args)
    let state = this.readState()
    if (state) {
      this.assertStateIdentity(state, args) // never rewrite a foreign file below
      const inflight = pruneInflight(state.inflight, args.chainLatest)
      const pruned = inflight.length !== (state.inflight?.length ?? 0)
      const raised = args.chainLatest > (state.latestHighWater ?? 0) // written only when it increases
      if (pruned || raised) {
        let consumed = state.consumed ?? []
        for (const entry of pruned ? state.inflight ?? [] : []) {
          if (entry.nonce < args.chainLatest && entry.retainConsumedAttribution) {
            consumed = putConsumed(consumed, {
              opKey: entry.opKey, nonce: entry.nonce, hashes: entry.hashes, consumedAtMs: this.now(),
            })
          }
        }
        state = {
          ...state,
          ...(raised ? { latestHighWater: args.chainLatest } : {}),
          ...(inflight.length ? { inflight } : { inflight: undefined }),
          ...(consumed.length ? { consumed } : { consumed: undefined }),
        }
        this.writeState(state)
      }
    }
    return this.reconcile(state, args)
  }

  /**
   * Boot/runtime probe. The caller holds the shared flock. On this instance's first probe, existing state is opened,
   * inode-checked, parsed, identity-checked, and atomically replaced unchanged to prove this UID can perform the
   * eventual post-broadcast replace. A genuinely absent first-boot file is initialized from chain pending and logged
   * loudly. Once readiness is established, later probes stay read-only and disappearance fails closed.
   */
  assertReady(args: EvmNonceChainState): EvmNonceSelection {
    this.validateChainState(args)
    const state = this.readState()
    const selection = this.reconcile(state, args)
    if (!state) {
      const now = this.now()
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error(`EVM nonce counter clock must return a non-negative safe integer (got ${String(now)})`)
      }
      this.writeState({
        chainId: args.chainId,
        address: args.address.toLowerCase() as Address,
        nextNonce: args.chainPending,
        lastBroadcastAtMs: now,
      })
      // Re-open the named inode after the atomic replace so readiness proves this process can read what it created.
      const initialized = this.readState()
      if (!initialized) throw new Error(`EVM nonce counter ${this.path} vanished during first-boot initialization (fail-closed)`)
      this.assertStateIdentity(initialized, args)
    } else if (!this.assertedReady) {
      // An existing 0660 file may be readable through the shared group while its directory is not replaceable. Prove
      // the complete post-broadcast filesystem operation now, before any money send can be accepted by the RPC.
      this.writeState(state)
      const replaced = this.readState()
      if (!replaced) throw new Error(`EVM nonce counter ${this.path} vanished during readiness replace (fail-closed)`)
      this.assertStateIdentity(replaced, args)
    }
    this.assertedReady = true
    return selection
  }

  recordBroadcast(args: { chainId: number; address: Address; nonce: number; hash?: Hex; signedTx?: Hex; opKey?: Hex; operationSalt?: Hex; retainConsumedAttribution?: boolean; floorSignedTx?: Hex }): void {
    assertIdentity(args.chainId, args.address)
    assertNonce(args.nonce, 'broadcast nonce')
    if (args.nonce >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`EVM nonce counter cannot safely persist nonce ${args.nonce} + 1 (fail-closed)`)
    }
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error(`EVM nonce counter clock must return a non-negative safe integer (got ${String(now)})`)
    }
    const state = this.readState()
    if (state) this.assertStateIdentity(state, { ...args, chainPending: args.nonce, chainLatest: args.nonce })
    const metadataCount = Number(args.hash !== undefined) + Number(args.signedTx !== undefined) + Number(args.opKey !== undefined) + Number(args.retainConsumedAttribution !== undefined)
    if (metadataCount !== 0 && metadataCount !== 4) throw new Error('EVM nonce counter broadcast metadata must be complete (fail-closed)')
    if (args.operationSalt !== undefined && (metadataCount !== 4 || !/^0x[0-9a-fA-F]{64}$/.test(args.operationSalt))) {
      throw new Error('EVM nonce counter operation salt requires complete metadata and 32 bytes (fail-closed)')
    }
    if (args.floorSignedTx !== undefined && metadataCount !== 4) throw new Error('EVM nonce counter fee floor needs complete broadcast metadata (fail-closed)')
    let inflight = state?.inflight ?? []
    if (args.hash && args.signedTx && args.opKey && args.retainConsumedAttribution !== undefined) {
      const prior = inflight.find((entry) => entry.nonce === args.nonce)
      if (prior && ((prior.operationSalt === undefined) !== (args.operationSalt === undefined) ||
          (prior.operationSalt !== undefined && args.operationSalt !== undefined && prior.operationSalt.toLowerCase() !== args.operationSalt.toLowerCase()))) {
        throw new Error(`EVM nonce counter refused a replacement with a different operation salt at nonce ${args.nonce} (fail-closed)`)
      }
      const entry: EvmInflightSend = {
        nonce: args.nonce,
        hash: args.hash,
        // A replacement priced from the fee floor can reproduce an earlier generation's exact bytes. Re-recording
        // moves that hash to the end, so the newest recorded hash stays last.
        hashes: [...(prior?.hashes ?? []).filter((hash) => hash.toLowerCase() !== args.hash!.toLowerCase()), args.hash],
        signedTx: args.signedTx,
        ...(args.floorSignedTx !== undefined ? { floorSignedTx: args.floorSignedTx } : {}),
        opKey: args.opKey,
        ...(prior?.operationSalt !== undefined ? { operationSalt: prior.operationSalt }
          : args.operationSalt !== undefined ? { operationSalt: args.operationSalt } : {}),
        firstBroadcastAtMs: prior?.firstBroadcastAtMs ?? now,
        broadcastAtMs: now,
        retainConsumedAttribution: prior?.retainConsumedAttribution ?? args.retainConsumedAttribution,
      }
      inflight = putInflight(inflight, entry)
    }
    this.writeState({
      chainId: args.chainId,
      address: args.address.toLowerCase() as Address,
      nextNonce: Math.max(state?.nextNonce ?? 0, args.nonce + 1),
      lastBroadcastAtMs: now,
      ...(state?.latestHighWater ? { latestHighWater: state.latestHighWater } : {}),
      ...(inflight.length ? { inflight } : {}),
      ...(state?.consumed?.length ? { consumed: state.consumed } : {}),
    })
  }

  recordConsumed(args: { chainId: number; address: Address; nonce: number }): void {
    assertIdentity(args.chainId, args.address)
    assertNonce(args.nonce, 'consumed nonce')
    const state = this.readState()
    if (!state) throw new Error(`EVM nonce counter ${this.path} is absent while consuming nonce ${args.nonce} (fail-closed)`)
    this.assertStateIdentity(state, { ...args, chainPending: args.nonce, chainLatest: args.nonce })
    const target = (state.inflight ?? []).find((entry) => entry.nonce === args.nonce)
    const inflight = (state.inflight ?? []).filter((entry) => entry.nonce !== args.nonce)
    let consumed = state.consumed ?? []
    if (target?.retainConsumedAttribution) {
      consumed = putConsumed(consumed, {
        opKey: target.opKey, nonce: target.nonce, hashes: target.hashes, consumedAtMs: this.now(),
      })
    }
    this.writeState({
      ...state,
      latestHighWater: raisedHighWater(state, args.nonce), // a receipt or "nonce too low" at N observed latest > N
      ...(inflight.length ? { inflight } : { inflight: undefined }),
      ...(consumed.length ? { consumed } : { consumed: undefined }),
    })
  }

  removeInflight(args: { chainId: number; address: Address; nonce: number; opKey: Hex; hash: Hex }): void {
    assertIdentity(args.chainId, args.address)
    assertNonce(args.nonce, 'removed nonce')
    const state = this.readState()
    if (!state) throw new Error(`EVM nonce counter ${this.path} is absent while removing nonce ${args.nonce} (fail-closed)`)
    this.assertStateIdentity(state, { ...args, chainPending: args.nonce, chainLatest: args.nonce })
    const entry = (state.inflight ?? []).find((candidate) => candidate.nonce === args.nonce)
    if (!entry || entry.opKey.toLowerCase() !== args.opKey.toLowerCase() || entry.hashes.length !== 1 ||
        entry.hashes[0].toLowerCase() !== args.hash.toLowerCase()) {
      throw new Error(`EVM nonce counter refused to erase nonce ${args.nonce}: its entry is not exactly the one rejected transaction (fail-closed)`)
    }
    const inflight = (state.inflight ?? []).filter((candidate) => candidate.nonce !== args.nonce)
    this.writeState({
      ...state,
      latestHighWater: raisedHighWater(state, args.nonce),
      ...(inflight.length ? { inflight } : { inflight: undefined }),
    })
  }

  supersedeConsumed(args: { chainId: number; address: Address; nonce: number; opKey: Hex }): void {
    assertIdentity(args.chainId, args.address)
    assertNonce(args.nonce, 'superseded nonce')
    const state = this.readState()
    if (!state) throw new Error(`EVM nonce counter ${this.path} is absent while superseding nonce ${args.nonce} (fail-closed)`)
    this.assertStateIdentity(state, { ...args, chainPending: args.nonce, chainLatest: args.nonce })
    const matches = (entry: EvmConsumedSend): boolean =>
      entry.nonce === args.nonce && entry.opKey.toLowerCase() === args.opKey.toLowerCase()
    if (!(state.consumed ?? []).some(matches)) {
      throw new Error(`EVM nonce counter has no consumed generation for nonce ${args.nonce} of this operation to supersede (fail-closed)`)
    }
    const consumed = (state.consumed ?? []).map((entry) => matches(entry) ? { ...entry, superseded: true as const } : entry)
    this.writeState({ ...state, consumed })
  }

  recordedHashes(args: { chainId: number; address: Address; nonce: number; opKey: Hex }): Hex[] {
    assertIdentity(args.chainId, args.address)
    assertNonce(args.nonce, 'recorded nonce')
    const state = this.readState()
    if (!state) throw new Error(`EVM nonce counter ${this.path} is absent while reading nonce ${args.nonce} (fail-closed)`)
    this.assertStateIdentity(state, { ...args, chainPending: args.nonce, chainLatest: args.nonce })
    const ours = (entry: { nonce: number; opKey: Hex }): boolean =>
      entry.nonce === args.nonce && entry.opKey.toLowerCase() === args.opKey.toLowerCase()
    return [...(state.inflight ?? []), ...(state.consumed ?? [])].filter(ours).flatMap((entry) => entry.hashes)
  }
}
