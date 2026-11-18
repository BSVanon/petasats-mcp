import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_SETTLEMENT_RECORD_BYTES, syncNewEntry, writeSettlementRecordAtomically } from './atomic-record-write'
import { validateSettlementRecord, type SettlementRecord } from './settlement-session'
import { assertSameWatchtowerRecordIdentity } from './watchtower-record-identity'

const PUBLICATION_LATCH_STATES = new Set(['revealed', 'refunding', 'refunded', 'settled'])
const COVENANT_REFUND_EVIDENCE_STATES = new Set(['revealed', 'refunding', 'refunded'])

/** Recovery evidence is a monotonic disk invariant: an older writer may carry it forward, never erase or replace it. */
export function preserveInitiatorRecoveryEvidence(current: SettlementRecord, next: SettlementRecord): SettlementRecord {
  if (current.role !== 'initiator' || (!current.claimPublicationRefused && !current.bsvLockRefundEvidence)) return next
  assertSameWatchtowerRecordIdentity(current, next, 'initiator recovery evidence')
  if (next.role !== 'initiator' ||
      (current.claimPublicationRefused && !PUBLICATION_LATCH_STATES.has(next.state)) ||
      (current.bsvLockRefundEvidence && !COVENANT_REFUND_EVIDENCE_STATES.has(next.state))) {
    throw new Error('swap-record: stale replacement cannot preserve durable initiator recovery evidence; refusing overwrite')
  }
  if (current.bsvLockRefundEvidence && next.bsvLockRefundEvidence &&
      current.bsvLockRefundEvidence.spenderTxid.toLowerCase() !== next.bsvLockRefundEvidence.spenderTxid.toLowerCase()) {
    throw new Error('swap-record: replacement conflicts with durable BSV covenant-refund evidence; refusing overwrite')
  }
  return {
    ...next,
    ...(current.claimPublicationRefused ? { claimPublicationRefused: current.claimPublicationRefused } : {}),
    ...(current.bsvLockRefundEvidence ? { bsvLockRefundEvidence: current.bsvLockRefundEvidence } : {}),
  }
}

/**
 * Compare-and-replace one recovery record without ever overwriting a different swap tuple.
 *
 * `rename(path, claimed)` is the atomic compare point. The opened inode is checked again after that rename, and the
 * new generation is installed with `link`, whose EEXIST behavior cannot clobber a concurrent replacement. Ambiguous
 * generations remain in the owner-only claim directory rather than being deleted.
 */
export function persistWatchtowerRecordForIdentity(
  path: string,
  expectedIdentity: SettlementRecord,
  next: SettlementRecord,
  mode?: number,
): void {
  assertSameWatchtowerRecordIdentity(expectedIdentity, next, 'watchtower persist')
  const parent = dirname(path)
  const staged = join(parent, `.${randomUUID()}.watchtower-next`)

  let fd: number | undefined
  let claimDir: string | undefined
  let claimed: string | undefined
  let installed = false
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > MAX_SETTLEMENT_RECORD_BYTES) {
      throw new Error(`watchtower persist: ${path} is not a bounded regular record`)
    }
    const current = JSON.parse(readFileSync(fd, 'utf8')) as SettlementRecord
    validateSettlementRecord(current)
    assertSameWatchtowerRecordIdentity(expectedIdentity, current, 'watchtower persist')
    const preserved = preserveInitiatorRecoveryEvidence(current, next)
    if (preserved !== next) validateSettlementRecord(preserved)
    writeSettlementRecordAtomically(
      staged,
      JSON.stringify(preserved, null, 2),
      mode ?? (opened.mode & 0o777),
      MAX_SETTLEMENT_RECORD_BYTES,
    )

    claimDir = mkdtempSync(join(parent, '.watchtower-persist-'))
    claimed = join(claimDir, 'claimed-record')
    renameSync(path, claimed)
    const after = lstatSync(claimed)
    const held = fstatSync(fd)
    if (!after.isFile() || after.dev !== held.dev || after.ino !== held.ino ||
        held.dev !== opened.dev || held.ino !== opened.ino || held.size !== opened.size || held.mtimeMs !== opened.mtimeMs) {
      try { linkSync(claimed, path) } catch { /* a concurrent generation wins; retain both ambiguous inodes */ }
      throw new Error(`watchtower persist: ${path} changed before the atomic identity claim; refusing to overwrite it`)
    }

    // Atomic no-overwrite install. A concurrent creator makes this fail with EEXIST and its generation stays intact.
    linkSync(staged, path)
    installed = true
    unlinkSync(staged)
    unlinkSync(claimed)
    rmdirSync(claimDir)
    claimDir = undefined
    claimed = undefined

    syncNewEntry(path, { directoryFlags: constants.O_RDONLY | constants.O_DIRECTORY })
  } catch (error) {
    if (claimed) {
      try {
        linkSync(claimed, path)
        unlinkSync(claimed)
        if (claimDir) rmdirSync(claimDir)
        claimed = undefined
        claimDir = undefined
      } catch { /* retain ambiguous recovery evidence; never overwrite the pathname winner */ }
    }
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (!installed) {
      try { unlinkSync(staged) } catch { /* absent after a successful install */ }
    }
  }
}

/** Preserve the old adapter behavior outside strict recovery while centralizing strict compare-and-replace. */
export function persistWatchtowerAdapterRecord(
  path: string,
  identity: SettlementRecord,
  next: SettlementRecord,
  strict: boolean | undefined,
  mode?: number,
): void {
  if (strict) persistWatchtowerRecordForIdentity(path, identity, next, mode)
  else {
    let fd: number | undefined
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.size > MAX_SETTLEMENT_RECORD_BYTES) {
        throw new Error(`watchtower persist: ${path} is not a bounded regular record`)
      }
      const current = JSON.parse(readFileSync(fd, 'utf8')) as SettlementRecord
      if (current.role === 'initiator' && (current.claimPublicationRefused || current.bsvLockRefundEvidence)) {
        validateSettlementRecord(current)
        assertSameWatchtowerRecordIdentity(identity, current, 'watchtower persist')
        next = preserveInitiatorRecoveryEvidence(current, next)
        validateSettlementRecord(next)
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    finally { if (fd !== undefined) closeSync(fd) }
    writeSettlementRecordAtomically(path, JSON.stringify(next, null, 2), mode, MAX_SETTLEMENT_RECORD_BYTES)
  }
}
