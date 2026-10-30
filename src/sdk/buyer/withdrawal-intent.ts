import * as fs from 'fs'
import { join } from 'path'
import { writeSettlementRecordAtomically } from '../../bridge/atomic-record-write'
import { secureFileText, type BuyerHome } from './local-state'
import type { BuyerWithdrawalIntents, BuyerWithdrawalReconcileOutcome } from './types'

export interface BuyerWithdrawalRecord {
  asset: 'USDC' | 'ETH'; to: string; amount: string; nonce: number; hash: string; signedTx: string; createdAtMs: number
  state: 'pending' | 'done'; status?: 'success' | 'reverted' | 'sent' | 'not-sent'; blockNumber?: string
  nonceConsumedAtBlock?: string
}
export interface BuyerWithdrawalRails {
  receipt(hash: `0x${string}`): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint } | undefined>
  finalizedBlockNumber(): Promise<bigint>
  nonceAtBlock(blockNumber: bigint): Promise<number>
  resendSigned(signedTx: `0x${string}`): Promise<`0x${string}`>
}
export interface BuyerWithdrawalReconcileGuards {
  /** Re-probes before every money decision and returns the verified endpoint set when available. */
  assertSafeForNewLock?: () => string | void | Promise<string | void>
  beforeResend?: () => void | Promise<void>
}
const validHash = (hash: string): hash is `0x${string}` => /^0x[0-9a-f]{64}$/i.test(hash)
const recordFile = (paths: BuyerHome, hash: string): string => {
  if (!validHash(hash)) throw new Error('invalid withdrawal hash')
  return join(paths.withdrawalsDir, `${hash.toLowerCase()}.json`)
}
const lockFile = (paths: BuyerHome, hash: string): string => recordFile(paths, hash).replace(/\.json$/, '.lock')
const LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 50
const RPC_REFUSAL = 'the Base RPC endpoints disagree; nothing new was sent'
function parseRecord(value: unknown): BuyerWithdrawalRecord {
  const record = value as BuyerWithdrawalRecord
  if (!record || !validHash(record.hash) || !/^0x[0-9a-f]+$/i.test(record.signedTx) || !/^(?:0|[1-9]\d*)$/.test(record.amount) || !Number.isSafeInteger(record.nonce) || record.nonce < 0 || (record.state !== 'pending' && record.state !== 'done') || (record.status !== undefined && !['success', 'reverted', 'sent', 'not-sent'].includes(record.status)) || (record.state === 'done' && record.status === undefined) || (record.nonceConsumedAtBlock !== undefined && !/^(?:0|[1-9]\d*)$/.test(record.nonceConsumedAtBlock))) throw new Error('invalid Base withdrawal record')
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
  return {
    async record(input) {
      if (!validHash(input.hash) || !/^0x[0-9a-f]+$/i.test(input.signedTx) || !Number.isSafeInteger(input.nonce) || input.nonce < 0) throw new Error('invalid Base withdrawal write-ahead data')
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
            await withRecordLock(paths, record.hash, async (latest) => {
              if (latest.state === 'done') return
              if (before !== await safeSnapshot()) throw new Error(RPC_REFUSAL)
              put({ ...latest, state: 'done', status: receipt.status, blockNumber: receipt.blockNumber.toString() }); wrote = true
            })
            if (wrote) reconciled ??= { hash: record.hash, asset: record.asset, to: record.to, amount: record.amount, status: receipt.status }
            continue
          }
          if (nonce > record.nonce) {
            let done = false
            await withRecordLock(paths, record.hash, async (latest) => {
              if (latest.state === 'done') { done = true; return }
              if (latest.nonceConsumedAtBlock !== undefined) return
              if (before !== await safeSnapshot()) throw new Error(RPC_REFUSAL)
              put({ ...latest, nonceConsumedAtBlock: finalized.toString() })
            })
            if (done) continue
            throw nonceWarning(record.hash)
          }
          let resent = false
          await withRecordLock(paths, record.hash, async (current) => {
            if (current.state === 'done') return
            if (current.nonceConsumedAtBlock !== undefined) throw nonceWarning(record.hash)
            // Persist before the signed bytes can escape, and hold only for the broadcast itself.
            put(current)
            await safeSnapshot()
            await guards.beforeResend?.()
            const resentHash = await rails.resendSigned(current.signedTx as `0x${string}`)
            if (resentHash.toLowerCase() !== record.hash.toLowerCase()) throw new Error('Base withdrawal re-send returned a different hash')
            resent = true
          })
          if (resent) throw new Error(`a previous Base withdrawal is still pending (hash ${record.hash}); it was re-sent; try again after it confirms; nothing new was sent`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message === RPC_REFUSAL || message.startsWith('another petasats-mcp process is updating withdrawal') || message.startsWith('a previous Base withdrawal is still pending') || message.startsWith('a previous Base withdrawal (')) throw error
          throw new Error('could not confirm the previous Base withdrawal; nothing new was sent')
        }
      }
      return reconciled
    },
  }
}
