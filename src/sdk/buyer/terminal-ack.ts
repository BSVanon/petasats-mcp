import type { SettlementRecord, SettlementState } from '../../bridge/settlement-session'
import type { RecoverySupervisor } from '../../bridge/in-process-recovery'
import { DEFAULT_BSV_FINALITY_CONFIRMATIONS, hasPersistedBsvClaimArtifact } from '../../bridge/watchtower'
import { makeFileSwapRecordStore } from '../../market-maker/swap-record-store'
import type { BuyerSwapRecord } from './types'
import { UNLANDED_LOCK_ABORT_REASON } from './unlanded-lock'

const terminalSettlement = (state: SettlementState): boolean => state === 'settled' || state === 'refunded' || state === 'aborted'

export function makeTerminalAcknowledgement(deps: {
  records: ReturnType<typeof makeFileSwapRecordStore>
  recovery: RecoverySupervisor
  claimIsBuried?: (txid: string, confirmations: number) => Promise<boolean>
}): {
  acknowledgeTerminalRecord: (buyer: BuyerSwapRecord) => Promise<boolean>
  acknowledgedTerminalTokens: Map<string, string>
} {
  const { records, recovery, claimIsBuried } = deps
  // A validated terminal generation may survive a best-effort compare-and-clear
  // failure. Remember it for this process so later passes retry deletion without
  // re-running its chain watcher or weakening the proof that preceded deletion.
  const acknowledgedTerminalTokens = new Map<string, string>()
  const terminalAcknowledgements = new Map<string, Promise<boolean>>()
  const terminalArtifactsMatch = (buyer: BuyerSwapRecord, settlement: SettlementRecord): boolean =>
    settlement.state === buyer.settlementState &&
    settlement.baseLockTxHash === buyer.baseLockTxid &&
    settlement.refundTxid === buyer.baseRefundTxid &&
    settlement.bsvClaimTxid === buyer.bsvClaimTxid
  const acknowledgeTerminalRecord = async (buyer: BuyerSwapRecord): Promise<boolean> => {
    if (!buyer.settlementHashHex || !buyer.settlementState || !terminalSettlement(buyer.settlementState)) return false
    const inflightKey = buyer.settlementHashHex.toLowerCase()
    const inflight = terminalAcknowledgements.get(inflightKey)
    if (inflight) return inflight
    const task = (async (): Promise<boolean> => {
      const listed = records.list()
      const settlement = listed.records.find((item) => item.hashHex.toLowerCase() === inflightKey)
      if (!settlement || !terminalArtifactsMatch(buyer, settlement)) return false
      // A never-landed lock's tombstone stays on disk: it keeps the exact tuple, so a lock that still landed after the
      if (settlement.abortReason === UNLANDED_LOCK_ABORT_REASON) return false
      const token = JSON.stringify(settlement)
      if (acknowledgedTerminalTokens.get(inflightKey) !== token) {
        // The executor considers one SPV-proven confirmation sufficient for delivery, but the raw/BEEF claim is still
        // the reorg/re-broadcast backstop until the recovery finality depth. Keep that artifact durable across restarts.
        if (settlement.state === 'settled' && hasPersistedBsvClaimArtifact(settlement)) {
          if (!claimIsBuried || !settlement.bsvClaimTxid) return false
          try { if (!await claimIsBuried(settlement.bsvClaimTxid, DEFAULT_BSV_FINALITY_CONFIRMATIONS)) return false } catch { return false }
        }
        acknowledgedTerminalTokens.set(inflightKey, token)
      }
      // Fence a watcher that was armed by an earlier/concurrent pass before its
      // old revealed snapshot can recreate the acknowledged terminal file.
      recovery.cancelRecord?.(settlement, 'buyer terminal row acknowledged')
      const latest = records.list().records.find((item) => item.hashHex.toLowerCase() === inflightKey)
      if (!latest) return true
      if (!terminalArtifactsMatch(buyer, latest)) return false
      const latestToken = JSON.stringify(latest)
      // A watcher may have refreshed only the terminal history while the proof
      // read was in flight. The exact terminal artifacts remain the proof subject.
      if (latest.bsvClaimTxid !== settlement.bsvClaimTxid || latest.state !== settlement.state) return false
      acknowledgedTerminalTokens.set(inflightKey, latestToken)
      records.clear(latest.hashHex, latest)
      return true
    })()
    terminalAcknowledgements.set(inflightKey, task)
    try { return await task } finally {
      if (terminalAcknowledgements.get(inflightKey) === task) terminalAcknowledgements.delete(inflightKey)
    }
  }
  return { acknowledgeTerminalRecord, acknowledgedTerminalTokens }
}
