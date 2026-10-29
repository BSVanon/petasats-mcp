import { Beef, P2PKH, Transaction, type PrivateKey, type WalletAction, type WalletInterface } from '@bsv/sdk'
import { listAllActions } from '../../wallet/list-all-actions'
import { CANCEL_LABEL, isResolvedLock, type ResolvedLock } from '../../wallet/stranded-lock-cancel'
import { HTLC_LOCK_FUND_LABEL, isInertLockDraft, QUARANTINED_LOCK_STATUSES } from './quarantined-locks'
export { HTLC_LOCK_FUND_LABEL } from './quarantined-locks'
/** Fetch a funding tx's atomic BEEF (each agent serves this from its OWN Anvil node — no third-party trust). */
export type FetchBeef = (txid: string) => Promise<number[]>
export interface WalletHtlcLockParams {
  /** The exact HTLC locking script (from `buildBsvHtlcScript`) — pinned as the vout-0 output; never re-templated. */
  htlcScriptHex: string
  /** Sats locked into the HTLC. The output value must equal this exactly (the refund half-sig commits to it). */
  amountSats: number
  reserveBasket: string
  /** Root key controlling the basketed reserve P2PKH (signs the funding input externally). */
  rootKey: PrivateKey
  /** The reserve P2PKH address (root address) — the prev locking script for the external unlock. */
  rootAddress: string
  fetchBeef: FetchBeef
  /** Headroom over `amountSats` a reserve coin must clear to be picked (covers the fee). Default 1000 sat. */
  feeHeadroomSats?: number
  /** Upper bound on the lock fee — a burn bug (wrong change) shows as a large fee. Default 100_000 sat. */
  maxFeeSats?: number
}
/**
 * A funded, signed, but UNBROADCAST HTLC lock the caller drives to completion (canonical-P1 noSend-lifecycle fix).
 *
 * WHY a lifecycle object, not a bare tx: the funder builds a `noSend` wallet action (the wallet reserves the reserve
 * coin + derives change, all pending). The executor must broadcast this LATER — after it secures the 2-of-2 refund
 * (crash-safety: never lock BSV you can't refund). The WALLET must own that broadcast (via `commit`), not an external
 * relay, so it advances its OWN state — the broadcast 0-conf change becomes spendable (chaining). If the swap aborts
 * before the broadcast, the reservation must be released (`abort`), or the reserve coin leaks. Returning `{lockTx}`
 * alone (the old shape) stranded both: the wallet never learned the tx was sent, and a mid-swap failure leaked the
 * reservation (review 44fd34b8 HIGH).
 */
export interface PreparedWalletLock {
  /** The fully-signed HTLC lock tx (still NOSEND — `commit()` broadcasts it). Inspect it, build the refund off it. */
  lockTx: Transaction
  lockTxid: string
  /** The reserve/change outpoint consumed. */
  fundingOutpoint: string
  /** Total change returned to the wallet (fresh, wallet-derived addresses). */
  changeSats: number
  /**
   * WALLET-owned broadcast of the pre-signed noSend lock (via `sendWith`) — the wallet sends it through its OWN
   * postBeef rail (Anvil on mainnet) and advances its state so the broadcast 0-conf change becomes spendable. Call
   * ONCE, at the executor's broadcast step, AFTER the refund is secured. FAIL-CLOSED: `acceptDelayedBroadcast:false`
   * makes the toolbox throw unless the send is `'unproven'` (accepted by the network); we re-assert + return the
   * wallet's authoritative txid. Never fabricate a txid from bytes.
   */
  commit(): Promise<string>
  /**
   * Release the wallet's noSend reservation (the reserved reserve coin + the pending change) when the swap aborts
   * BEFORE `commit`. Once commit has been attempted, this refuses without calling the wallet: the lock may be live
   * and its reservation is retained for recovery.
   */
  abort(): Promise<void>
}

export class WalletHtlcLockError extends Error {
  constructor(message: string) { super(`wallet-htlc-lock: ${message}`); this.name = 'WalletHtlcLockError' }
}

export async function buildHtlcLockViaWallet(wallet: WalletInterface, p: WalletHtlcLockParams): Promise<PreparedWalletLock> {
  if (!Number.isInteger(p.amountSats) || p.amountSats <= 0) throw new WalletHtlcLockError(`amountSats must be a positive integer, got ${p.amountSats}`)
  // review 44fd34b8 LOW: a non-finite/negative headroom would distort reserve selection; an unbounded maxFee would
  // silently weaken the burn guard. Validate both.
  if (p.feeHeadroomSats !== undefined && (!Number.isInteger(p.feeHeadroomSats) || p.feeHeadroomSats < 0)) throw new WalletHtlcLockError(`feeHeadroomSats must be a non-negative integer, got ${p.feeHeadroomSats}`)
  if (p.maxFeeSats !== undefined && (!Number.isInteger(p.maxFeeSats) || p.maxFeeSats <= 0)) throw new WalletHtlcLockError(`maxFeeSats must be a positive integer, got ${p.maxFeeSats}`)

  // Prefer wallet-derived change (continuous-op; 0-conf-chainable ONCE the prior lock is BROADCAST). The toolbox
  // will NOT auto-select UNBROADCAST (noSend) change, so on the first swap — or before the prior lock is broadcast —
  // this reports insufficient funds and we fall to the reserve bootstrap. FAIL-CLOSED: if neither source can fund,
  // fundFromReserve throws → the swap declines. NEVER a double-spend — a spent reserve coin is reserved after its
  // (noSend) action, so a concurrent/next lock can't re-select it (empirically verified).
  const internal = await tryFundInternal(wallet, p)
  return internal ?? await fundFromReserve(wallet, p, p.feeHeadroomSats ?? 1000)
}

/** WALLET-DERIVED funding: the wallet auto-selects (broadcast) `default`-basket change + signs internally; HTLC at
 *  vout 0. Returns null on INSUFFICIENT-FUNDS (no selectable change yet) so the caller falls to the reserve bootstrap;
 *  any other failure throws (fail-closed). */
async function tryFundInternal(wallet: WalletInterface, p: WalletHtlcLockParams): Promise<PreparedWalletLock | null> {
  try {
    const car = await wallet.createAction({
      description: 'fund:BSV HTLC lock (wallet change)',
      labels: [HTLC_LOCK_FUND_LABEL], // so a crash-stranded noSend lock is reconcilable by label
      outputs: [{ lockingScript: p.htlcScriptHex, satoshis: p.amountSats, outputDescription: 'BSV HTLC lock' }],
      options: { randomizeOutputs: false, signAndProcess: true, noSend: true, acceptDelayedBroadcast: false, returnTXIDOnly: false },
    })
    if (!car.tx) throw new WalletHtlcLockError(`createAction(internal) returned no signed tx (keys: ${Object.keys(car).join(',')})`)
    // Self-funded (no external input) → the abort reference IS the txid (offer-wallet self-funded precedent); pass
    // null and let finalizeLock use lockTxid.
    return await finalizeLock(wallet, Transaction.fromAtomicBEEF(car.tx), p, null, null)
  } catch (e) {
    if (e instanceof Error && /insufficient/i.test(e.message)) return null // no selectable change → fall to reserve
    throw e
  }
}

/** RESERVE funding: explicit root-key basketed P2PKH input, EXTERNAL-signed with the root key; HTLC at vout 0. */
async function fundFromReserve(wallet: WalletInterface, p: WalletHtlcLockParams, headroom: number): Promise<PreparedWalletLock> {
  const outs = await wallet.listOutputs({ basket: p.reserveBasket, limit: 1000, includeCustomInstructions: true })
  const funder = outs.outputs
    .filter((o) => o.spendable === true && o.satoshis > p.amountSats + headroom)
    .sort((a, b) => a.satoshis - b.satoshis)[0]
  if (!funder) throw new WalletHtlcLockError(`no spendable '${p.reserveBasket}' output covering ${p.amountSats} + ${headroom} sat (and no wallet change either)`)
  const [fTxid, fVoutStr] = funder.outpoint.split('.')
  const fVout = Number(fVoutStr)

  const rawBeef = await p.fetchBeef(fTxid)
  const beef = Beef.fromBinary(rawBeef)
  if (!beef.findTxid(fTxid)) throw new WalletHtlcLockError(`funding BEEF missing subject tx ${fTxid}`)

  const car = await wallet.createAction({
    description: 'fund:BSV HTLC lock (reserve)',
    labels: [HTLC_LOCK_FUND_LABEL], // reconcilable by label if a crash strands it before commit
    inputBEEF: rawBeef,
    inputs: [{ outpoint: funder.outpoint, inputDescription: 'reserve funding', unlockingScriptLength: 108 }],
    outputs: [{ lockingScript: p.htlcScriptHex, satoshis: p.amountSats, outputDescription: 'BSV HTLC lock' }],
    options: { randomizeOutputs: false, signAndProcess: false, noSend: true, acceptDelayedBroadcast: false, returnTXIDOnly: false },
  })
  if (!car.signableTransaction) throw new WalletHtlcLockError(`createAction(reserve) returned no signableTransaction (keys: ${Object.keys(car).join(',')})`)
  const { tx: signableAtomic, reference } = car.signableTransaction
  // From here on the wallet holds a pending noSend reservation keyed by `reference`; on ANY failure before we return
  // a PreparedWalletLock, abort it so the reserve coin is not leaked (mirrors offer-wallet/accept-wallet).
  try {
    const tx = Transaction.fromAtomicBEEF(signableAtomic)
    const inIdx = tx.inputs.findIndex((i) => i.sourceTXID === fTxid && i.sourceOutputIndex === fVout)
    if (inIdx < 0) throw new WalletHtlcLockError(`the reserve funding input is not in the signable tx (inputs: ${tx.inputs.length})`)

    const unlock = new P2PKH().unlock(p.rootKey, 'all', false, funder.satoshis, new P2PKH().lock(p.rootAddress))
    const unlockingScript = (await unlock.sign(tx, inIdx)).toHex()
    const signed = await wallet.signAction({ reference, spends: { [inIdx]: { unlockingScript } }, options: { noSend: true, acceptDelayedBroadcast: false, returnTXIDOnly: false } })
    if (!signed.tx) throw new WalletHtlcLockError(`signAction returned no tx (keys: ${Object.keys(signed).join(',')})`)

    // The reserve action is keyed by its signableTransaction `reference` for abort (offer-wallet SELL precedent).
    return await finalizeLock(wallet, Transaction.fromAtomicBEEF(signed.tx), p, { fTxid, fVout, funderSats: funder.satoshis, rootScriptHex: new P2PKH().lock(p.rootAddress).toHex(), rawBeef }, reference)
  } catch (e) {
    try { await wallet.abortAction({ reference }) } catch { /* best-effort — releasing a reservation we could not finalize */ }
    throw e
  }
}

interface ReserveAssert { fTxid: string; fVout: number; funderSats: number; rootScriptHex: string; rawBeef: number[] }

/** Shared FAIL-CLOSED checks (review 81257cfd MED #5): HTLC is the exact vout-0 output; scripts validate; fee is
 *  bounded; and (reserve path only) the funding coin's on-chain script+value match the basket row we external-signed.
 *  Runs on the signed-but-NOSEND tx — BEFORE any broadcast — then returns a {@link PreparedWalletLock} whose `commit`
 *  broadcasts it (wallet-owned) and `abort` releases the reservation. `abortRef` is the action's abort key (the
 *  reserve path's signableTransaction reference, or null → use the txid for the self-funded internal path). */
async function finalizeLock(wallet: WalletInterface, lockTx: Transaction, p: WalletHtlcLockParams, reserve: ReserveAssert | null, abortRef: string | null): Promise<PreparedWalletLock> {
  const out0 = lockTx.outputs[0]
  if (!out0 || out0.lockingScript.toHex() !== p.htlcScriptHex) throw new WalletHtlcLockError('HTLC is not the vout-0 output (script mismatch) — refusing')
  if (out0.satoshis !== p.amountSats) throw new WalletHtlcLockError(`HTLC output value ${out0.satoshis} ≠ amountSats ${p.amountSats} — refusing`)

  if (reserve) {
    // The external-signed reserve coin's ACTUAL on-chain script+value (from its BEEF) must match the basket row.
    if (!lockTx.inputs.some((i) => i.sourceTXID === reserve.fTxid && i.sourceOutputIndex === reserve.fVout)) throw new WalletHtlcLockError('signed tx does not spend the selected reserve outpoint — refusing')
    const fout = Transaction.fromAtomicBEEF(reserve.rawBeef).outputs[reserve.fVout]
    if (!fout) throw new WalletHtlcLockError(`funding BEEF has no output #${reserve.fVout} — refusing`)
    if (fout.satoshis !== reserve.funderSats) throw new WalletHtlcLockError(`stale/corrupt basket row: says ${reserve.funderSats} sat, chain says ${fout.satoshis} — refusing`)
    if (fout.lockingScript.toHex() !== reserve.rootScriptHex) throw new WalletHtlcLockError('funding output is not the root-key P2PKH we external-sign — refusing')
  }

  if (!(await lockTx.verify('scripts only'))) throw new WalletHtlcLockError('scripts-only verification FAILED on the signed lock — refusing')
  const totalOut = lockTx.outputs.reduce((s, o) => s + (o.satoshis ?? 0), 0)
  const totalIn = lockTx.inputs.reduce((s, i) => s + (i.sourceTransaction?.outputs[i.sourceOutputIndex]?.satoshis ?? 0), 0)
  const fee = totalIn - totalOut
  const maxFee = p.maxFeeSats ?? 100_000
  if (totalIn <= 0) throw new WalletHtlcLockError('could not determine total input value from the signed tx (missing input ancestry) — refusing')
  if (fee <= 0 || fee > maxFee) throw new WalletHtlcLockError(`lock fee ${fee} sat (in ${totalIn}, out ${totalOut}) out of bounds (0, ${maxFee}] — refusing`)

  const lockTxid = lockTx.id('hex') as string
  const changeSats = lockTx.outputs.slice(1).reduce((s, o) => s + (o.satoshis ?? 0), 0)
  const first = lockTx.inputs[0]
  const fundingOutpoint = reserve ? `${reserve.fTxid}.${reserve.fVout}` : `${first?.sourceTXID}.${first?.sourceOutputIndex}`
  const reference = abortRef ?? lockTxid // self-funded internal action aborts by txid (offer-wallet precedent)
  // This is deliberately a synchronous, one-way choice made before either wallet call can yield. A commit which
  // reaches the broadcaster while abortAction is still pending would otherwise let abort free a possibly-spent coin.
  let finalization: 'open' | 'commitStarted' | 'abortStarted' = 'open'

  const commit = async (): Promise<string> => {
    if (finalization === 'abortStarted') {
      throw new WalletHtlcLockError('commit refused: an abort was started; this lock must not be broadcast')
    }
    // Set this before the first await: a commit that throws may still have reached the broadcaster, so abort must
    // retain the reservation for attended recovery.
    finalization = 'commitStarted'
    // WALLET-owned send of the pre-signed noSend lock (via sendWith — routes through the wallet's OWN postBeef rail,
    // Anvil on mainnet, and advances state so the change becomes spendable). `acceptDelayedBroadcast:false` makes the
    // toolbox THROW (WERR_REVIEW_ACTIONS) unless the send is 'unproven'; we re-assert for defence + the exact txid.
    const res = await wallet.createAction({
      description: 'send:BSV HTLC lock',
      options: { sendWith: [lockTxid], acceptDelayedBroadcast: false, returnTXIDOnly: false },
    })
    const sw = res.sendWithResults?.find((r) => r.txid === lockTxid)
    if (!sw) throw new WalletHtlcLockError(`commit: wallet returned no sendWith result for ${lockTxid} (keys: ${Object.keys(res).join(',')})`)
    if (sw.status !== 'unproven') throw new WalletHtlcLockError(`commit: lock ${lockTxid} not sent — sendWith status '${sw.status}' (expected 'unproven')`)
    return lockTxid
  }
  const abort = async (): Promise<void> => {
    if (finalization === 'commitStarted') {
      throw new WalletHtlcLockError(
        'abort refused: a commit was attempted; the lock may be live, the reservation is kept for recovery',
      )
    }
    // Keep this state even if abortAction fails: an attempted abort and a later commit is no safer than a concurrent
    // pair. A later abort may still retry the canonical wallet action.
    finalization = 'abortStarted'
    await wallet.abortAction({ reference })
  }

  return { lockTx, lockTxid, fundingOutpoint, changeSats, commit, abort }
}

/** Config for {@link makeWalletFundHtlcLock} — everything the funder needs except the per-lock (script, amount). */
export type WalletFundHtlcLockOpts = Omit<WalletHtlcLockParams, 'htlcScriptHex' | 'amountSats'>

/** Operator-readable identity evidence for a quarantined action with toolbox's empty-txid sentinel. */
export interface TxidlessLockAttention { status: string; description: string; inputOutpoints: string[] }

export function makeWalletFundHtlcLock(
  wallet: WalletInterface,
  opts: WalletFundHtlcLockOpts,
): (p: { htlcScriptHex: string; amountSats: number }) => Promise<PreparedWalletLock> {
  return (p) => buildHtlcLockViaWallet(wallet, { ...opts, htlcScriptHex: p.htlcScriptHex, amountSats: p.amountSats })
}

/**
 * RESTART reconciliation (canonical-P1 noSend-lifecycle; review 44fd34b8 HIGH): a crash between funding a lock
 * (noSend) and `commit`ing it strands a `nosend` wallet action holding a reserved reserve coin + pending change. On
 * daemon start — BEFORE funding any new swap — chain-check every stranded HTLC-lock fund action and quarantine it.
 *
 * A PRE-SEND status is NOT proof the transaction was never broadcast: wallet-toolbox posts the BEEF before it durably
 * advances the action status. A crash in that window leaves a live transaction labelled `nosend`. Therefore every
 * `nosend`/`unsigned`/`unprocessed` action is checked through the required own-node BEEF rail first. A successful fetch
 * proves the tx is known and quarantines it; every fetch failure, including the rail's clean HTTP 404, also
 * quarantines it. An own node that has not seen a signed transaction is not authority that it was never broadcast.
 *
 * We also do NOT touch `sending` — a lock whose commit hit a transient broadcaster error at the exact
 * send moment. It MIGHT be live on-chain, so force-aborting could strand a real tx; we surface it as `needsAttention`
 * for a chain-verify follow-up instead (rare: Anvil is the agent's own low-latency node). `failed` actions already
 * released their reserve coin (the toolbox resets input spendability on the fail transition), so they need nothing.
 *
 * This function is read-only: it lists actions and reads BEEF, never calls `abortAction`. `resolvedDead` contains
 * only journal entries whose raw cancel, current lock inputs, and completed labelled wallet action all verify.
 * `aborted` and `inertUnabortable` remain empty for caller compatibility. Best-effort per action: one failed BEEF
 * read never stops the rest.
 */
export async function reconcilePendingLockFunds(
  wallet: WalletInterface,
  fetchBeef: FetchBeef,
  log?: (m: string) => void,
  opts?: { resolved?: ResolvedLock[] },
): Promise<{ aborted: string[]; needsAttention: string[]; needsAttentionEvidence: TxidlessLockAttention[]; inertUnabortable: string[]; resolvedDead: string[] }> {
  const PRE_SEND = new Set(['nosend', 'unsigned', 'unprocessed'])
  const actions = await listAllActions(wallet, {
    labels: [HTLC_LOCK_FUND_LABEL], labelQueryMode: 'any', includeLabels: false, includeInputs: true, includeOutputs: true, seekPermission: false,
  })
  const aborted: string[] = []
  const needsAttention: string[] = []
  const needsAttentionEvidence: TxidlessLockAttention[] = []
  const attend = (action: WalletAction): void => {
    needsAttention.push(action.txid)
    if (action.txid === '') needsAttentionEvidence.push({ status: action.status, description: action.description ?? '', inputOutpoints: (action.inputs ?? []).map((input) => input.sourceOutpoint).sort() })
  }
  const inertUnabortable: string[] = []
  const resolvedDead: string[] = []
  for (const a of actions) {
    if (isInertLockDraft(a)) {
      log?.('inert never-funded lock draft ignored: no inputs, no outputs')
      continue
    }
    const entry = opts?.resolved?.find((x) => x.lockTxid === a.txid)
    if (entry) {
      const resolved = await isResolvedLock(wallet, a, entry)
      if (resolved.ok) {
        resolvedDead.push(a.txid)
        log?.(`reconcile: lock ${a.txid} was killed by confirmed cancel ${entry.cancelTxid}`)
        continue
      }
      log?.(`reconcile: resolved-lock entry for ${a.txid} failed check: ${resolved.failed}; keeping it quarantined`)
    }
    if (a.status === 'sending') {
      attend(a)
      log?.(`reconcile: lock ${a.txid} is 'sending' (transient broadcaster error at commit) — NOT aborting; verify on-chain before reuse`)
      continue
    }
    if (!PRE_SEND.has(a.status)) continue // leave sent/completed/failed actions untouched
    if (a.txid === '') {
      // A never-signed action has no transaction to ask the chain about; retain its reservation for attended recovery.
      attend(a)
      log?.(`reconcile: lock status '${a.status}' description '${a.description || '(none)'}' is unsigned (no txid) — keeping it quarantined`)
      continue
    }
    try {
      await fetchBeef(a.txid)
      attend(a)
      log?.(`reconcile: lock ${a.txid} is pre-send-status but LIVE on-chain — NOT aborting; verify/burial before reuse`)
      continue
    } catch (e) {
      attend(a)
      if (e instanceof Error && e.message === `anvil GET /tx/${a.txid}/beef → HTTP 404`) {
        log?.(
          `reconcile: lock ${a.txid} own-node 404 is not proof of absence — coin stays reserved; attended reclaim resolves it`,
        )
      } else {
        log?.(`reconcile: lock ${a.txid} pre-send chain check was ambiguous (${e instanceof Error ? e.message : String(e)}) — NOT aborting; verify/burial before reuse`)
      }
    }
  }
  return { aborted, needsAttention, needsAttentionEvidence, inertUnabortable, resolvedDead }
}
/**
 * Each quarantined HTLC-lock action with the input outpoint(s) it reserved — for the reclaim tool to PROVE
 * its consolidation sweep spends every stranded lock's input (else it cannot claim the lock dead; review ce85e31c
 * HIGH). Uses the BRC-100 `listActions({ includeInputs })` `sourceOutpoint`; a lock that exposes no inputs is
 * returned with an empty array so the caller fails closed.
 */
export async function strandedLockInputs(
  wallet: WalletInterface,
  opts?: { resolved?: ResolvedLock[]; verifiedResolved?: Set<string> },
): Promise<{ txid: string; inputOutpoints: string[] }[]> {
  const actions = await listAllActions(wallet, {
    labels: [HTLC_LOCK_FUND_LABEL], labelQueryMode: 'any', includeLabels: false, includeInputs: true, includeOutputs: true,
    seekPermission: false,
  })
  const out: { txid: string; inputOutpoints: string[] }[] = []
  // Keep the completed-cancel evidence query bounded to one list per call.  The evidence decision itself remains in
  // isResolvedLock: an invalid journal row deliberately continues to quarantine the lock.
  const hasQuarantinedResolvedEntry = actions.some((a) => QUARANTINED_LOCK_STATUSES.has(a.status) && opts?.resolved?.some((x) => x.lockTxid === a.txid))
  const cancelActions = hasQuarantinedResolvedEntry
    ? await listAllActions(wallet, { labels: [CANCEL_LABEL], labelQueryMode: 'any', includeLabels: false, seekPermission: false })
    : undefined
  for (const a of actions) {
    if (!QUARANTINED_LOCK_STATUSES.has(a.status)) continue
    if (isInertLockDraft(a)) continue
    const entry = opts?.resolved?.find((x) => x.lockTxid === a.txid)
    if (entry && (await isResolvedLock(wallet, a, entry, cancelActions)).ok) {
      opts?.verifiedResolved?.add(a.txid)
      continue
    }
    const inputOutpoints = (a.inputs ?? []).map((i) => i.sourceOutpoint)
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
    out.push({ txid: a.txid, inputOutpoints })
  }
  return out
}

export function serializeFundHtlcLock<A, R>(fund: (p: A) => Promise<R>): (p: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve()
  return (p: A): Promise<R> => {
    const run = tail.then(() => fund(p)) // runs only after the previous funding settles (chained)
    tail = run.then(() => undefined, () => undefined) // swallow so one failure never wedges the queue
    return run
  }
}
