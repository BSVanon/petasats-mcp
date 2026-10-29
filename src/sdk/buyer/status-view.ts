import type { BuyerSwapRecord } from './types'
import { MIN_REVEAL_CONFIRM_BUDGET_BLOCKS } from '../../bridge/responder-ordering'

const stages: Record<string, { label: string; step: number | null }> = {
  quoted: { label: 'Quote saved', step: 1 }, admitted: { label: 'Admitted', step: 2 },
  usdc_locked: { label: 'USDC locked', step: 3 }, waiting_bsv_lock: { label: 'Waiting for BSV lock', step: 3 },
  bsv_lock_confirming: { label: 'Confirming BSV lock', step: 4 }, claiming: { label: 'Claiming BSV', step: 5 },
  claimed: { label: 'BSV claimed', step: 6 }, settled: { label: 'BSV received', step: 7 },
  sweeping: { label: 'Delivering BSV', step: 7 }, delivered: { label: 'BSV delivered', step: 8 },
  refund_waiting: { label: 'Waiting to refund USDC', step: null }, refunded: { label: 'USDC refunded', step: null },
  failed: { label: 'Failed before funds were locked', step: null }, needs_attention: { label: 'Needs attention', step: null },
}
const bsv = (id?: string): string | undefined => id ? `https://whatsonchain.com/tx/${id}` : undefined
const base = (id?: string): string | undefined => id ? `https://basescan.org/tx/${id}` : undefined

export function buyerStatusView(record: BuyerSwapRecord): Record<string, unknown> {
  const info = stages[record.stage] ?? { label: 'Older or unknown record', step: null }
  const delivery = !!record.deliverTo
  const terminal = ['settled', 'delivered', 'refunded', 'failed'].includes(record.stage)
  const unknown = !(record.stage in stages)
  const lockTxid = record.bsvLockOutpoint?.split('_')[0] ?? record.bsvLockTxid
  return {
    swap_id: record.swapId, stage: unknown ? 'needs_attention' : record.stage, stage_label: info.label,
    step: info.step, steps_total: delivery ? 8 : 7, done: terminal,
    outcome: record.stage === 'delivered' ? 'delivered' : record.stage === 'settled' ? 'settled' : record.stage === 'refunded' ? 'refunded' : record.stage === 'failed' ? 'failed' : null,
    needs_attention: unknown || record.stage === 'needs_attention',
    what_to_do: unknown ? 'This is an older or unknown record; recovery will update it.' : record.stage === 'needs_attention' ? 'Run recovery and keep the kit available.' : null,
    usdc_in: record.amountIn, bsv_quoted: record.quote?.bsvSats?.toString(),
    // The payout counts as received once the claim is settled; before that it is only the pending claim amount.
    ...(record.bsvClaimPayoutSats === undefined ? {} : ['settled', 'sweeping', 'delivered'].includes(record.stage)
      ? { bsv_received: record.bsvClaimPayoutSats.toString() } : { bsv_claim_payout_sats: record.bsvClaimPayoutSats.toString() }),
    ...(record.stage === 'delivered' && record.sweepOutbox?.sats !== undefined ? { bsv_delivered_sats: record.sweepOutbox.sats } : {}),
    deliver_to: record.deliverTo, eta_minutes: terminal ? 0 : 15, eta_note: 'BSV block times vary.', check_again_in_seconds: terminal ? null : 30,
    deadlines: {
      claim_bsv_by: record.bsvRefundLocktime === undefined ? undefined : { bsv_block: record.bsvRefundLocktime - MIN_REVEAL_CONFIRM_BUDGET_BLOCKS },
      usdc_refund_after: record.baseTimelockBlock === undefined ? undefined : { base_block: record.baseTimelockBlock },
      note: 'block heights; a BSV block takes about 10 minutes, a Base block about 2 seconds',
    },
    txids: { base_lock: record.baseLockTxid ? { txid: record.baseLockTxid, url: base(record.baseLockTxid) } : undefined, base_refund: record.baseRefundTxid ? { txid: record.baseRefundTxid, url: base(record.baseRefundTxid) } : undefined, bsv_lock: lockTxid ? { txid: lockTxid, url: bsv(lockTxid) } : undefined, bsv_claim: record.bsvClaimTxid ? { txid: record.bsvClaimTxid, url: bsv(record.bsvClaimTxid) } : undefined, bsv_delivery: record.sweepOutbox ? { txid: record.sweepOutbox.txid, url: bsv(record.sweepOutbox.txid) } : undefined },
    reason: record.reason, created_at: new Date(record.createdAtMs).toISOString(), updated_at: new Date(record.updatedAtMs).toISOString(),
  }
}
