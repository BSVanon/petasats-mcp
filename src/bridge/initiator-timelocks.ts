import { baseBlocksForSecs } from './base-block-time'
import { checkResponderRunwayAndOrdering, MAX_RESPONDER_WINDOW_BLOCKS } from './responder-ordering'

export const INITIATOR_BASE_TIMELOCK_TARGET_SECS = 16 * 60 * 60
export const INITIATOR_CLAIM_BUDGET_TARGET_SECS = 2 * 60 * 60
export const MIN_INITIATOR_CLAIM_BUDGET_SECS = 15 * 60

export const DEFAULT_INITIATOR_BASE_TIMELOCK_BLOCKS = baseBlocksForSecs(INITIATOR_BASE_TIMELOCK_TARGET_SECS)
export const DEFAULT_INITIATOR_BSV_REFUND_BLOCKS = 24 // maximum accepted responder window; ~4h mean
export const DEFAULT_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS = baseBlocksForSecs(INITIATOR_CLAIM_BUDGET_TARGET_SECS)
export const MIN_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS = baseBlocksForSecs(MIN_INITIATOR_CLAIM_BUDGET_SECS)

export interface InitiatorTimelockDefaults {
  baseTimelockBlocks: number
  bsvRefundBlocks: number
  claimBudgetBaseBlocks: number
}

export interface InitiatorTimelockSettingNames {
  baseTimelock: string
  claimBudget: string
}

/** Fail at startup on a setting that cannot satisfy the configured responder window (or the shared maximum by default). */
export function assertInitiatorTimelocks(
  values: Pick<InitiatorTimelockDefaults, 'baseTimelockBlocks' | 'claimBudgetBaseBlocks'> & Partial<Pick<InitiatorTimelockDefaults, 'bsvRefundBlocks'>>,
  names: InitiatorTimelockSettingNames = { baseTimelock: 'baseTimelockBlocks', claimBudget: 'claimBudgetBaseBlocks' },
): void {
  if (!Number.isSafeInteger(values.claimBudgetBaseBlocks) || values.claimBudgetBaseBlocks < MIN_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS) {
    throw new Error(
      `${names.claimBudget} must be a safe integer of at least ${MIN_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS} Base blocks (${MIN_INITIATOR_CLAIM_BUDGET_SECS / 60} minutes at the supported floor); got ${String(values.claimBudgetBaseBlocks)}`,
    )
  }
  if (!Number.isSafeInteger(values.baseTimelockBlocks) || values.baseTimelockBlocks <= 0) {
    throw new Error(`${names.baseTimelock} must be a positive safe integer; got ${String(values.baseTimelockBlocks)}`)
  }
  const responderWindow = values.bsvRefundBlocks ?? MAX_RESPONDER_WINDOW_BLOCKS
  if (!Number.isSafeInteger(responderWindow) || responderWindow < 1 || responderWindow > MAX_RESPONDER_WINDOW_BLOCKS) {
    throw new Error(`bsvRefundBlocks must be a safe integer in [1, ${MAX_RESPONDER_WINDOW_BLOCKS}] when set; got ${String(responderWindow)}`)
  }
  const result = checkResponderRunwayAndOrdering({
    bsvRefundLocktime: responderWindow,
    baseTimelockBlock: values.baseTimelockBlocks,
    claimBudgetBaseBlocks: values.claimBudgetBaseBlocks,
  }, { bsvHeight: 0, baseHeight: 0 })
  if (!result.ok) {
    throw new Error(
      `${names.baseTimelock}=${values.baseTimelockBlocks} cannot pass the responder gate at the configured BSV window (${responderWindow} blocks) with ${names.claimBudget}=${values.claimBudgetBaseBlocks}: ${result.reason}`,
    )
  }
}

/** A fresh copy prevents callers from mutating a process-global default tuple. */
export function defaultInitiatorTimelocks(): InitiatorTimelockDefaults {
  return {
    baseTimelockBlocks: DEFAULT_INITIATOR_BASE_TIMELOCK_BLOCKS,
    bsvRefundBlocks: DEFAULT_INITIATOR_BSV_REFUND_BLOCKS,
    claimBudgetBaseBlocks: DEFAULT_INITIATOR_CLAIM_BUDGET_BASE_BLOCKS,
  }
}
