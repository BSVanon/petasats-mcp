export const DEFAULT_INITIATOR_BASE_TIMELOCK_BLOCKS = 28_800 // ~16h at 2s/block
export const DEFAULT_INITIATOR_BSV_REFUND_BLOCKS = 24 // maximum accepted responder window; ~4h mean
export const DEFAULT_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS = 3_600 // ~2h at 2s/block

export interface InitiatorTimelockDefaults {
  baseTimelockBlocks: number
  bsvRefundBlocks: number
  claimBudgetBaseBlocks: number
}

/** A fresh copy prevents callers from mutating a process-global default tuple. */
export function defaultInitiatorTimelocks(): InitiatorTimelockDefaults {
  return {
    baseTimelockBlocks: DEFAULT_INITIATOR_BASE_TIMELOCK_BLOCKS,
    bsvRefundBlocks: DEFAULT_INITIATOR_BSV_REFUND_BLOCKS,
    claimBudgetBaseBlocks: DEFAULT_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS,
  }
}
