import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { isAddress, type Address } from 'viem'
import { parseEvmNonceState, type EvmNonceState } from './inflight-state'

export const NONCE_STATE_MODE = 0o660
export const NONCE_STATE_DIRECTORY_MODE = 0o770

/** Every filesystem call the nonce state makes. Tests substitute a subset to observe ordering or inject failures. */
export interface NonceStateFsOps {
  chmodSync: typeof chmodSync
  closeSync: typeof closeSync
  fchmodSync: typeof fchmodSync
  fstatSync: typeof fstatSync
  fsyncSync: typeof fsyncSync
  lstatSync: typeof lstatSync
  mkdirSync: typeof mkdirSync
  openSync: typeof openSync
  readFileSync: typeof readFileSync
  renameSync: typeof renameSync
  writeFileSync: typeof writeFileSync
}

const NODE_FS_OPS: NonceStateFsOps = {
  chmodSync, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync,
}

export function nonceStateFsOps(overrides: Partial<NonceStateFsOps> = {}): NonceStateFsOps {
  return { ...NODE_FS_OPS, ...overrides }
}

/**
 * The replacement file is already in place, but its directory entry could not be made durable. The new state is
 * visible yet might not survive power loss, so a caller must neither submit bytes nor treat the record as absent.
 */
export class NonceStateDurabilityError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`EVM nonce counter ${path} was replaced but its directory entry is not durable (fail-closed): ${detail}`)
    this.name = 'NonceStateDurabilityError'
  }
}

export function assertNonce(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`EVM nonce counter: ${label} must be a non-negative safe integer (got ${String(value)})`)
  }
}

export function assertIdentity(chainId: number, address: Address): void {
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw new Error(`EVM nonce counter: chainId must be a positive safe integer (got ${String(chainId)})`)
  }
  if (!isAddress(address)) throw new Error(`EVM nonce counter: address is invalid ('${String(address)}')`)
}

/** Read and strictly parse the state. Absence is benign only when the file and its temp are both absent. */
export function readNonceStateFile(path: string, tmpPath: string, fs: NonceStateFsOps): EvmNonceState | undefined {
  // A leftover temp can mean the prior process died after a successful broadcast but before atomic rename. The old
  // counter is then unsafe to reuse, so halt before preparing another transaction and require operator resolution.
  try {
    fs.lstatSync(tmpPath)
    throw new Error(`temporary state ${tmpPath} exists from an incomplete replace (prior broadcast may be live; fail-closed)`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof Error && error.message.includes('temporary state')) throw error
      throw new Error(`temporary state ${tmpPath} is unreadable/ambiguous (fail-closed): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let before
  try { before = fs.lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined // first boot is the ONLY benign absence
    throw new Error(`EVM nonce counter ${path} is unreadable (fail-closed): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`EVM nonce counter ${path} must be a regular non-symlink file (fail-closed)`)
  }
  const mode = before.mode & 0o777
  if (mode !== NONCE_STATE_MODE) {
    throw new Error(`EVM nonce counter ${path} must be 0660 owner/group-only; got 0${mode.toString(8)} (fail-closed)`)
  }

  let fd: number | undefined
  try {
    fd = fs.openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`EVM nonce counter ${path} changed while opening (fail-closed)`)
    }
    if ((opened.mode & 0o777) !== NONCE_STATE_MODE) {
      throw new Error(`EVM nonce counter ${path} permissions changed while opening (fail-closed)`)
    }
    return parseEvmNonceState(fs.readFileSync(fd, 'utf8'), path)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EVM nonce counter')) throw error
    throw new Error(`EVM nonce counter ${path} is unreadable/corrupt (fail-closed): ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Replace the state durably: temp write -> fchmod -> fsync -> rename -> parent directory fsync. */
export function writeNonceStateFile(path: string, tmpPath: string, state: EvmNonceState, fs: NonceStateFsOps): void {
  assertIdentity(state.chainId, state.address)
  assertNonce(state.nextNonce, 'nextNonce')
  if (!Number.isSafeInteger(state.lastBroadcastAtMs) || state.lastBroadcastAtMs < 0) {
    throw new Error(`EVM nonce counter: lastBroadcastAtMs must be a non-negative safe integer (got ${String(state.lastBroadcastAtMs)})`)
  }
  if (state.latestHighWater !== undefined) assertNonce(state.latestHighWater, 'latestHighWater')
  const parent = dirname(path)
  const created = fs.mkdirSync(parent, { recursive: true, mode: NONCE_STATE_DIRECTORY_MODE })
  // `mode` is filtered by umask. Force only a directory this call created; preserve an existing deployment's
  // intentional setgid bit (normally 02770) and ownership.
  if (created !== undefined) fs.chmodSync(parent, NONCE_STATE_DIRECTORY_MODE)

  // Harvested signing-window pattern: write the complete JSON to a temp, force its mode, make it durable, then
  // atomically rename. O_EXCL + O_NOFOLLOW means a leftover or symlink temp fails closed rather than being followed.
  let fd: number | undefined
  try {
    fd = fs.openSync(
      tmpPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      NONCE_STATE_MODE,
    )
    const opened = fs.fstatSync(fd)
    if (!opened.isFile()) throw new Error(`EVM nonce counter temp ${tmpPath} is not a regular file (fail-closed)`)
    fs.writeFileSync(fd, `${JSON.stringify(state)}\n`)
    fs.fchmodSync(fd, NONCE_STATE_MODE) // force the opened inode owner/group-only; never re-resolve/follow the temp pathname
    fs.fsyncSync(fd) // the mode change is part of what must be durable, so it precedes the fsync
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, path)

  // The file fsync made the contents durable; only the parent directory fsync makes the rename itself durable.
  let directoryFd: number | undefined
  try {
    directoryFd = fs.openSync(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
    fs.fsyncSync(directoryFd)
  } catch (error) {
    throw new NonceStateDurabilityError(path, error instanceof Error ? error.message : String(error))
  } finally {
    if (directoryFd !== undefined) {
      try { fs.closeSync(directoryFd) } catch { /* the durability verdict above is what matters */ }
    }
  }
}

/**
 * Operator-only recovery for a missing counter on an already-used account. Refuses an existing state, any pending
 * nonce, or a missing acknowledgement that the operator independently confirmed the mempool is empty.
 */
export function initializeMissingNonceStateFile(args: {
  path: string
  chainId: number
  address: Address
  chainLatest: number
  chainPending: number
  confirmedNothingPending: boolean
  nowMs?: number
  fsOps?: Partial<NonceStateFsOps>
}): EvmNonceState {
  assertIdentity(args.chainId, args.address)
  assertNonce(args.chainLatest, 'chainLatest')
  assertNonce(args.chainPending, 'chainPending')
  if (!args.confirmedNothingPending) {
    throw new Error('EVM nonce counter initialization requires explicit operator confirmation that nothing is pending')
  }
  if (args.chainPending !== args.chainLatest) {
    throw new Error(`EVM nonce counter initialization refused: pending ${args.chainPending} != confirmed/latest ${args.chainLatest}`)
  }
  const nowMs = args.nowMs ?? Date.now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error(`EVM nonce counter initialization clock is invalid (${String(nowMs)})`)
  const fs = nonceStateFsOps(args.fsOps)
  const path = args.path
  const tmpPath = `${path}.tmp`
  if (readNonceStateFile(path, tmpPath, fs)) {
    throw new Error(`EVM nonce counter ${path} already exists; explicit missing-state initialization refuses to overwrite it`)
  }
  const state: EvmNonceState = {
    chainId: args.chainId,
    address: args.address.toLowerCase() as Address,
    nextNonce: args.chainLatest,
    lastBroadcastAtMs: nowMs,
    ...(args.chainLatest > 0 ? { latestHighWater: args.chainLatest } : {}),
  }
  writeNonceStateFile(path, tmpPath, state, fs)
  return state
}
