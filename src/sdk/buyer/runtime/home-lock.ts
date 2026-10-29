import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'fs'
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
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
  const fd = openSync(path, flags)
  try {
    if (!fstatSync(fd).isDirectory()) throw new Error(`unsafe local directory ${path}; replace it with a directory and chmod 700 ${path}`)
    fchmodSync(fd, 0o700)
  } finally { closeSync(fd) }
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
