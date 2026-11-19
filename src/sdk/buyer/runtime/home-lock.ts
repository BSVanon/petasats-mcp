import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

interface OwnedHomeLock { path: string }

const owned = new Map<string, OwnedHomeLock>()
let exitHandlerInstalled = false

function lockError(home: string, path: string, pid: number): Error {
  return new Error(`another petasats-mcp process (pid ${pid}) is using the buyer home ${home}; close it, or remove ${path} if that process is gone`)
}

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    if (code === 'ESRCH') return false
    throw error
  }
}

/**
 * Creates and secures the lock directory with exactly local-state.ts's safeMkdir guard (lstat, mkdir 0700, lstat,
 * then an fd-open+fchmod to 0700 — skipped in favor of a plain chmod when O_DIRECTORY or O_NOFOLLOW is unavailable,
 * e.g. on win32, where fchmod-ing a directory handle most likely fails; libuv's fchmod reopens the handle without
 * backup semantics). The guard is duplicated here rather than imported from local-state.ts: there is no import
 * cycle, but local-state.ts pulls in @bsv/sdk and viem, and a bare ts-node cold start of that whole graph measured
 * over 2.5s from this file alone — past the 2000ms timeout the child-kill lock test below relies on. Keep both
 * copies identical if either one changes.
 */
function lockDirectory(home: string): string {
  const path = join(home, 'kit.lock.d')
  const assertDirectory = (): void => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe local directory ${path}; replace it with a directory and chmod 700 ${path}`)
  }
  try { assertDirectory() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  assertDirectory()
  const fsConstants = constants as typeof constants & { O_DIRECTORY?: number; O_NOFOLLOW?: number }
  if (fsConstants.O_DIRECTORY !== undefined && fsConstants.O_NOFOLLOW !== undefined) {
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    try {
      if (!fstatSync(fd).isDirectory()) throw new Error(`unsafe local directory ${path}; replace it with a directory and chmod 700 ${path}`)
      fchmodSync(fd, 0o700)
    } finally { closeSync(fd) }
  } else chmodSync(path, 0o700)
  return path
}

function parseEntry(name: string): { pid: number } | undefined {
  const match = /^(\d+)-(\d+)-([0-9a-f]{16})$/.exec(name)
  if (!match) return undefined
  const pid = Number(match[1]); const startedAtMs = Number(match[2])
  return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(startedAtMs) && startedAtMs >= 0 ? { pid } : undefined
}

function writeEntry(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'wx', 0o600)
    fchmodSync(fd, 0o600)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function removeOwnedLocks(): void {
  for (const lock of owned.values()) {
    try { unlinkSync(lock.path) } catch { /* process exit cannot recover from a filesystem error */ }
  }
}

/** Acquire the process-wide owner file before any buyer rail or recovery component is assembled. */
export function acquireBuyerHomeLock(home: string): string {
  const held = owned.get(home)
  if (held) return held.path
  const directory = lockDirectory(home)
  const path = join(directory, `${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`)
  writeEntry(path)
  // Every process creates its entry before it lists, so of two live processes the one that lists later always sees
  // the other's entry. Two simultaneous starts may both refuse; retrying is safe. Nothing is renamed or moved.
  try {
    for (const name of readdirSync(directory)) {
      if (name === path.slice(directory.length + 1)) continue
      const entry = parseEntry(name)
      if (!entry) throw new Error(`invalid buyer home lock entry ${join(directory, name)}; remove it before retrying`)
      const entryPath = join(directory, name)
      if (pidIsAlive(entry.pid)) throw lockError(home, entryPath, entry.pid)
      try { unlinkSync(entryPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  } catch (error) {
    try { unlinkSync(path) } catch { /* keep the original refusal */ }
    throw error
  }
  owned.set(home, { path })
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true
    process.on('exit', removeOwnedLocks)
  }
  return path
}
