import { baseAvailableSecsForBlocks, baseBlocksForSecs, baseRequiredSecsForBlocks } from '../../bridge/base-block-time'
import {
  DEFAULT_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS,
  type InitiatorTimelockDefaults,
} from '../../bridge/initiator-timelocks'
import { CROSS_CHAIN_MARGIN_SECS, bsvRefundGammaUpperBoundSecs } from '../../bridge/responder-ordering'

/** Public buyer-kit timing values. Keep prose consumers tied to these rather than duplicating Base assumptions. */
export const BUYER_BASE_CONFIRMATION_BLOCKS = baseBlocksForSecs(12)
export const BUYER_BASE_CONFIRMATION_SECS = baseRequiredSecsForBlocks(BUYER_BASE_CONFIRMATION_BLOCKS)
/** The buyer is the short-window initiator; other initiators retain their shared 24-block default. */
export const BUYER_BSV_REFUND_BLOCKS = 12
export const BUYER_BASE_REFUND_MIN_SECS = bsvRefundGammaUpperBoundSecs(BUYER_BSV_REFUND_BLOCKS) + CROSS_CHAIN_MARGIN_SECS + 2 * 60 * 60
export const BUYER_BASE_REFUND_TARGET_SECS = 10 * 60 * 60
export const BUYER_BASE_REFUND_BLOCKS = baseBlocksForSecs(BUYER_BASE_REFUND_TARGET_SECS)
export const BUYER_BASE_REFUND_HOURS = baseAvailableSecsForBlocks(BUYER_BASE_REFUND_BLOCKS) / 3600
export const BUYER_BASE_CLAIM_BUDGET_BLOCKS = DEFAULT_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS
export const BUYER_BASE_CLAIM_BUDGET_HOURS = baseRequiredSecsForBlocks(BUYER_BASE_CLAIM_BUDGET_BLOCKS) / 3600

export function defaultBuyerInitiatorTimelocks(): InitiatorTimelockDefaults {
  return {
    baseTimelockBlocks: BUYER_BASE_REFUND_BLOCKS,
    bsvRefundBlocks: BUYER_BSV_REFUND_BLOCKS,
    claimBudgetBaseBlocks: BUYER_BASE_CLAIM_BUDGET_BLOCKS,
  }
}
