import {
  chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync,
} from 'fs'
import { dirname, join } from 'path'
import type { SettlementRecord } from '../bridge/settlement-session'
import { MAX_SETTLEMENT_RECORD_BYTES, readSettlementRecordFile, writeSettlementRecordAtomically } from '../bridge/atomic-record-write'
import type { SwapRecordSink } from '../bridge/settlement-types'
import { adoptQuarantinedSwapRecords, QUARANTINED_RECORD_NAME, SWAP_CLEAR_QUARANTINE_PREFIX } from './swap-record-quarantine'

export interface SwapRecordDirs {
  coord: string
  liveSwaps: string
  restockSwaps: string
  eveSwapRecords: string
  allDirs: string[]
}

const DEFAULT_MAKER_COORD = ".keys/maker-coord"
const DEFAULT_MAKER_BRAIN = "/opt/maker/state/maker-brain"

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed || undefined
}

const splitSwapRecordDirs = (value: string): string[] => [...new Set(value.split(/[\s,]+/).map((dir) => dir.trim()).filter(Boolean))]

export function resolveSwapRecordDirs(env: Record<string, string | undefined> = process.env): SwapRecordDirs {
  const coord = nonBlank(env.MAKER_COORD) ?? DEFAULT_MAKER_COORD
  const brain = nonBlank(env.MAKER_BRAIN) ?? DEFAULT_MAKER_BRAIN
  const liveSwaps = nonBlank(env.MAKER_SWAP_RECORDS) ?? join(coord, 'live-swaps')
  const restockSwaps = nonBlank(env.MAKER_RESTOCK_RECORDS) ?? join(coord, 'restock-swaps')
  const eveSwapRecords = nonBlank(env.EVE_SWAP_RECORDS) ?? join(brain, "recovery-swap-records")
  const allDirs = splitSwapRecordDirs(nonBlank(env.MAKER_SWAP_RECORD_DIRS) ?? [liveSwaps, restockSwaps, eveSwapRecords].join(','))
  return { coord, liveSwaps, restockSwaps, eveSwapRecords, allDirs }
}

/**
 * Read live swap records for an observational census. Unlike `list()`, this reader is deliberately
 * fail-closed: an unreadable directory or malformed record is evidence that the census is incomplete,
 * so it throws for the caller to surface as stale rather than silently omitting locked collateral.
 *
 * It performs no mkdir/write operation. Reconciliation must remain safe to run beside a live daemon.
 */
export interface SwapRecordCensusReadOptions {
  /**
   * Recovery-daemon escape hatch: report one unreadable/malformed record and continue reading its siblings.
   * Omit this callback for the reconciliation census, whose existing fail-closed whole-census behavior is
   * intentionally unchanged (an omitted lock must make the balance snapshot stale).
   */
  onRecordError?: (path: string, error: Error) => void
  /** Observe the exact source path and bounded source bytes of each successfully parsed record without re-reading it. */
  onRecord?: (record: SettlementRecord, path: string, source: string) => void
  /** Balance-census only: include compare-and-clear quarantine evidence without adopting or deleting it. */
  includeQuarantine?: boolean
}

export function readFileSwapRecordsForCensus(dir: string, opts: SwapRecordCensusReadOptions = {}): SettlementRecord[] {
  const files = readdirSync(dir)
  const records: SettlementRecord[] = []
  const paths = files.flatMap((file) => {
    if (file.endsWith('.json')) return [join(dir, file)]
    if (!opts.includeQuarantine || !file.startsWith(SWAP_CLEAR_QUARANTINE_PREFIX)) return []
    // A compare-and-clear crash can leave the sole verified record inside this directory. Census must observe it
    // without adopting/deleting anything (the writer owns adoption); tag it below so operations sees the ambiguity.
    return [join(dir, file, QUARANTINED_RECORD_NAME)]
  })
  for (const path of paths) {
    try {
      const source = readSettlementRecordFile(path)
      const record = JSON.parse(source) as SettlementRecord & { censusNeedsAttention?: true }
      if (path.includes(`${SWAP_CLEAR_QUARANTINE_PREFIX}`)) record.censusNeedsAttention = true
      records.push(record)
      opts.onRecord?.(record, path, source)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const wrapped = new Error(`swap-record census: cannot read ${path}: ${detail}`)
      if (!opts.onRecordError) throw wrapped
      opts.onRecordError(path, wrapped)
    }
  }
  return records
}

/**
 * File-backed {@link SwapRecordSink} for H5 crash-safety: one JSON file per LIVE swap under `dir`, named by swapId.
 * The record carries the pre-signed 2-of-2 refund (`bsvRefundTxHex`) — the only way to reclaim the BSV after a crash —
 * so a watchtower / restart can rebroadcast it at nLockTime (see `sessionFromRecordFile` + `makeBsvWatchtowerDeps`).
 *
 *  - `write()` is FAIL-CLOSED: atomic tmp+rename, and it THROWS on failure so the executor aborts BEFORE broadcasting
 *    a lock whose refund it couldn't persist (never create an unrecoverable lock).
 *  - `clear()` / `list()` are BEST-EFFORT: they never throw (a housekeeping failure must not break a swap's terminal).
 *  - The swapId is a SHA-256 hashHex; filenames are stripped to hex so a hostile intent can't traverse the path.
 */
export interface FileSwapRecordStoreOpts {
  /** Receives quarantine adoption/CRITICAL lines from `list()`. Defaults to console.error. */
  log?: (message: string) => void
  /** Test seams: deterministic race/crash injection inside compare-and-clear. Production omits them. */
  hooks?: { afterCompare?: (path: string) => void; afterQuarantineRename?: (quarantinedPath: string) => void }
  
  recordMode?: number
  /** Set false for a signer-private store that must not be made group-readable. */
  censusGroupRead?: boolean
}

/** `list()` never turns damaged recovery evidence into absence. */
export interface SwapRecordList {
  records: SettlementRecord[]
  /** The filename is retained because it is the hashlock for normal store files. */
  errors: Array<{ path: string; hashHex?: string; error: Error }>
}

/** Use at callers that cannot safely make progress with an incomplete recovery census. */
export function requireReadableSwapRecords(list: SwapRecordList): SettlementRecord[] {
  if (list.errors.length) throw new Error(`swap-record read failure: ${list.errors.map((entry) => `${entry.path}: ${entry.error.message}`).join('; ')}`)
  return list.records
}

/** Recovery keeps every readable sibling armed, while loudly retaining damaged evidence. */
export function readableSwapRecordsForRecovery(list: SwapRecordList, log: (message: string) => void, scope: string): SettlementRecord[] {
  for (const entry of list.errors) log(`CRITICAL ${scope}: cannot read swap record ${entry.path}: ${entry.error.message}`)
  return list.records
}

export function makeFileSwapRecordStore(dir: string, opts: FileSwapRecordStoreOpts = {}): SwapRecordSink & { list: () => SwapRecordList; pathFor: (swapId: string) => string } {
  mkdirSync(dir, { recursive: true })
  
  // this dir. Add group read+execute without disturbing owner/other/setgid bits; best-effort so a perm quirk on
  
  if (opts.censusGroupRead !== false) {
    try { chmodSync(dir, statSync(dir).mode | 0o050) } catch { /* census visibility only — never fatal */ }
  }
  const hexOnly = (s: string): string => s.replace(/[^0-9a-fA-F]/g, '') // neuter path traversal; a valid hash is unchanged
  const fileFor = (swapId: string): string => join(dir, `${hexOnly(swapId)}.json`)
  const fullToken = (value: unknown): string => {
    const canonical = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(canonical)
      if (typeof item === 'object' && item !== null) {
        return Object.fromEntries(Object.entries(item as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
      }
      return item
    }
    return JSON.stringify(canonical(value))
  }
  const compareAndClear = (path: string, expected: SettlementRecord): void => {
    // Recovery records remain durable until a terminal state is the exact generation being cleared. Refuse a
    // non-terminal expected value even when it happens to match the file byte-for-byte: cancellation/supersession is
    // not proof that the locked value has reached a terminal outcome.
    if (expected.state !== 'settled' && expected.state !== 'refunded' && expected.state !== 'aborted') return
    let fd: number | undefined
    let quarantineDir: string | undefined
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const opened = fstatSync(fd)
      const before = lstatSync(path)
      if (!opened.isFile() || !before.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
          opened.size > MAX_SETTLEMENT_RECORD_BYTES) return
      const current = JSON.parse(readFileSync(fd, { encoding: 'utf8' })) as SettlementRecord
      if (fullToken(current) !== fullToken(expected)) return
      opts.hooks?.afterCompare?.(path)
      quarantineDir = mkdtempSync(join(dirname(path), SWAP_CLEAR_QUARANTINE_PREFIX))
      chmodSync(quarantineDir, 0o700)
      const claimed = join(quarantineDir, QUARANTINED_RECORD_NAME)
      renameSync(path, claimed)
      opts.hooks?.afterQuarantineRename?.(claimed)
      const after = lstatSync(claimed)
      const held = fstatSync(fd)
      if (!after.isFile() || after.dev !== held.dev || after.ino !== held.ino ||
          held.dev !== opened.dev || held.ino !== opened.ino || held.size !== opened.size || held.mtimeMs !== opened.mtimeMs) {
        try { linkSync(claimed, path); unlinkSync(claimed) } catch { /* keep both generations; never delete ambiguity */ }
        return
      }
      unlinkSync(claimed)
      rmdirSync(quarantineDir)
      quarantineDir = undefined
    } catch { /* best-effort cleanup; a retained recovery record is the safe failure */ }
    finally {
      if (fd !== undefined) closeSync(fd)
      if (quarantineDir) {
        try { rmdirSync(quarantineDir) } catch { /* non-empty means ambiguous evidence was deliberately retained */ }
      }
    }
  }

  return {
    write(record: SettlementRecord): void {
      const path = fileFor(record.hashHex)
      // COLLISION GUARD (re-battery MED): swapId is the taker-chosen hashlock H; two live swaps can share H. If a record
      // already exists for this H with a DIFFERENT lock outpoint, refuse — overwriting would drop the first swap's refund
      // artifact and a crash would strand its BSV. write() is fail-closed, so the second same-H swap aborts pre-broadcast
      // rather than colliding. (The F5 registry rejects the different-PARAM case earlier; this catches the same-param one.)
      if (existsSync(path)) {
        // An unreadable, symlinked, oversized, or non-regular prior record is not permission to overwrite recovery
        // state. Throw before the new lock can be broadcast; an operator must resolve the ambiguous durable state.
        const existing = JSON.parse(readSettlementRecordFile(path)) as SettlementRecord
        if (existing?.bsvLockOutpoint && record.bsvLockOutpoint && existing.bsvLockOutpoint !== record.bsvLockOutpoint) {
          throw new Error(`swap-record: swapId ${record.hashHex.slice(0, 12)}… already has a live lock (${existing.bsvLockOutpoint.slice(0, 20)}…) ≠ this one (${record.bsvLockOutpoint.slice(0, 20)}…) — a reused hashlock; refusing to overwrite (fail-closed, no strand)`)
        }
      }

      // umask-masked, so chmod explicitly to guarantee group-read; best-effort so a perm failure never aborts this
      // fail-closed money write (the owner/watchtower still reads it for recovery regardless of group bits).
      writeSettlementRecordAtomically(path, JSON.stringify(record), opts.recordMode ?? 0o640, MAX_SETTLEMENT_RECORD_BYTES) // atomic replace — a crash mid-write leaves the prior record (or none) intact
    },
    clear(swapId: string, expected?: SettlementRecord): void {
      if (expected) compareAndClear(fileFor(swapId), expected)
      else try { rmSync(fileFor(swapId), { force: true }) } catch { /* best-effort — a lingering record is harmless (a spent lock can't be refunded) */ }
    },
    /** The on-disk path for a swapId — so an in-process recovery watchtower persists to the SAME file (no drift). */
    pathFor(swapId: string): string { return fileFor(swapId) },
    list(): SwapRecordList {
      // Adopt compare-and-clear leftovers first, so a live record stranded in a quarantine directory is listed in
      // this same call; ambiguous leftovers are kept and logged CRITICAL.
      const errors: SwapRecordList['errors'] = []
      try {
        const scan = adoptQuarantinedSwapRecords(dir, opts.log ?? console.error)
        for (const path of scan.critical) errors.push({ path, error: new Error('quarantined swap-record evidence retained; operator reconciliation required') })
      } catch (error) {
        errors.push({ path: dir, error: error instanceof Error ? error : new Error(String(error)) })
      }
      let files: string[]
      try { files = readdirSync(dir) } catch (error) {
        errors.push({ path: dir, error: error instanceof Error ? error : new Error(String(error)) })
        return { records: [], errors }
      }
      const out: SettlementRecord[] = []
      for (const f of files) {
        if (!f.endsWith('.json')) continue // skip .json.tmp and anything else
        const path = join(dir, f)
        try { out.push(JSON.parse(readSettlementRecordFile(path)) as SettlementRecord) } catch (error) {
          const hashHex = f.slice(0, -'.json'.length)
          errors.push({ path, hashHex: /^[0-9a-f]{64}$/i.test(hashHex) ? hashHex : undefined, error: error instanceof Error ? error : new Error(String(error)) })
        }
      }
      return { records: out, errors }
    },
  }
}
