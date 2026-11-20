/**
 * The kit's wait before buy_gas signs a new order: it never signs while a Base withdrawal is unresolved or a swap's
 * Base approve or lock can still be sent. It never waits for a swap that is only waiting (gas for a refund stays
 * available), and it never reads limits.json, so a bad limits file never blocks buying gas.
 */
import { MAX_CANCELS } from './withdrawal-intent'
import type { BuyerStore, BuyerWithdrawalIntents } from './types'

/** The approved refusal for a wait that clears by itself. */
export const GAS_TOPUP_BASE_BUSY_MESSAGE = 'a Base withdrawal or swap lock is still being confirmed; nothing was signed; call buy_gas again in 30 s'

/** Swap stages whose Base approve and lock can no longer be sent: buy_gas never waits for them. */
const NEVER_WAITS = new Set([
  'waiting_bsv_lock', 'bsv_lock_confirming', 'claiming', 'claimed', 'settled', 'sweeping', 'refund_waiting', 'delivered', 'refunded', 'failed',
])
/** The unaffordable-cancel state: buying gas is its way out, so it never refuses buy_gas. Group 1 is its withdrawal. */
const UNAFFORDABLE_CANCEL = /^the account cannot pay the gas to cancel the refused withdrawal (0x[0-9a-fA-F]{64})\./

/** A swap whose approve or lock can still go out: quoted, admitted, a stage this kit does not know, or created. */
function lockCanStillBeSent(record: { stage: string; settlementState?: string }): boolean {
  if (NEVER_WAITS.has(record.stage)) return false
  if (record.stage === 'usdc_locked' || record.stage === 'needs_attention') return record.settlementState === 'created'
  return true
}

/** A state waiting never clears: only the user can (the consumed-nonce warning carries needsOperator). */
function needsTheUser(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return (typeof error === 'object' && error !== null && (error as { needsOperator?: unknown }).needsOperator === true)
    || text.includes(`could not be cancelled after ${MAX_CANCELS} attempts`) || text.includes('cannot cancel')
}

async function assertNoUnresolvedWithdrawal(intents: BuyerWithdrawalIntents | undefined): Promise<void> {
  if (!intents) return
  intents.list?.() // a withdrawal record that cannot be read refuses with its own message
  let unaffordable: string | undefined
  try {
    await intents.reconcile()
  } catch (error) {
    if (needsTheUser(error)) throw error
    const match = UNAFFORDABLE_CANCEL.exec(error instanceof Error ? error.message : String(error))
    if (!match) throw new Error(GAS_TOPUP_BASE_BUSY_MESSAGE)
    unaffordable = match[1].toLowerCase()
  }
  // The records back up reconcile's answer: any other withdrawal not yet done still waits.
  if (intents.list?.().some((record) => record.state !== 'done' && record.hash.toLowerCase() !== unaffordable)) throw new Error(GAS_TOPUP_BASE_BUSY_MESSAGE)
}

/** Throws the refusal buy_gas gives, or resolves when a new gas order may be signed. */
export async function assertBuyGasMayStart(deps: { withdrawalIntents?: BuyerWithdrawalIntents; store: BuyerStore }): Promise<void> {
  await assertNoUnresolvedWithdrawal(deps.withdrawalIntents)
  if ((await deps.store.list()).some(lockCanStillBeSent)) throw new Error(GAS_TOPUP_BASE_BUSY_MESSAGE)
}
