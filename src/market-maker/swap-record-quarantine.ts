/**
 * Adoption of `.swap-clear-*` quarantine leftovers from compare-and-clear (swap-record-store.ts).
 *
 * compareAndClear moves a verified terminal record into a private quarantine directory before unlinking it. A writer
 * racing that rename, or a crash between the rename and the cleanup, can leave a LIVE record inside the quarantine,
 * where no `*.json` scan sees it. The directory owner therefore adopts each leftover: a record whose root path is
 * absent is restored (link, unlink, directory fsync, rmdir); anything ambiguous is kept and reported CRITICAL; an empty
 * quarantine directory is removed. Record bytes are never deleted here.
 */

import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { readSettlementRecordFile } from '../bridge/atomic-record-write'

export const SWAP_CLEAR_QUARANTINE_PREFIX = '.swap-clear-'
export const QUARANTINED_RECORD_NAME = 'verified-record'

export interface SwapRecordQuarantineScan {
  /** Root record paths restored from quarantine in this pass. */
  adopted: string[]
  /** Quarantine paths kept as evidence an operator must reconcile (CRITICAL). */
  critical: string[]
  /** Empty quarantine directories removed. */
  removed: string[]
}

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

function rootExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, 'r')
  try { fsyncSync(fd) }
  finally { closeSync(fd) }
}

/** Read the quarantined record's swap id with the bounded, no-follow record reader. */
function quarantinedHashHex(path: string): string {
  const record = JSON.parse(readSettlementRecordFile(path)) as { hashHex?: unknown } | null
  if (typeof record?.hashHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(record.hashHex)) {
    throw new Error('quarantined record has no 32-byte hex hashHex')
  }
  return record.hashHex
}

/**
 * For the record directory's OWNER only (it links, unlinks, and removes directories). Adopts, removes, or reports every
 * quarantine leftover in `dir`. Throws only when `dir` itself cannot be listed.
 */
export function adoptQuarantinedSwapRecords(dir: string, log: (message: string) => void): SwapRecordQuarantineScan {
  const scan: SwapRecordQuarantineScan = { adopted: [], critical: [], removed: [] }
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(SWAP_CLEAR_QUARANTINE_PREFIX)) continue
    const quarantine = join(dir, name)
    const keep = (why: string): void => {
      scan.critical.push(quarantine)
      log(`🚨 CRITICAL swap-record quarantine KEPT at ${quarantine}: ${why} — operator must reconcile; never deleted`)
    }
    try {
      if (!lstatSync(quarantine).isDirectory()) {
        keep('not a directory')
        continue
      }
      const entries = readdirSync(quarantine)
      if (entries.length === 0) {
        rmdirSync(quarantine)
        scan.removed.push(quarantine)
        continue
      }
      if (entries.length !== 1 || entries[0] !== QUARANTINED_RECORD_NAME) {
        keep(`unexpected contents (${entries.join(', ')})`)
        continue
      }
      const held = join(quarantine, QUARANTINED_RECORD_NAME)
      let hashHex: string
      try { hashHex = quarantinedHashHex(held) }
      catch (error) {
        keep(`unparseable quarantined record (${describe(error)})`)
        continue
      }
      const root = join(dir, `${hashHex}.json`)
      if (rootExists(root)) {
        keep(`root record ${root} also exists; both generations kept`)
        continue
      }
      linkSync(held, root) // EEXIST if a writer recreated the root meanwhile: kept below, both generations retained
      unlinkSync(held)
      fsyncDirectory(dir)
      rmdirSync(quarantine)
      scan.adopted.push(root)
      log(`⚠️ swap-record quarantine ADOPTED: restored ${root} from ${quarantine}`)
    } catch (error) {
      keep(`adoption failed (${describe(error)})`)
    }
  }
  return scan
}
