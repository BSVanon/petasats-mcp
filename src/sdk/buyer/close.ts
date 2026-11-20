import { isAddress } from 'viem'
import { assertBuyerMainnetP2pkhAddress } from './runtime/address'
import type { BuyerHome } from './local-state'
import { GAS_TOPUP_WAIT_MESSAGE, loadGasTopUp } from './gas-topup-state'
import { gasOrderWait, gasWaitStep } from './close-gas'
import { readSpendingStop, stopSpending } from './stop'
import type { BuyerKit, BuyerSwapRecord, BuyerSweepPlan, BuyerWithdrawalReconcileOutcome } from './types'
import {
  archiveCloseRecord, isRecordError, isSweepShape, kitWithdrawals, markRecordError, pinUnused, readCloseRecord, sendsOnDisk, withBaseSends, withBsvSweep,
  withBsvSweepSent, withSend, writeCloseRecord, type CloseFinal, type CloseRecord, type CloseSend,
} from './close-record'

export type { CloseSend } from './close-record'
export const CLOSED_STOP_REASON = 'closed by close_kit'
/**
 * BSV below this many sats may be left behind as dust. A sweep refuses an output at or below 546 sats; with the sweep's
 * fee (about 74 sats per coin at the kit's fee rate), up to five coins that small still total less than this.
 */
export const CLOSE_BSV_DUST_LIMIT_SATS = 1_000n

export interface CloseKitRequest { baseAddress: string; bsvAddress: string }
export type CloseKitStep =
  | { state: 'refused'; reason: string; retry_after_seconds?: number; sent: CloseSend[] }
  | { state: 'in_progress'; did: string; next: string; call_again_after_seconds: number; sent: CloseSend[] }
  | { state: 'closed'; closed_at: string; sent: CloseSend[]; final: CloseFinal; keys_note: string }

const ZERO_BASE_ADDRESS = /^0x0{40}$/i
// sweep.ts throws this exact wording (with a dynamic sat amount) when the swept output would be dust; buyer-kit.ts's
// ETH-all withdrawal throws the fixed message below when only gas dust remains. Both are kit-method throws (rule h)
// that close.ts treats as "leave it behind" rather than a refusal.
const BSV_DUST_ERROR = /is at or below dust/
const ETH_GAS_DUST_ERROR = 'the ETH balance does not cover the Base gas for a withdrawal; nothing was sent'
// Kit refusals that only the user can clear (a destination, the limits file, a stop, a missing feature, no gas, a kit
// record or coin that is not valid, a send that reverted on chain): they carry no retry_after. Any other throw (an RPC
// or indexer error, a coin whose proof is not out yet, a balance read that lags a send) is brief, and the refusal says
// to try again after 60 seconds.
const NEEDS_THE_USER = [
  /^refused by your limits file:/, /^spending is stopped/, /^to must be a non-zero checksummed Base address$/, /^cannot withdraw to /,
  / is not configured$/, /^ETH is needed for Base gas$/, /must be a mainnet Base58Check P2PKH BSV address$/,
  /^invalid Base withdrawal record$/, /^invalid buyer swap quote field /, /^unsafe (?:local file|permissions on) /,
  /^buyer sweep: source output is not a kit P2PKH coin/, /^Base (?:USDC|ETH) transfer reverted$/,
  // m3: a cancelled-withdrawal state only the user can clear (withdrawal-intent.ts:153,154,156). "being cancelled"
  // (:150) is deliberately not matched here: it clears with time, so it stays in_progress.
  /^the account cannot pay the gas to cancel /, /could not be cancelled after \d+ attempts/, /^this kit runtime cannot cancel /,
]
// A filesystem failure that only the user can fix: no permission, a read-only disk, a full disk or quota, or a path of
// the wrong kind (the archive rename onto a folder, say).
const NEEDS_THE_USER_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EISDIR', 'ENOTDIR'])

function keysNote(paths: BuyerHome, final: CloseFinal): string {
  const keep = `Keep ${paths.keysPath} if anything might still be sent to these addresses: it is the only way to recover it. Deleting the folder is your choice. To use the kit again, run npx petasats-mcp resume.`
  const left = [
    ...(final.usdc === '0' ? [] : [`${final.usdc} atomic units of USDC`]),
    ...(final.bsv_sats === '0' ? [] : [`${final.bsv_sats} sats of BSV`]),
    ...(final.eth_wei === '0' ? [] : [`${final.eth_wei} wei of ETH`]),
  ]
  if (!left.length) return `The kit is closed and empty. ${keep}`
  const several = left.length > 1
  return `The kit is closed. It still holds ${left.join(' and ')}, too little to pay ${several ? 'their' : 'its'} own network fee, so ${several ? 'they stay' : 'it stays'} in the kit. ${keep}`
}

/** Delivered/refunded/failed are always done; a settled swap is done only once nothing is still sweeping to it. */
function swapFinished(record: { stage: string; deliverTo?: string }): boolean {
  return record.stage === 'delivered' || record.stage === 'refunded' || record.stage === 'failed' || (record.stage === 'settled' && !record.deliverTo)
}

function refusedStep(reason: string, sent: CloseSend[], retryAfterSeconds?: number): CloseKitStep {
  return { state: 'refused', reason, sent, ...(retryAfterSeconds === undefined ? {} : { retry_after_seconds: retryAfterSeconds }) }
}

/**
 * The NEEDS_THE_USER patterns, the filesystem codes, the record mark, and a direct needsOperator mark (set where an
 * error is made, for a state only `npx petasats-mcp withdrawal <hash> sent|not-sent` can clear, e.g. the consumed-
 * nonce warning): true when only the user can clear it. Shared by failedStep and the reconciliation catch in step e.
 */
function needsTheUser(error: unknown): boolean {
  const reason = error instanceof Error ? error.message : String(error)
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  const operator = typeof error === 'object' && error !== null ? (error as { needsOperator?: unknown }).needsOperator : undefined
  return NEEDS_THE_USER.some((pattern) => pattern.test(reason)) || (typeof code === 'string' && NEEDS_THE_USER_CODES.has(code)) || isRecordError(error) || operator === true
}

/** Rule h: a kit-method throw refuses with its message; a brief failure says when to try again. */
function failedStep(error: unknown, sent: CloseSend[]): CloseKitStep {
  const reason = error instanceof Error ? error.message : String(error)
  return refusedStep(reason, sent, needsTheUser(error) ? undefined : 60)
}

function unconfirmedStep(sats: bigint, sent: CloseSend[]): CloseKitStep {
  return { state: 'in_progress', did: `nothing sent; ${sats} sats of BSV are not confirmed yet; they will be sent after they confirm`, next: 'wait for a BSV confirmation, then call again', call_again_after_seconds: 60, sent }
}

/** A withdrawBase throw that already left an unresolved intent is progress, not a refusal (rule h's exception). */
function pendingAfterThrow(paths: BuyerHome, error: unknown, sent: CloseSend[]): CloseKitStep | undefined {
  if (!kitWithdrawals(paths).some((w) => w.state !== 'done')) return undefined
  const message = error instanceof Error ? error.message : String(error)
  return { state: 'in_progress', did: `the Base send is recorded but not confirmed: ${message}`, next: 'call again; the kit confirms or re-sends it', call_again_after_seconds: 60, sent }
}

/** The plan the kit hands beforeBroadcast; anything else stops the broadcast, since it could not be recorded first. */
function assertSweepPlan(sweep: BuyerSweepPlan): void {
  if (!isSweepShape(sweep?.txid, sweep?.sats, sweep?.inputs)) throw new Error('the BSV send could not be recorded before its broadcast; nothing was sent')
}

/** walletInfo with unconfirmed BSV reported. It is required: a custom kit that leaves it out is refused, with no retry. */
async function readWalletInfo(kit: BuyerKit): Promise<Awaited<ReturnType<BuyerKit['walletInfo']>>> {
  const info = await kit.walletInfo()
  if (typeof info?.unconfirmedBsvSats !== 'bigint') throw new Error('unconfirmed BSV reporting is not configured')
  return info
}

/** The kit's swap records, read from its own files: an error that is not a filesystem error is a record no retry clears. */
async function kitSwaps(kit: BuyerKit): Promise<BuyerSwapRecord[]> {
  try { return await kit.status() } catch (error) { throw markRecordError(error) }
}

let closeOperation: Promise<void> = Promise.resolve()
/** Module-level, like buyer-kit's serializeMoney: one close step runs to completion before the next one starts. */
async function serializeClose<T>(operation: () => Promise<T>): Promise<T> {
  const previous = closeOperation
  let release!: () => void
  closeOperation = new Promise<void>((resolve) => { release = resolve })
  await previous
  try { return await operation() } finally { release() }
}

async function runClose(deps: { kit: BuyerKit; paths: BuyerHome; now?: () => number }, request: CloseKitRequest): Promise<CloseKitStep> {
  const { kit, paths } = deps
  const now = deps.now ?? Date.now
  // Both capabilities close_kit relies on are required. Only a custom kit given to the SDK can lack one; it is refused
  // here, before anything is pinned or sent (a missing unconfirmed BSV report is refused at the first walletInfo read).
  if (typeof kit.assertWithdrawDestinations !== 'function') return refusedStep('close_kit destination checks are not configured', sendsOnDisk(paths))

  // a. Validate. Any failure refuses before anything is pinned or sent; the report still lists the sends so far.
  const info = await readWalletInfo(kit)
  if (!isAddress(request.baseAddress, { strict: true }) || ZERO_BASE_ADDRESS.test(request.baseAddress)) {
    return refusedStep('base_address must be a non-zero checksummed Base address', sendsOnDisk(paths))
  }
  if (request.baseAddress.toLowerCase() === info.baseAddress.toLowerCase()) return refusedStep("base_address must not be this kit's own Base address", sendsOnDisk(paths))
  try { assertBuyerMainnetP2pkhAddress(request.bsvAddress, 'bsv_address') } catch (error) { return refusedStep(error instanceof Error ? error.message : String(error), sendsOnDisk(paths)) }
  if (request.bsvAddress === info.bsvAddress) return refusedStep("bsv_address must not be this kit's own BSV address", sendsOnDisk(paths))
  // The kit's own destination rules (its allowlists, the swap contract, the USDC token): a pair the kit would refuse
  // at its first send is never pinned.
  try {
    await kit.assertWithdrawDestinations({ base: request.baseAddress, bsv: request.bsvAddress })
  } catch (error) {
    return refusedStep(error instanceof Error ? error.message : String(error), sendsOnDisk(paths))
  }

  const stop = readSpendingStop(paths)

  // b. Close record: one close-down goes to one pair of addresses.
  let record: CloseRecord | undefined
  try {
    record = readCloseRecord(paths)
  } catch (error) {
    // Anything but ENOENT. The record holds the pin and the sends, so the user inspects it rather than discarding it.
    const message = error instanceof Error ? error.message : String(error)
    return refusedStep(`close.json in ${paths.home} cannot be read (${message}). Nothing was sent. Inspect close.json: it holds this close-down's two addresses and its sends so far. Repair it, then call close_kit again.`, [])
  }
  if (record?.closedAt !== undefined && !stop) {
    // The user resumed after this close-down finished: archive it so a new close-down may use a new pair.
    archiveCloseRecord(paths, record.closedAt)
    record = undefined
  }
  if (record && (record.baseAddress.toLowerCase() !== request.baseAddress.toLowerCase() || record.bsvAddress !== request.bsvAddress)) {
    if (!pinUnused(paths, record)) {
      return refusedStep(`this kit's close-down goes to base ${record.baseAddress} and BSV ${record.bsvAddress} and can only finish to that pair; call close_kit again with those two addresses`, record.sends)
    }
    record = undefined // nothing used the old pin, so the new pair is pinned at its first send
  }

  // Shared by e (reconciling an existing withdrawal) and f (new sends): create/pin close.json if absent, and
  // append a send to it once a call returns.
  const newRecord = (): CloseRecord => ({ baseAddress: request.baseAddress, bsvAddress: request.bsvAddress, startedAt: now(), sends: [] })
  const pin = (): CloseRecord => {
    if (!record) {
      record = newRecord()
      writeCloseRecord(paths, record)
    }
    return record
  }
  const appendSend = (send: CloseSend): CloseSend[] => {
    record = withSend(record ?? newRecord(), send)
    writeCloseRecord(paths, record)
    return record.sends
  }

  // c. Stop. Once final is written, any STOP means closed: the close_kit one, or the user's own stop that landed while
  // g ran. closedAt is filled in from the STOP first, even when funds arrived since, so after a resume the archive
  // rule in b applies. The re-check uses g's dust limits: BSV below the limit, ETH no more than was left behind.
  if (stop && record?.final) {
    const { final, sends } = record
    const gasWait = await gasOrderWait(kit, paths, info.baseAddress, sends); if (gasWait) return gasWait // before closedAt is written
    const closedAt = record.closedAt ?? stop.at
    if (record.closedAt === undefined) {
      record = { ...record, closedAt }
      writeCloseRecord(paths, record)
    }
    // The ETH ceiling (final.eth_wei) was judged gas-dust at close time and is not re-priced here: if gas later falls, `resume` then close_kit sweeps it, and the closing note already names what is left.
    const stillEmpty = info.usdc === 0n && info.claimedBsvSats < CLOSE_BSV_DUST_LIMIT_SATS && info.unconfirmedBsvSats === 0n &&
      info.eth <= BigInt(final.eth_wei) && !kitWithdrawals(paths).some((w) => w.state !== 'done') && (await kitSwaps(kit)).every(swapFinished)
    if (!stillEmpty) {
      return refusedStep('funds arrived after this kit was closed; run `npx petasats-mcp resume` in a terminal, then close_kit again', sends)
    }
    // What is left now (never more than the dust limits allow), so keys_note names any dust that arrived since.
    const left = { usdc: info.usdc.toString(), eth_wei: info.eth.toString(), bsv_sats: info.claimedBsvSats.toString() }
    return { state: 'closed', closed_at: new Date(closedAt).toISOString(), sent: sends, final: left, keys_note: keysNote(paths, left) }
  }
  // A close_kit STOP with no record at all (close.json moved away) carries on: g then finds the kit empty or not.
  if (stop && (stop.reason !== CLOSED_STOP_REASON || record)) {
    return refusedStep('spending is stopped; run `npx petasats-mcp resume` in a terminal, then close_kit again', record?.sends ?? [])
  }

  // A gas purchase record that cannot be read may hide an order that can still spend the USDC: refuse, never guess.
  try { loadGasTopUp(paths.home, info.baseAddress) } catch (error) { return refusedStep(error instanceof Error ? error.message : String(error), record?.sends ?? []) }

  // d. Swaps.
  const blocking = (await kitSwaps(kit)).find((s) => !swapFinished(s))
  if (blocking) {
    const reasonPart = blocking.reason ? `: ${blocking.reason}` : ''
    return refusedStep(
      `swap ${blocking.swapId} is not finished yet (stage ${blocking.stage})${reasonPart}; the kit finishes it while it runs (in a terminal, \`npx petasats-mcp recover\` runs it), then call close_kit again`,
      record?.sends ?? [], 300,
    )
  }

  // e. Base withdrawals: list every one of this close-down that resolved as sent, wherever it resolved. Never call
  // withdrawBase or withdrawBsv while one is unresolved. Drive it forward with reconcileWithdrawals when the kit
  // supports it, rather than only waiting: the background recovery loop never reconciles a withdrawal on its own.
  const baseSends = (): CloseSend[] => {
    if (!record) return []
    const next = withBaseSends(paths, record)
    if (next !== record) {
      record = next
      writeCloseRecord(paths, record)
    }
    return record.sends
  }
  const sentSoFar = baseSends()
  const unresolved = kitWithdrawals(paths).find((w) => w.state !== 'done')
  if (unresolved) {
    const waiting: CloseKitStep = {
      state: 'in_progress', did: `nothing sent; waiting for the earlier Base withdrawal ${unresolved.hash} to confirm`,
      next: 'call again after that withdrawal confirms', call_again_after_seconds: 30, sent: sentSoFar,
    }
    if (!kit.reconcileWithdrawals) return waiting
    let outcome: BuyerWithdrawalReconcileOutcome | undefined
    try {
      outcome = await kit.reconcileWithdrawals()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A state only the user can clear (e.g. the consumed-nonce warning) must never brief-retry forever: refuse now.
      if (needsTheUser(error)) return refusedStep(message, sentSoFar)
      return { state: 'in_progress', did: `nothing new sent; ${message}`, next: 'call again', call_again_after_seconds: 60, sent: sentSoFar }
    }
    if (!outcome) return waiting
    return { state: 'in_progress', did: `nothing new sent; the earlier Base withdrawal ${outcome.hash} is final (${outcome.status})`, next: 'call again', call_again_after_seconds: 5, sent: baseSends() }
  }

  // f. Sends: at most one per call. The pair is pinned (close.json created if absent) immediately before each
  // send attempt, so a send that throws after broadcasting still leaves the pair recorded; appending the send
  // itself still happens only once the call returns. A throw that is not handled here refuses (rule h).
  if (info.usdc > 0n) {
    pin()
    try {
      const result = await kit.withdrawBase({ asset: 'USDC', to: request.baseAddress, amount: 'all' })
      const sent = appendSend({ asset: 'USDC', amount: result.amount.toString(), to: request.baseAddress, txid: result.txid })
      return { state: 'in_progress', did: `sent the USDC to ${request.baseAddress}`, next: 'wait for Base to confirm, then BSV and ETH', call_again_after_seconds: 30, sent }
    } catch (error) {
      if (error instanceof Error && error.message === GAS_TOPUP_WAIT_MESSAGE) {
        // Like ETH_GAS_DUST_ERROR, a kit-method throw that is progress: the USDC waits for the gas order to fill or expire.
        return gasWaitStep(record?.sends ?? [])
      }
      const pending = pendingAfterThrow(paths, error, record?.sends ?? [])
      if (pending) return pending
      throw error // rule h: no pending intent means a refusal.
    }
  }

  // BSV that is not confirmed yet is waited for, so one sweep takes every coin once they confirm. A sweep is saved in
  // close.json before its broadcast (the hook below) and cleared once it is listed, so a send whose result was lost
  // is still listed exactly once.
  const unconfirmed = info.unconfirmedBsvSats
  if (unconfirmed > 0n) return unconfirmedStep(unconfirmed, record?.sends ?? [])
  const saveBsvSweep = (sweep: BuyerSweepPlan): void => {
    assertSweepPlan(sweep)
    record = withBsvSweep(pin(), sweep)
    writeCloseRecord(paths, record)
  }
  const bsvSweepSent = (send?: CloseSend): CloseSend[] => {
    record = withBsvSweepSent(pin(), send)
    writeCloseRecord(paths, record)
    return record.sends
  }
  let bsvDust = false
  if (info.claimedBsvSats > 0n || record?.bsvOutbox) {
    pin()
    try {
      const result = await kit.withdrawBsv(request.bsvAddress, { beforeBroadcast: saveBsvSweep })
      if (result.sats > 0n) {
        if (!result.txid) throw new Error('BSV send reported sats without a txid')
        const sent = bsvSweepSent({ asset: 'BSV', amount: result.sats.toString(), to: request.bsvAddress, txid: result.txid })
        return { state: 'in_progress', did: `sent the confirmed BSV to ${request.bsvAddress}`, next: 'wait for the BSV send to confirm, then ETH', call_again_after_seconds: 60, sent }
      }
      // No confirmed coin at all, so a saved sweep's inputs are spent: it went out.
      const saved = record?.bsvOutbox
      if (saved) return { state: 'in_progress', did: `nothing new sent; the earlier BSV send ${saved.txid} went out`, next: 'call again', call_again_after_seconds: 5, sent: bsvSweepSent() }
      // Resolved with sats 0 (not thrown) while the first read showed confirmed BSV: the two reads disagree.
      return { state: 'in_progress', did: 'nothing sent; the claimed BSV is not confirmed yet', next: 'wait for a BSV confirmation, then send it', call_again_after_seconds: 300, sent: record?.sends ?? [] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!BSV_DUST_ERROR.test(message)) throw error // rule h: any other kit-method throw refuses.
      // A saved sweep's inputs would make this sweep larger than dust, so they are spent: it went out. The sent list
      // comes from the kit's own records; a block explorer shows the addresses' full history.
      if (record?.bsvOutbox) bsvSweepSent()
      bsvDust = true // too small to sweep; carry on to ETH and the empty check in this same call.
    }
  }

  // The ETH balance withdrawBase itself judged too small for its gas, carried on its refusal. Without it, the ETH is not
  // treated as dust: nothing is sent and the step does not close.
  let ethDustWei: bigint | undefined
  if (info.eth > 0n) {
    pin()
    try {
      const result = await kit.withdrawBase({ asset: 'ETH', to: request.baseAddress, amount: 'all' })
      const sent = appendSend({ asset: 'ETH', amount: result.amount.toString(), to: request.baseAddress, txid: result.txid })
      return { state: 'in_progress', did: `sent the remaining ETH to ${request.baseAddress}`, next: 'wait for Base to confirm the ETH send, then the kit is empty', call_again_after_seconds: 30, sent }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === ETH_GAS_DUST_ERROR) {
        // Too small to cover its own gas; leave it and carry on to the empty check in this same call.
        const judged = (error as { gasDustBalanceWei?: unknown }).gasDustBalanceWei
        ethDustWei = typeof judged === 'bigint' ? judged : undefined
      } else {
        const pending = pendingAfterThrow(paths, error, record?.sends ?? [])
        if (pending) return pending
        throw error // rule h: any other kit-method throw refuses.
      }
    }
  }

  // g. Empty check, read fresh in this call. A dust flag holds only while the fresh balance is still dust: BSV below
  // the dust limit, ETH no more than withdrawBase judged gas dust. Anything that arrived during the step is sent later.
  const freshInfo = await readWalletInfo(kit)
  const freshUnconfirmed = freshInfo.unconfirmedBsvSats
  if (freshUnconfirmed > 0n) return unconfirmedStep(freshUnconfirmed, record?.sends ?? [])
  const freshUnresolved = kitWithdrawals(paths).some((w) => w.state !== 'done')
  const freshSwapsFinished = (await kitSwaps(kit)).every(swapFinished)
  const bsvLeftOk = freshInfo.claimedBsvSats === 0n || (bsvDust && freshInfo.claimedBsvSats < CLOSE_BSV_DUST_LIMIT_SATS)
  const ethLeftOk = freshInfo.eth === 0n || (ethDustWei !== undefined && freshInfo.eth <= ethDustWei)
  const empty = freshInfo.usdc === 0n && bsvLeftOk && ethLeftOk && !freshUnresolved && freshSwapsFinished && !record?.bsvOutbox
  if (!empty) {
    return { state: 'in_progress', did: 'nothing sent; a balance or swap changed during this step', next: 'call again', call_again_after_seconds: 30, sent: record?.sends ?? [] }
  }

  // (1) record with final set and closedAt still unset, (2) stop spending, (3) record again with closedAt now
  // set, (4) return closed. If the process dies between (1) and (2), c above still sees no STOP and treats it as
  // "not yet closed" (F18a). If it dies between (2) and (3), c sees the STOP, finds final already set, and
  // finishes the write itself using the STOP's own `at` (F18b). Either way closedAt never exists without a
  // successful stop behind it, so "closedAt set and no STOP" still only ever means the user resumed.
  const final = { usdc: freshInfo.usdc.toString(), eth_wei: freshInfo.eth.toString(), bsv_sats: freshInfo.claimedBsvSats.toString() }
  const closedAt = now()
  record = { ...(record ?? { baseAddress: request.baseAddress, bsvAddress: request.bsvAddress, startedAt: closedAt, sends: [] }), final } // (1)
  writeCloseRecord(paths, record)
  // (2) A STOP that is already there (the user's own, written while this step ran) counts too: spending is stopped.
  stopSpending(paths, CLOSED_STOP_REASON, closedAt)
  // Checked after the STOP, so a gas order placed any time before it is caught; from here on buy_gas refuses (stopped).
  const gasWait = await gasOrderWait(kit, paths, info.baseAddress, record.sends); if (gasWait) return gasWait
  record = { ...record, closedAt } // (3)
  writeCloseRecord(paths, record)
  return { state: 'closed', closed_at: new Date(closedAt).toISOString(), sent: record.sends, final, keys_note: keysNote(paths, final) } // (4)
}

/**
 * One guarded close-down step: validate, check for a swap or unresolved withdrawal, send at most one of
 * USDC/BSV/ETH, then stop the kit once everything is empty. Never deletes, moves, prints or reads the keys file,
 * and never calls resumeSpending. Call it again (see call_again_after_seconds) until state is 'closed'.
 */
export async function closeKitStep(deps: { kit: BuyerKit; paths: BuyerHome; now?: () => number }, request: CloseKitRequest): Promise<CloseKitStep> {
  return serializeClose(async () => {
    try {
      return await runClose(deps, request)
    } catch (error) {
      return failedStep(error, sendsOnDisk(deps.paths))
    }
  })
}
