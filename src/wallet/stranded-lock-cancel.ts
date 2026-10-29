/** Attended cancel-spend support. This module never calls abortAction or writes wallet storage directly. */
import { existsSync, readFileSync } from 'node:fs'
import { Beef, P2PKH, PrivateKey, Transaction, type ChainTracker, type KeyDeriverApi, type WalletAction, type WalletInterface } from '@bsv/sdk'
import { ScriptTemplateBRC29, brc29ProtocolID } from '@bsv/wallet-toolbox/out/src/utility/ScriptTemplateBRC29'
import type { WalletStorageManager } from '@bsv/wallet-toolbox/out/src/storage/WalletStorageManager'
import { buildConsolidationSweep, DEFAULT_SWEEP_MAX_FEE_SATS, type BuiltSweep, type SweepInput } from './consolidation-sweep'
import { writeAtomicJson } from './recovery-journal'
import { internalizeReserveUtxo } from './reserve-basket-sweep'
import { listAllActions } from './list-all-actions'
import type { WocOutpointSpentReader } from './woc-outpoint-spent'

export const CANCEL_LABEL = 'petasats-lock-cancel'
const LOCK_LABELS = new Set(['petasats-htlc-lock-fund', 'gate-satoshi-test'])
const OPEN = new Set(['sending', 'nosend', 'unsigned', 'unprocessed'])

export class StrandedLockCancelError extends Error {
  constructor(message: string) { super(`stranded-lock-cancel: ${message}`); this.name = 'StrandedLockCancelError' }
}

export interface ResolvedLock {
  lockTxid: string
  cancelTxid: string
  cancelRawHex: string
  inputOutpoints: string[]
  height: number
  resolvedAt: string
}

export interface CancelJournal {
  version: 1
  lockTxid: string
  lockStatus: string
  inputOutpoints: string[]
  cancelTxid: string
  cancelRawHex: string
  reserveAddress: string
  createdAt: string
  attempts: Array<{ at: string; outcome: 'relayed' | 'conflict' | 'ambiguous'; detail?: string }>
}

export interface CancelWalletDeps {
  wallet: WalletInterface
  storage: WalletStorageManager
  keyDeriver: KeyDeriverApi
  getClientChangeKeyPair(): { privateKey: string; publicKey: string }
  rootKey: PrivateKey
  reserveAddress: string
  fetchBeef(txid: string): Promise<number[]>
  outpointSpentReader: WocOutpointSpentReader
  reserveBasket: string
}

export interface CancelPlan {
  lock: WalletAction
  inputs: SweepInput[]
  signerClasses: string[]
  built: BuiltSweep
}

function outpointParts(outpoint: string): { txid: string; vout: number } {
  const [txid, voutText, extra] = outpoint.split('.')
  const vout = Number(voutText)
  if (!/^[0-9a-fA-F]{64}$/.test(txid ?? '') || extra !== undefined || !Number.isSafeInteger(vout) || vout < 0) {
    throw new StrandedLockCancelError(`invalid source outpoint '${outpoint}'`)
  }
  return { txid, vout }
}

export function requireQuarantinedLock(action: WalletAction): void {
  if (!action.labels?.some((label) => LOCK_LABELS.has(label))) throw new StrandedLockCancelError('action is not an HTLC lock fund action')
  if (!OPEN.has(action.status)) throw new StrandedLockCancelError(`lock is no longer quarantined (status ${action.status}); the journaled cancel will NOT be broadcast`)
  if (!action.inputs?.length) throw new StrandedLockCancelError('lock has no inputs')
  for (const [i, input] of action.inputs.entries()) {
    if (!input.sourceOutpoint || !input.sourceSatoshis || !input.sourceLockingScript) {
      throw new StrandedLockCancelError(`input ${i} lacks source outpoint, satoshis, or locking script`)
    }
  }
}

async function storageOutput(deps: CancelWalletDeps, txid: string, vout: number): Promise<{ derivationPrefix?: string; derivationSuffix?: string; senderIdentityKey?: string } | undefined> {
  const rows = await deps.storage.runAsStorageProvider((sp) => sp.findOutputs({ partial: { txid, vout } }))
  if (rows.length !== 1) return undefined
  return rows[0]
}

/** Plan and sign a full cancel only after every input has a provably matching signer. */
export async function planCancel(lock: WalletAction, deps: CancelWalletDeps): Promise<CancelPlan> {
  requireQuarantinedLock(lock)
  const reserveLock = new P2PKH().lock(deps.reserveAddress).toHex()
  const keys = deps.getClientChangeKeyPair()
  const inputs: SweepInput[] = []
  const signerClasses: string[] = []
  for (const input of lock.inputs!) {
    const { txid, vout } = outpointParts(input.sourceOutpoint)
    const sourceScript = input.sourceLockingScript!
    const beef = Beef.fromBinary(await deps.fetchBeef(txid))
    if (!beef.bumps?.length) throw new StrandedLockCancelError(`${input.sourceOutpoint}: source BEEF has no merkle path`)
    // Keep the BEEF's merkle path on the source transaction.  The sweep's scripts-only verifier
    // needs that terminal proof rather than an unanchored `findTxid(...).tx` shell.
    const sourceTx = beef.findAtomicTransaction(txid)
    if (!sourceTx) throw new StrandedLockCancelError(`${input.sourceOutpoint}: source BEEF lacks transaction`)
    const sourceOutput = sourceTx.outputs[vout]
    if (!sourceOutput || sourceOutput.satoshis !== input.sourceSatoshis || sourceOutput.lockingScript.toHex() !== sourceScript) {
      throw new StrandedLockCancelError(`${input.sourceOutpoint}: source BEEF does not match the wallet input metadata`)
    }
    if (sourceScript === reserveLock) {
      inputs.push({ txid, vout, satoshis: input.sourceSatoshis, sourceTx })
      signerClasses.push('root P2PKH (byte match)')
      continue
    }
    const row = await storageOutput(deps, txid, vout)
    if (!row?.derivationPrefix || !row.derivationSuffix) throw new StrandedLockCancelError(`${input.sourceOutpoint}: no BRC-29 derivation data in wallet storage`)
    const lockerPubKey = row.senderIdentityKey || keys.publicKey
    const keyID = `${row.derivationPrefix} ${row.derivationSuffix}`
    // ScriptTemplateBRC29.unlock derives its signing key with derivePrivateKey.  This is deliberately
    // not derivePublicKey: for received payments the locker is the counterparty, so the two derivations
    // have different semantics.  Compare the exact P2PKH script before constructing any unlock.
    const signingKey = deps.keyDeriver.derivePrivateKey(brc29ProtocolID, keyID, lockerPubKey)
    const derivedLock = new P2PKH().lock(signingKey.toPublicKey().toAddress()).toHex()
    if (derivedLock !== sourceScript) throw new StrandedLockCancelError(`${input.sourceOutpoint}: BRC-29 derived P2PKH script does not byte-match source`)
    const template = new ScriptTemplateBRC29({ derivationPrefix: row.derivationPrefix, derivationSuffix: row.derivationSuffix, keyDeriver: deps.keyDeriver })
    inputs.push({ txid, vout, satoshis: input.sourceSatoshis, sourceTx, unlock: template.unlock(keys.privateKey, lockerPubKey, input.sourceSatoshis, sourceOutput.lockingScript) })
    signerClasses.push('BRC-29 derived P2PKH (byte match)')
  }
  const built = await buildConsolidationSweep(inputs, deps.rootKey, deps.reserveAddress)
  return { lock, inputs, signerClasses, built }
}

export function resolvedLocksPathFor(walletDbPath: string): string { return `${walletDbPath}.resolved-locks.json` }

function validResolvedLock(value: unknown): value is ResolvedLock {
  const x = value as Partial<ResolvedLock>
  return !!x && typeof x.lockTxid === 'string' && /^[0-9a-f]{64}$/i.test(x.lockTxid)
    && typeof x.cancelTxid === 'string' && /^[0-9a-f]{64}$/i.test(x.cancelTxid)
    && typeof x.cancelRawHex === 'string' && /^[0-9a-f]*$/i.test(x.cancelRawHex) && Array.isArray(x.inputOutpoints)
    && x.inputOutpoints.every((o) => typeof o === 'string') && typeof x.height === 'number' && Number.isSafeInteger(x.height) && x.height > 0 && typeof x.resolvedAt === 'string'
}

export function loadResolvedLocks(path: string): ResolvedLock[] {
  if (!existsSync(path)) return []
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { throw new StrandedLockCancelError(`cannot read resolved-locks file: ${e instanceof Error ? e.message : String(e)}`) }
  if (!Array.isArray(parsed) || !parsed.every(validResolvedLock)) throw new StrandedLockCancelError('resolved-locks file has an invalid entry')
  return parsed
}

export function readCancelJournal(path: string): CancelJournal | undefined {
  if (!existsSync(path)) return undefined
  try {
    const x = JSON.parse(readFileSync(path, 'utf8')) as CancelJournal
    if (x.version !== 1 || !/^[0-9a-f]{64}$/i.test(x.lockTxid) || !/^[0-9a-f]{64}$/i.test(x.cancelTxid)
      || !/^[0-9a-f]+$/i.test(x.cancelRawHex) || !Array.isArray(x.inputOutpoints) || !Array.isArray(x.attempts)) throw new Error('invalid shape')
    return x
  } catch (e) { throw new StrandedLockCancelError(`invalid cancel journal: ${e instanceof Error ? e.message : String(e)}`) }
}

export function writeCancelJournal(path: string, journal: CancelJournal): void { writeAtomicJson(path, journal) }

export function journalForPlan(plan: CancelPlan, reserveAddress: string): CancelJournal {
  return { version: 1, lockTxid: plan.lock.txid, lockStatus: plan.lock.status, inputOutpoints: plan.inputs.map((i) => `${i.txid}.${i.vout}`), cancelTxid: plan.built.txid, cancelRawHex: plan.built.tx.toHex(), reserveAddress, createdAt: new Date().toISOString(), attempts: [] }
}

export function assertJournalMatchesLock(journal: CancelJournal, lock: WalletAction): void {
  const actual = (lock.inputs ?? []).map((i) => i.sourceOutpoint).sort()
  if (journal.lockTxid !== lock.txid || JSON.stringify([...journal.inputOutpoints].sort()) !== JSON.stringify(actual)) {
    throw new StrandedLockCancelError('journal belongs to another lock or a different lock input set')
  }
}

function sameUniqueOutpoints(actual: string[], expected: string[], label: string): void {
  const normalizedActual = actual.map((outpoint) => outpoint.toLowerCase())
  const normalizedExpected = expected.map((outpoint) => outpoint.toLowerCase())
  if (new Set(normalizedActual).size !== normalizedActual.length || new Set(normalizedExpected).size !== normalizedExpected.length
    || normalizedActual.length !== normalizedExpected.length || normalizedActual.some((outpoint) => !normalizedExpected.includes(outpoint))) {
    throw new StrandedLockCancelError(`${label} do not equal the current lock input set`)
  }
}

/** Bind immutable cancel bytes to its journal, the current quarantined lock, and the current reserve key. */
export function validateJournaledCancel(journal: CancelJournal, lock: WalletAction, reserveAddress: string): CancelPlan {
  requireQuarantinedLock(lock)
  if (journal.lockTxid !== lock.txid) throw new StrandedLockCancelError('journal belongs to another lock')
  if (journal.reserveAddress !== reserveAddress) throw new StrandedLockCancelError('journal reserve address does not match the current key-derived address')
  let tx: Transaction
  try { tx = Transaction.fromHex(journal.cancelRawHex) } catch { throw new StrandedLockCancelError('journal cancel raw hex is invalid') }
  if (tx.id('hex') !== journal.cancelTxid) throw new StrandedLockCancelError('journal cancel txid does not match raw hex')
  const lockInputs = lock.inputs!.map((input) => input.sourceOutpoint!)
  const txInputs = tx.inputs.map((input) => `${input.sourceTXID}.${input.sourceOutputIndex}`)
  sameUniqueOutpoints(journal.inputOutpoints, lockInputs, 'journal input outpoints')
  sameUniqueOutpoints(txInputs, journal.inputOutpoints, 'raw cancel input outpoints')
  if (tx.outputs.length !== 1) throw new StrandedLockCancelError('journal cancel must have exactly one output')
  if (tx.outputs[0].lockingScript.toHex() !== new P2PKH().lock(journal.reserveAddress).toHex()) {
    throw new StrandedLockCancelError('journal cancel output is not P2PKH(journal reserve address)')
  }
  const totalIn = lock.inputs!.reduce((total, input) => total + input.sourceSatoshis!, 0)
  const outSats = tx.outputs[0].satoshis ?? 0
  const fee = totalIn - outSats
  if (fee <= 0 || fee > DEFAULT_SWEEP_MAX_FEE_SATS) throw new StrandedLockCancelError(`journal cancel fee ${fee} sat is out of bounds (0, ${DEFAULT_SWEEP_MAX_FEE_SATS}]`)
  return { lock, inputs: [], signerClasses: [], built: { tx, txid: journal.cancelTxid, totalIn, outSats, fee } }
}

/** The sole own-node absence verdict that permits the attended cancel to proceed. */
export function isExactOwnNode404(error: unknown, txid: string): boolean {
  return error instanceof Error && error.message === `anvil GET /tx/${txid}/beef → HTTP 404`
}

/** A successful own-node lookup means the original lock may be live; every other failure is a liveness stop. */
export async function requireOwnNodeLockAbsent(fetchBeef: (txid: string) => Promise<number[]>, lockTxid: string): Promise<void> {
  try {
    await fetchBeef(lockTxid)
  } catch (error) {
    if (isExactOwnNode404(error, lockTxid)) return
    throw new StrandedLockCancelError('STOP: own-node check failed; re-run later')
  }
  throw new StrandedLockCancelError('STOP: lock is known on-chain; swap recovery owns it')
}

export interface CancelStatus { status: string; blockHeight?: number }

/** Only UNKNOWN authorizes a relay attempt.  Seen/accepted/mined bytes always resume confirmation instead. */
export function cancelNeedsBroadcast(status: CancelStatus): boolean { return status.status === 'UNKNOWN' }

/** A relay verdict loses authority to the cancel's own status once that status is seen or mined. */
export function classifyCancelBroadcastFailure(status: CancelStatus, fatal: boolean): 'wait' | 'fatal' | 'ambiguous' {
  if (!cancelNeedsBroadcast(status)) return 'wait'
  return fatal ? 'fatal' : 'ambiguous'
}

/** Verify the cancel's own BEEF path against the corroborated header quorum, then require two confirmations. */
export async function verifyCancelConfirmation(
  cancelTxid: string,
  rawBeef: number[],
  height: number,
  chainTracker: ChainTracker,
  readBsvHeight: () => Promise<number> = () => chainTracker.currentHeight(),
): Promise<'ready' | 'waiting'> {
  const beef = Beef.fromBinary(rawBeef)
  if (!beef.findTxid(cancelTxid) || !beef.bumps?.length) {
    throw new StrandedLockCancelError('STOP: confirmed cancel lacks its own-node AtomicBEEF merkle path')
  }
  const path = beef.findBump(cancelTxid)
  if (!path || path.blockHeight !== height) throw new StrandedLockCancelError('STOP: confirmed cancel BEEF path height does not match own-node status')
  let proven = false
  try { proven = await chainTracker.isValidRootForHeight(path.computeRoot(cancelTxid), height) } catch { /* fail closed below */ }
  if (!proven) throw new StrandedLockCancelError('STOP: confirmed cancel merkle root is not corroborated by the quorum')
  const tip = await readBsvHeight()
  return tip >= height + 1 ? 'ready' : 'waiting'
}

export interface WaitForCancelDeps {
  getTxStatus(txid: string): Promise<CancelStatus>
  fetchBeef(txid: string): Promise<number[]>
  chainTracker: ChainTracker
  /** Finality tip semantics: a cancel needs two sources at or past its burial depth. */
  readBsvHeight?: () => Promise<number>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
}

/** Wait with a bounded, resumable deadline.  No wallet operation is possible through this dependency surface. */
export async function waitForConfirmedCancel(
  lockTxid: string,
  cancelTxid: string,
  waitMs: number,
  deps: WaitForCancelDeps,
): Promise<number | undefined> {
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new StrandedLockCancelError('CANCEL_WAIT_MS must be a non-negative finite duration')
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = deps.pollMs ?? 5_000
  const start = now()
  for (;;) {
    if ((await deps.getTxStatus(lockTxid)).status === 'MINED') throw new StrandedLockCancelError('STOP: lock is live; swap recovery owns it')
    const cancel = await deps.getTxStatus(cancelTxid)
    if (cancel.status === 'MINED') {
      if ((await deps.getTxStatus(lockTxid)).status === 'MINED') throw new StrandedLockCancelError('STOP: lock is live; swap recovery owns it')
      if (!Number.isSafeInteger(cancel.blockHeight) || cancel.blockHeight! < 1) throw new StrandedLockCancelError('STOP: cancel is mined but its height is unavailable')
      if (await verifyCancelConfirmation(cancelTxid, await deps.fetchBeef(cancelTxid), cancel.blockHeight!, deps.chainTracker, deps.readBsvHeight) === 'ready') return cancel.blockHeight
    }
    if (now() - start >= waitMs) return undefined
    await sleep(Math.min(pollMs, Math.max(0, waitMs - (now() - start))))
  }
}

/** Complete the post-confirmation wallet operations in the required conservative order. */
export async function resolveConfirmedCancel(plan: CancelPlan, journal: CancelJournal, deps: CancelWalletDeps, height: number, resolvedPath: string): Promise<void> {
  for (const output of plan.lock.outputs ?? []) {
    if (!output.basket) continue
    try { await deps.wallet.relinquishOutput({ basket: output.basket, output: `${plan.lock.txid}.${output.outputIndex}` }) }
    catch (e) { if (!/not found|no output|not in/i.test(e instanceof Error ? e.message : String(e))) throw e }
  }
  await internalizeReserveUtxo({ wallet: deps.wallet, fetchBeef: deps.fetchBeef, outpointSpentReader: deps.outpointSpentReader, reserveAddress: deps.reserveAddress, basket: deps.reserveBasket, labels: [CANCEL_LABEL], description: 'stranded HTLC-lock cancel spend' }, { txid: journal.cancelTxid, vout: 0, value: plan.built.outSats })
  const all = loadResolvedLocks(resolvedPath)
  if (!all.some((x) => x.lockTxid === journal.lockTxid && x.cancelTxid === journal.cancelTxid)) {
    all.push({ lockTxid: journal.lockTxid, cancelTxid: journal.cancelTxid, cancelRawHex: journal.cancelRawHex, inputOutpoints: journal.inputOutpoints, height, resolvedAt: new Date().toISOString() })
    writeAtomicJson(resolvedPath, all)
  }
}

/** Validate a resolved record against current wallet state; invalid entries deliberately remain quarantined. */
export async function isResolvedLock(
  wallet: WalletInterface,
  lock: WalletAction,
  entry: ResolvedLock,
  /** Callers listing several locks can supply this once-listed label set. */
  cancelActions?: WalletAction[],
): Promise<{ ok: boolean; failed?: string }> {
  let cancel: Transaction
  try { cancel = Transaction.fromHex(entry.cancelRawHex) } catch { return { ok: false, failed: 'cancel raw hex is invalid' } }
  if (cancel.id('hex') !== entry.cancelTxid) return { ok: false, failed: 'cancel txid does not match raw hex' }
  const current = (lock.inputs ?? []).map((i) => i.sourceOutpoint).filter((outpoint): outpoint is string => !!outpoint)
  const spent = cancel.inputs.map((input) => `${input.sourceTXID}.${input.sourceOutputIndex}`)
  try { sameUniqueOutpoints(spent, current, 'cancel input outpoints') } catch { return { ok: false, failed: 'cancel does not spend every current lock input exactly once' } }
  if (cancel.outputs.length !== 1) return { ok: false, failed: 'cancel does not have exactly one output' }
  const actions = cancelActions ?? await listAllActions(wallet, { labels: [CANCEL_LABEL], labelQueryMode: 'any', includeLabels: false, seekPermission: false })
  if (!actions.some((a) => a.txid === entry.cancelTxid && a.status === 'completed')) return { ok: false, failed: 'wallet does not list a completed cancel action' }
  return { ok: true }
}
