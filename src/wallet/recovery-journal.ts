/** Small crash-safe JSON journal primitive for attended recovery tools. */
import { closeSync, existsSync, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'

export function writeAtomicJson(path: string, value: unknown): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`)
  const data = `${JSON.stringify(value, null, 2)}\n`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', 0o600)
    fchmodSync(fd, 0o600)
    writeFileSync(fd, data, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, path)
    const dir = openSync(dirname(path), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(tmp)) rmSync(tmp)
    throw error
  }
}

/** Recovery tools must never create or migrate a missing wallet database, even in dry mode. */
export function requireExistingWalletDb(path: string): void {
  if (!existsSync(path)) throw new Error(`wallet DB not found at ${path}; nothing created`)
}
