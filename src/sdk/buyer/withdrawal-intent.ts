import * as fs from 'fs'
import { join } from 'path'
import { writeSettlementRecordAtomically } from '../../bridge/atomic-record-write'
import { InsufficientFundsError } from 'viem'
import { secureFileText, type BuyerHome } from './local-state'
import type { BuyerWithdrawalCancelResult, BuyerWithdrawalIntents, BuyerWithdrawalReconcileOutcome } from './types'

export const MAX_CANCELS = 3
export const CANCEL_RETRY_MS = 600_000
export interface BuyerWithdrawalCancel { hash: string; signedTx: string; atMs: number }
export interface BuyerWithdrawalRecord {
  asset: 'USDC' | 'ETH'; to: string; amount: string; nonce: number; hash: string; signedTx: string; createdAtMs: number
  state: 'pending' | 'done'; status?: 'success' | 'reverted' | 'sent' | 'not-sent' | 'cancelled'; blockNumber?: string
  nonceConsumedAtBlock?: string; cancels?: BuyerWithdrawalCancel[]
}
export interface BuyerWithdrawalRails {
  receipt(hash: `0x${string}`): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint } | undefined>
  finalizedBlockNumber(): Promise<bigint>
  nonceAtBlock(blockNumber: bigint): Promise<number>
  pendingNonce?(): Promise<number>
  resendSigned(signedTx: `0x${string}`): Promise<`0x${string}`>
  consumeNonce?(
    nonce: number,
    priorTxid?: `0x${string}`,
    onRecorded?: (signed: { hash: `0x${string}`; signedTx: `0x${string}`; nonce: number }) => void | Promise<void>,
  ): Promise<`0x${string}`>
}
export interface BuyerWithdrawalReconcileGuards {
  /** Re-probes before every money decision and returns the verified endpoint set when available. */
  assertSafeForNewLock?: () => string | void | Promise<string | void>
  beforeResend?: () => void | Promise<void>
}
const validHash = (hash: string): hash is `0x${string}` => /^0x[0-9a-f]{64}$/i.test(hash)
const validSignedTx = (signedTx: string): signedTx is `0x${string}` => /^0x[0-9a-f]+$/i.test(signedTx)
const recordFile = (paths: BuyerHome, hash: string): string => {
  if (!validHash(hash)) throw new Error('invalid withdrawal hash')
  return join(paths.withdrawalsDir, `${hash.toLowerCase()}.json`)
}
const lockFile = (paths: BuyerHome, hash: string): string => recordFile(paths, hash).replace(/\.json$/, '.lock')
const LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 50
const RPC_REFUSAL = 'the Base RPC endpoints disagree; nothing new was sent'
const INSUFFICIENT_FUNDS = new RegExp(InsufficientFundsError.nodeMessage.source, 'i')

export function isBaseInsufficientFunds(error: unknown): boolean {
  const visited = new Set<object>()
  let entry: unknown = error
  for (let depth = 0; depth < 16 && (typeof entry === 'object' || typeof entry === 'function') && entry !== null; depth++) {
    if (visited.has(entry as object)) return false
    visited.add(entry as object)
    if (entry instanceof InsufficientFundsError) return true
    if (entry instanceof Error) {
      const value = entry as Error & { details?: unknown; shortMessage?: unknown }
      if ([value.message, value.details, value.shortMessage].some((text) => typeof text === 'string' && INSUFFICIENT_FUNDS.test(text))) return true
    }
    entry = (entry as { cause?: unknown }).cause
  }
  return false
}

function parseRecord(value: unknown): BuyerWithdrawalRecord {
  const record = value as BuyerWithdrawalRecord
  const cancelsValid = record?.cancels === undefined || (Array.isArray(record.cancels) && record.cancels.length <= MAX_CANCELS && record.cancels.every((cancel) =>
    !!cancel && validHash(cancel.hash) && validSignedTx(cancel.signedTx) && Number.isSafeInteger(cancel.atMs) && cancel.atMs >= 0))
  if (!record || !validHash(record.hash) || !validSignedTx(record.signedTx) || !/^(?:0|[1-9]\d*)$/.test(record.amount) || !Number.isSafeInteger(record.nonce) || record.nonce < 0 ||
    (record.state !== 'pending' && record.state !== 'done') || (record.status !== undefined && !['success', 'reverted', 'sent', 'not-sent', 'cancelled'].includes(record.status)) ||
    (record.state === 'done' && record.status === undefined) || (record.status === 'cancelled' && (record.state !== 'done' || !record.cancels?.length)) ||
    !cancelsValid || (record.nonceConsumedAtBlock !== undefined && !/^(?:0|[1-9]\d*)$/.test(record.nonceConsumedAtBlock))) throw new Error('invalid Base withdrawal record')
  return record
}
export function listBuyerWithdrawalIntents(paths: BuyerHome): BuyerWithdrawalRecord[] {
  let names: string[]
  try { names = fs.readdirSync(paths.withdrawalsDir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.filter((name) => /^0x[0-9a-f]{64}\.json$/i.test(name)).map((name) => parseRecord(JSON.parse(secureFileText(join(paths.withdrawalsDir, name)))))
}
function currentRecord(paths: BuyerHome, hash: string): BuyerWithdrawalRecord {
  try { return parseRecord(JSON.parse(secureFileText(recordFile(paths, hash)))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Base withdrawal write-ahead record is missing')
    throw error
  }
}
function deadLock(lock: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid?: unknown }
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) < 1) return false
    try { process.kill(value.pid as number, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  } catch { return false }
}
async function withRecordLock<T>(paths: BuyerHome, hash: string, action: (record: BuyerWithdrawalRecord) => Promise<T> | T): Promise<T> {
  const lock = lockFile(paths, hash); const deadline = Date.now() + LOCK_WAIT_MS; let reclaimed = false
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + '\n', { encoding: 'utf8' }) } finally { fs.closeSync(fd) }
      try { return await action(currentRecord(paths, hash)) } finally { try { fs.unlinkSync(lock) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!reclaimed && deadLock(lock)) { fs.unlinkSync(lock); reclaimed = true; continue }
      if (Date.now() >= deadline) throw new Error(`another petasats-mcp process is updating withdrawal ${hash.toLowerCase()}; nothing new was sent; try again`)
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
}
function putBuyerWithdrawalIntent(paths: BuyerHome, record: BuyerWithdrawalRecord, write = writeSettlementRecordAtomically): void {
  write(recordFile(paths, record.hash), JSON.stringify(record) + '\n', 0o600)
}
/** Resolve only a nonce-consumed record: its exact signed bytes cannot land at that nonce any more. */
export async function resolveBuyerWithdrawalIntent(paths: BuyerHome, hash: string, outcome: 'sent' | 'not-sent'): Promise<BuyerWithdrawalRecord> {
  if (!validHash(hash)) throw new Error('invalid withdrawal hash')
  return withRecordLock(paths, hash, (current) => {
    if (current.state === 'done') {
      if (current.status !== outcome) throw new Error(`this withdrawal is already recorded as ${current.status ?? 'unknown'}; nothing changed`)
      return current
    }
    if (current.nonceConsumedAtBlock === undefined) throw new Error('this withdrawal may still land; wait for it to confirm')
    const done = { ...current, state: 'done' as const, status: outcome }
    putBuyerWithdrawalIntent(paths, done)
    return done
  })
}

export function makeBuyerWithdrawalIntents(paths: BuyerHome, rails: BuyerWithdrawalRails, now = Date.now, write = writeSettlementRecordAtomically, guards: BuyerWithdrawalReconcileGuards = {}): BuyerWithdrawalIntents {
  const put = (record: BuyerWithdrawalRecord): void => write(recordFile(paths, record.hash), JSON.stringify(record) + '\n', 0o600)
  const safeSnapshot = async (): Promise<string | void> => {
    try { return await guards.assertSafeForNewLock?.() } catch { throw new Error(RPC_REFUSAL) }
  }
  const nonceWarning = (hash: string): Error => new Error(`a previous Base withdrawal (${hash}) used its nonce but its receipt was not found, so it may have been paid; check ${hash} on a Base block explorer, then run \`npx petasats-mcp withdrawal ${hash} sent\` or \`npx petasats-mcp withdrawal ${hash} not-sent\`; nothing new was sent`)
  const latestCancel = (record: BuyerWithdrawalRecord): BuyerWithdrawalCancel | undefined => record.cancels?.[record.cancels.length - 1]
  const beingCancelled = (record: BuyerWithdrawalRecord, cancelHash = latestCancel(record)?.hash): Error => new Error(`the previous Base withdrawal ${record.hash} is being cancelled at its nonce (cancellation ${cancelHash ?? 'not yet confirmed'}). Try again after the cancellation is final on Base. Nothing new was sent.`)
  const cancelResultMessage = (record: BuyerWithdrawalRecord, result: BuyerWithdrawalCancelResult): Error => {
    if (result.status === 'cancelling') return new Error(`the Base RPC refused the withdrawal ${record.hash} for insufficient funds. The kit broadcast a zero-value cancellation at the same nonce. Either the withdrawal or the cancellation can still land, never both. The kit stays blocked until one is final on Base. Do not retry this withdrawal from another copy of this wallet. Nothing new was sent.`)
    if (result.status === 'unaffordable') return new Error(`the account cannot pay the gas to cancel the refused withdrawal ${record.hash}. Add a little ETH for Base gas, then call again. The kit will then complete or cancel it, never both. Nothing new was sent.`)
    if (result.status === 'limit') return new Error(`the previous Base withdrawal ${record.hash} could not be cancelled after ${MAX_CANCELS} attempts. It stays recorded. Nothing new was sent.`)
    if (result.status === 'waiting') return beingCancelled(record, result.cancelHash)
    if (result.status === 'unsupported') return new Error(`this kit runtime cannot cancel the refused Base withdrawal ${record.hash}. The withdrawal stays recorded and blocks new money until it is resolved. Nothing new was sent.`)
    return new Error(`the previous Base withdrawal ${record.hash} stays recorded, and the next call continues checking it. Nothing new was sent.`)
  }
  const startCancel = async (hash: string, expectedLatestCancelHash: string | undefined, snapshot?: string | void): Promise<BuyerWithdrawalCancelResult> => withRecordLock(paths, hash, async (current) => {
    if (current.state === 'done') return { status: 'unconfirmed' }
    if (current.nonceConsumedAtBlock !== undefined) throw nonceWarning(hash)
    const latest = latestCancel(current)
    const expectedStateStillCurrent = expectedLatestCancelHash === undefined
      ? latest === undefined
      : latest?.hash.toLowerCase() === expectedLatestCancelHash.toLowerCase() && now() - latest.atMs >= CANCEL_RETRY_MS && (current.cancels?.length ?? 0) < MAX_CANCELS
    if (!expectedStateStillCurrent) return { status: 'waiting', ...(latest ? { cancelHash: latest.hash } : {}) }
    if (!rails.consumeNonce) return { status: 'unsupported' }
    const priorHash = latest?.hash ?? current.hash
    let recordedHash: string | undefined
    try {
      await guards.beforeResend?.()
      const before = snapshot ?? await safeSnapshot()
      if (before !== await safeSnapshot()) throw new Error(RPC_REFUSAL)
      const acknowledged = await rails.consumeNonce(current.nonce, priorHash as `0x${string}`, async (signed) => {
        if (signed.nonce !== current.nonce) throw new Error('buyer withdrawal cancel recorder received a different nonce')
        const next = { ...current, cancels: [...(current.cancels ?? []), { hash: signed.hash, signedTx: signed.signedTx, atMs: now() }] }
        put(next)
        recordedHash = signed.hash
      })
      if (!recordedHash || acknowledged.toLowerCase() !== recordedHash.toLowerCase()) return { status: 'unconfirmed', ...(recordedHash ? { cancelHash: recordedHash } : {}) }
      return { status: 'cancelling', cancelHash: recordedHash }
    } catch (error) {
      if (error instanceof Error && error.message === RPC_REFUSAL) throw error
      return { status: isBaseInsufficientFunds(error) ? 'unaffordable' : 'unconfirmed', ...(recordedHash ? { cancelHash: recordedHash } : {}) }
    }
  })
  const outcome = (record: BuyerWithdrawalRecord, status: BuyerWithdrawalReconcileOutcome['status']): BuyerWithdrawalReconcileOutcome => ({ hash: record.hash, asset: record.asset, to: record.to, amount: record.amount, status })

  return {
    async record(input) {
      if (!validHash(input.hash) || !validSignedTx(input.signedTx) || !Number.isSafeInteger(input.nonce) || input.nonce < 0) throw new Error('invalid Base withdrawal write-ahead data')
      put({ asset: input.asset, to: input.to, amount: input.amount.toString(), nonce: input.nonce, hash: input.hash, signedTx: input.signedTx, createdAtMs: now(), state: 'pending' })
    },
    async done(hash, result) {
      await withRecordLock(paths, hash, (current) => {
        if (current.state === 'done') {
          if (current.status !== result.status) throw new Error(`this withdrawal is already recorded as ${current.status ?? 'unknown'}; nothing changed`)
          return
        }
        put({ ...current, state: 'done', status: result.status, ...(result.blockNumber !== undefined ? { blockNumber: result.blockNumber.toString() } : {}) })
      })
    },
    list: () => listBuyerWithdrawalIntents(paths),
    cancel: (hash) => startCancel(hash, undefined),
    async reconcile(): Promise<BuyerWithdrawalReconcileOutcome | undefined> {
      let reconciled: BuyerWithdrawalReconcileOutcome | undefined
      for (const record of listBuyerWithdrawalIntents(paths).filter((entry) => entry.state !== 'done')) {
        try {
          const before = await safeSnapshot()
          const finalized = await rails.finalizedBlockNumber()
          const nonce = await rails.nonceAtBlock(finalized)
          if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('invalid finalized account nonce')
          const receipt = await rails.receipt(record.hash as `0x${string}`)
          if (receipt) {
            if (receipt.blockNumber > finalized) throw new Error(`a previous Base withdrawal (${record.hash}) is mined and waiting for Base finality; try again later; nothing new was sent`)
            if (nonce <= record.nonce) throw new Error('could not confirm the previous Base withdrawal; nothing new was sent')
            let wrote = false
            await withRecordLock(paths, record.hash, async (current) => {
              if (current.state === 'done') return
              if (before !== await safeSnapshot()) throw new Error(RPC_REFUSAL)
              put({ ...current, state: 'done', status: receipt.status, blockNumber: receipt.blockNumber.toString() }); wrote = true
            })
            if (wrote) reconciled ??= outcome(record, receipt.status)
            continue
          }
          let cancelled = false
          for (const cancel of record.cancels ?? []) {
            const cancelReceipt = await rails.receipt(cancel.hash as `0x${string}`)
            if (!cancelReceipt) continue
            if (cancelReceipt.blockNumber > finalized) throw beingCancelled(record)
            if (nonce <= record.nonce) throw new Error('could not confirm the previous Base withdrawal; nothing new was sent')
            let wrote = false
            await withRecordLock(paths, record.hash, async (current) => {
              if (current.state === 'done') return
              if (before !== await safeSnapshot()) throw new Error(RPC_REFUSAL)
              put({ ...current, state: 'done', status: 'cancelled', blockNumber: cancelReceipt.blockNumber.toString() }); wrote = true
            })
            if (wrote) reconciled ??= outcome(record, 'cancelled')
            cancelled = true
            break
          }
          if (cancelled) continue
          if (nonce > record.nonce) {
            let done = false
            await withRecordLock(paths, record.hash, async (current) => {
              if (current.state === 'done') { done = true; return }
              if (current.nonceConsumedAtBlock !== undefined) return
              if (before !== await safeSnapshot()) throw new Error(RPC_REFUSAL)
              put({ ...current, nonceConsumedAtBlock: finalized.toString() })
            })
            if (done) continue
            throw nonceWarning(record.hash)
          }
          if (record.cancels?.length) {
            let action: 'none' | 'waiting' | 'unaffordable' | 'retry' | 'limit' = 'none'
            let currentRecord = record
            let retryHash: string | undefined
            await withRecordLock(paths, record.hash, async (current) => {
              currentRecord = current
              if (current.state === 'done') return
              if (current.nonceConsumedAtBlock !== undefined) throw nonceWarning(record.hash)
              const cancel = latestCancel(current)
              if (!cancel) return
              put(current)
              if (before !== await safeSnapshot()) throw new Error(RPC_REFUSAL)
              await guards.beforeResend?.()
              let returnedOwnHash = false
              try {
                const resentHash = await rails.resendSigned(cancel.signedTx as `0x${string}`)
                returnedOwnHash = resentHash.toLowerCase() === cancel.hash.toLowerCase()
              } catch (error) {
                if (isBaseInsufficientFunds(error)) { action = 'unaffordable'; return }
              }
              if (returnedOwnHash || now() - cancel.atMs < CANCEL_RETRY_MS) { action = 'waiting'; return }
              action = (current.cancels?.length ?? 0) >= MAX_CANCELS ? 'limit' : 'retry'
              if (action === 'retry') retryHash = cancel.hash
            })
            if (action === 'none') continue
            if (action === 'waiting') throw beingCancelled(currentRecord)
            if (action === 'unaffordable') throw cancelResultMessage(currentRecord, { status: 'unaffordable', cancelHash: latestCancel(currentRecord)?.hash })
            if (action === 'limit') throw cancelResultMessage(currentRecord, { status: 'limit' })
            throw cancelResultMessage(currentRecord, await startCancel(record.hash, retryHash, before))
          }
          let action: 'none' | 'resent' | 'cancel' | 'waiting' = 'none'
          let currentRecord = record
          await withRecordLock(paths, record.hash, async (current) => {
            currentRecord = current
            if (current.state === 'done') return
            if (current.nonceConsumedAtBlock !== undefined) throw nonceWarning(record.hash)
            if (current.cancels?.length) { action = 'waiting'; return }
            // Persist before the signed bytes can escape, and hold only for the broadcast itself.
            put(current)
            await safeSnapshot()
            await guards.beforeResend?.()
            let resentHash: `0x${string}`
            try { resentHash = await rails.resendSigned(current.signedTx as `0x${string}`) } catch (error) {
              if (isBaseInsufficientFunds(error)) { action = 'cancel'; return }
              throw error
            }
            if (resentHash.toLowerCase() !== record.hash.toLowerCase()) throw new Error('Base withdrawal re-send returned a different hash')
            action = 'resent'
          })
          if (action === 'none') continue
          if (action === 'waiting') throw beingCancelled(currentRecord)
          if (action === 'cancel') throw cancelResultMessage(currentRecord, await startCancel(record.hash, undefined, before))
          throw new Error(`a previous Base withdrawal is still pending (hash ${record.hash}); it was re-sent; try again after it confirms; nothing new was sent`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message === RPC_REFUSAL || message.startsWith('another petasats-mcp process is updating withdrawal') || message.startsWith('a previous Base withdrawal is still pending') || message.startsWith('a previous Base withdrawal (') || message.startsWith('the previous Base withdrawal ') || message.startsWith('the Base RPC refused the withdrawal ') || message.startsWith('the account cannot pay the gas ') || message.startsWith('this kit runtime cannot cancel ')) throw error
          throw new Error('could not confirm the previous Base withdrawal; nothing new was sent')
        }
      }
      return reconciled
    },
  }
}
