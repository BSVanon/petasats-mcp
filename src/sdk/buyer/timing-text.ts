import { baseAvailableSecsForBlocks, baseBlocksForSecs, baseRequiredSecsForBlocks } from '../../bridge/base-block-time'
import {
  DEFAULT_INITIATOR_BASE_TIMELOCK_BLOCKS,
  DEFAULT_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS,
} from '../../bridge/initiator-timelocks'

/** Public buyer-kit timing values. Keep prose consumers tied to these rather than duplicating Base assumptions. */
export const BUYER_BASE_CONFIRMATION_BLOCKS = baseBlocksForSecs(12)
export const BUYER_BASE_CONFIRMATION_SECS = baseRequiredSecsForBlocks(BUYER_BASE_CONFIRMATION_BLOCKS)
export const BUYER_BASE_REFUND_BLOCKS = DEFAULT_INITIATOR_BASE_TIMELOCK_BLOCKS
export const BUYER_BASE_REFUND_HOURS = baseAvailableSecsForBlocks(BUYER_BASE_REFUND_BLOCKS) / 3600
export const BUYER_BASE_CLAIM_BUDGET_BLOCKS = DEFAULT_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS
export const BUYER_BASE_CLAIM_BUDGET_HOURS = baseRequiredSecsForBlocks(BUYER_BASE_CLAIM_BUDGET_BLOCKS) / 3600
