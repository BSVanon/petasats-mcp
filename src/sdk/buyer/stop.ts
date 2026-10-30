import * as fs from 'fs'
import { dirname } from 'path'
import { secureFileText, type BuyerHome } from './local-state'

export interface SpendingStop { at: number; reason?: string }
export interface ResumedSpending extends SpendingStop { invalid?: false }
export interface DiscardedInvalidStop { invalid: true }

function stopFileExists(paths: BuyerHome): boolean {
  try {
    const stat = fs.lstatSync(paths.stopPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('STOP is not a regular file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function readSpendingStop(paths: BuyerHome): SpendingStop | undefined {
  let exists: boolean
  try { exists = stopFileExists(paths) } catch (error) {
    throw new Error(`spending is stopped; fix STOP at the terminal (${error instanceof Error ? error.message : 'invalid stop record'})`)
  }
  if (!exists) return undefined
  try {
    const value = JSON.parse(secureFileText(paths.stopPath)) as Partial<SpendingStop>
    const at = value.at
    if (!Number.isSafeInteger(at) || at === undefined || at < 0 || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 200))) throw new Error('STOP has invalid contents')
    return { at, ...(value.reason ? { reason: value.reason } : {}) }
  } catch (error) { throw new Error(`spending is stopped; fix STOP at the terminal (${error instanceof Error ? error.message : 'invalid stop record'})`) }
}
export function stopSpending(paths: BuyerHome, reason: string | undefined, at = Date.now()): { alreadyStopped: boolean; at?: number; reason?: string } {
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) throw new Error('reason must be 200 characters or fewer')
  try {
    const fd = fs.openSync(paths.stopPath, 'wx', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify({ at, ...(reason ? { reason } : {}) }) + '\n'); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    const dir = fs.openSync(dirname(paths.stopPath), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
    return { alreadyStopped: false, at, ...(reason ? { reason } : {}) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // An interrupted STOP write is still a stop.  Preserve valid metadata when
    // available, but parsing damage must never turn idempotence into a throw.
    try { return { alreadyStopped: true, ...readSpendingStop(paths) } } catch { return { alreadyStopped: true } }
  }
}
export function resumeSpending(paths: BuyerHome): ResumedSpending | DiscardedInvalidStop | undefined {
  let exists: boolean
  try { exists = stopFileExists(paths) } catch (error) {
    throw new Error(`cannot resume: ${error instanceof Error ? error.message : 'invalid STOP record'}`)
  }
  if (!exists) return undefined
  let current: SpendingStop | undefined
  let invalid = false
  try { current = readSpendingStop(paths) } catch { invalid = true }
  fs.unlinkSync(paths.stopPath)
  const dir = fs.openSync(dirname(paths.stopPath), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  return invalid ? { invalid: true } : current!
}
