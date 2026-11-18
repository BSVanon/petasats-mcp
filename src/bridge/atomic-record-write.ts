import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'fs'
import { dirname } from 'path'

/**
 * A settlement record is a small state-machine snapshot, not an append-only log. 256 KiB leaves ample room for its
 * bounded fields/history while preventing an attacker-controlled JSON file from monopolising the daemon event loop
 * or heap before sibling recovery records are armed.
 */
export const MAX_SETTLEMENT_RECORD_BYTES = 256 * 1024

function assertRegularRecord(stat: Stats, path: string, maxBytes = MAX_SETTLEMENT_RECORD_BYTES): void {
  if (stat.isSymbolicLink()) throw new Error(`settlement-record: refusing symlink ${path}`)
  if (!stat.isFile()) throw new Error(`settlement-record: refusing non-regular file ${path}`)
  if (stat.size > maxBytes) {
    throw new Error(`settlement-record: ${path} is ${stat.size} bytes (limit ${maxBytes})`)
  }
}

/** Read a bounded regular file without following a symlink, including a symlink introduced after the lstat. */
export function readSettlementRecordFile(path: string, maxBytes = MAX_SETTLEMENT_RECORD_BYTES): string {
  assertRegularRecord(lstatSync(path), path, maxBytes)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(`settlement-record: refusing non-regular file ${path}`)
    if (stat.size > maxBytes) {
      throw new Error(`settlement-record: ${path} is ${stat.size} bytes (limit ${maxBytes})`)
    }
    // Do not rely on the pre-read stat alone: another process can grow a regular file after fstat. A fixed cap+1
    // buffer makes that race fail closed without first allocating or reading the attacker-controlled remainder.
    const bytes = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null)
      if (read === 0) break
      length += read
    }
    if (length > maxBytes) {
      throw new Error(`settlement-record: ${path} grew beyond the ${maxBytes}-byte limit while reading`)
    }
    return bytes.toString('utf8', 0, length)
  } finally {
    closeSync(fd)
  }
}

let temporaryFileCounter = 0

function openUniqueTemporaryFile(path: string, mode?: number): { path: string; fd: number } {
  // PID + a process-local counter keeps simultaneous writers (including separate OS processes) from sharing a temp
  // path. `wx` also avoids reusing a stale temp if a PID is eventually recycled after a crash.
  for (;;) {
    const temporaryPath = `${path}.${process.pid}.${temporaryFileCounter++}.tmp`
    try {
      return { path: temporaryPath, fd: openSync(temporaryPath, 'wx', mode) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
}

/** Every filesystem call syncNewEntry/syncRemovedEntry make. Tests substitute a subset to observe ordering or inject failures. */
interface SyncEntryFsOps {
  openSync: typeof openSync
  fsyncSync: typeof fsyncSync
  closeSync: typeof closeSync
}

interface SyncEntryOptions {
  fs?: SyncEntryFsOps
  platform?: NodeJS.Platform
  /** Flags for the POSIX directory open. Defaults to plain 'r'; callers that already open with O_DIRECTORY pass that. */
  directoryFlags?: string | number
}

function syncParentDirectory(path: string, fs: SyncEntryFsOps, directoryFlags: string | number): void {
  const directoryFd = fs.openSync(dirname(path), directoryFlags)
  try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
}

/**
 * Make a just-created, renamed, or linked directory entry power-loss durable.
 * POSIX fsyncs the parent directory — the sequence every durable writer in this codebase already used. Windows
 * cannot fsync a directory handle, so there it instead reopens and fsyncs the entry's own file; on NTFS that
 * flushes the file's metadata, including its new name — the same rule PostgreSQL's durable_rename follows.
 */
export function syncNewEntry(path: string, opts: SyncEntryOptions = {}): void {
  // Built fresh per call (never hoisted to a module-level constant): openSync/fsyncSync/closeSync are named imports,
  // and a test that monkeypatches the real fs module must still reach this default, unprotected by a stale snapshot.
  const fs = opts.fs ?? { openSync, fsyncSync, closeSync }
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') {
    const fd = fs.openSync(path, 'r+')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    return
  }
  syncParentDirectory(path, fs, opts.directoryFlags ?? 'r')
}

/**
 * Make a removal durable: the same parent-directory fsync as syncNewEntry on POSIX. Windows has no handle left to
 * flush once the name is gone, so this is a no-op there.
 */
export function syncRemovedEntry(path: string, opts: SyncEntryOptions = {}): void {
  const fs = opts.fs ?? { openSync, fsyncSync, closeSync }
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') return
  syncParentDirectory(path, fs, opts.directoryFlags ?? 'r')
}

/**
 * Persist serialized settlement-record data without ever truncating the live record in place.
 * The temporary file is deliberately beside the target, so rename is an atomic replacement.
 */
export function writeSettlementRecordAtomically(path: string, contents: string, mode?: number, maxBytes?: number): void {
  const bytes = Buffer.byteLength(contents)
  if (maxBytes !== undefined && bytes > maxBytes) {
    throw new Error(`settlement-record: refusing ${bytes}-byte write to ${path} (limit ${maxBytes})`)
  }
  if (maxBytes !== undefined) {
    // Atomic rename would replace (not follow) a symlink, but explicitly refusing it keeps the bounded daemon
    // record path's read/write trust boundary uniform. The generic unbounded atomic-write primitive retains its
    // original concurrent-writer contract; daemon/store call sites opt into both checks by passing the cap.
    try {
      assertRegularRecord(lstatSync(path), path, maxBytes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  let tmp: string | undefined
  let fd: number | undefined
  try {
    const opened = openUniqueTemporaryFile(path, mode)
    tmp = opened.path
    fd = opened.fd
    writeFileSync(fd, contents)
    if (mode !== undefined) {
      try { chmodSync(tmp, mode) } catch { /* best-effort permission normalization */ }
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined

    renameSync(tmp, path)
    tmp = undefined

    // The file fsync above made the new contents durable; syncNewEntry makes the rename itself durable too.
    syncNewEntry(path)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* preserve the original write failure */ }
    }
    if (tmp !== undefined) {
      try { unlinkSync(tmp) } catch { /* no temp remains after a successful rename */ }
    }
  }
}
