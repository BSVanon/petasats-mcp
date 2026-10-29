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

    // A file fsync makes the new contents durable; syncing the parent directory makes the rename durable too.
    const directoryFd = openSync(dirname(path), 'r')
    try { fsyncSync(directoryFd) }
    finally { closeSync(directoryFd) }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* preserve the original write failure */ }
    }
    if (tmp !== undefined) {
      try { unlinkSync(tmp) } catch { /* no temp remains after a successful rename */ }
    }
  }
}
