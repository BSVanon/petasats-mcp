/**
 * close_kit and buy_gas. close never says closed while a gas order could still fill, whatever the USDC balance, and
 * it checks the gas record exactly as buy_gas does (gas-topup-state.ts's loadGasTopUp).
 */
import { GAS_TOPUP_WAIT_MESSAGE, GasTopUpUnreadableError, isOpenGasTopUp, loadGasTopUp } from './gas-topup-state'
import type { CloseSend } from './close-record'
import type { BuyerHome } from './local-state'
import type { BuyerKit } from './types'

export type CloseGasStep =
  | { state: 'in_progress'; did: string; next: string; call_again_after_seconds: number; sent: CloseSend[] }
  | { state: 'refused'; reason: string; sent: CloseSend[] }

/** The approved close wait while a gas order (buy_gas) could still take the USDC. */
export function gasWaitStep(sent: CloseSend[]): CloseGasStep {
  return { state: 'in_progress', did: 'nothing sent; a gas purchase (buy_gas) is still finishing and may use 0.50 USDC', next: 'call again; the USDC goes out once the gas order has filled or expired', call_again_after_seconds: 30, sent }
}

/**
 * The wait while a gas record still blocks, or undefined when none does. The kit first brings the record up to date
 * from the chain, in its money lock and so after any buy_gas call in flight. A record that fails its check refuses,
 * with no retry, in the gas-topup.json refusal's own words.
 */
export async function gasOrderWait(kit: BuyerKit, paths: BuyerHome, owner: string, sent: CloseSend[]): Promise<CloseGasStep | undefined> {
  try {
    await kit.assertNoOpenGasOrder?.()
    const record = loadGasTopUp(paths.home, owner)
    return record && isOpenGasTopUp(record) ? gasWaitStep(sent) : undefined
  } catch (error) {
    if (error instanceof GasTopUpUnreadableError) return { state: 'refused', reason: error.message, sent }
    if (error instanceof Error && error.message === GAS_TOPUP_WAIT_MESSAGE) return gasWaitStep(sent)
    throw error
  }
}
