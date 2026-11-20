/** The buy_gas tool: its TOOLS entry and its result mapping, kept out of server.ts to stay within its line cap. */

import { BUY_GAS_HINT, type CloseKitStep, type GasTopUpStep } from 'petasats/sdk'
import { success } from './validate.js'

export const BUY_GAS_TOOL = {
  name: 'buy_gas',
  title: 'Buy ETH for gas with 0.50 USDC',
  description: "Buy a little ETH for Base gas with exactly 0.50 USDC from this kit's own balance, so a kit funded with USDC alone can swap and withdraw. This moves the user's funds: call it only after the user says yes, and tell them the 0.50 USDC comes out of their balance. Each yes covers one purchase. It signs one CoW Protocol order that sells 0.50 USDC for ETH paid to this kit's own Base address; a CoW Protocol solver settles it and pays the network fee, so it works with no ETH in the kit. Refused when the kit already has gas (0.00002 ETH or more), holds less than 0.50 USDC, or spending is stopped. While a Base withdrawal or swap lock is still being confirmed, it is refused for 30 s; call it again then. Each call returns within about a minute; while state is 'pending', call it again after call_again_after_seconds, and call again whenever a result asks you to. Once state is 'filled' or 'expired', or 'rejected' with sold 'nothing', that purchase is over: report it, and ask the user again before another. Calling again never places a new order while an earlier one could still fill. Returns state ('pending', 'filled', 'expired', 'rejected' or 'refused'), with uid, order_url, sold, min_eth and, once filled, eth_received when it is known; or reason.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: { type: 'object' as const, properties: {}, required: [] },
}

/** buy_gas's wire shape already matches GasTopUpStep field-for-field; no renaming needed. */
export function buyGasToolResult(step: GasTopUpStep): ReturnType<typeof success> {
  return success(step)
}

/**
 * The kit's refusal of a USDC send with no ETH, and of a refused withdrawal it has no ETH to cancel. The kit keeps
 * these exact texts, which close_kit counts as refusals only the user can clear; withdraw_base, close_kit and the CLI
 * close add the buy_gas hint to what the user and the AI app see.
 */
const ETH_NEEDED = 'ETH is needed for Base gas'
const CANNOT_PAY_TO_CANCEL = 'the account cannot pay the gas to cancel '
const CANCEL_HINT = ` To add ETH: ${BUY_GAS_HINT}.`
export function rethrowWithGasHint(error: unknown): never {
  if (error instanceof Error && error.message.startsWith(CANNOT_PAY_TO_CANCEL)) throw new Error(`${error.message}${CANCEL_HINT}`)
  throw error instanceof Error && error.message === ETH_NEEDED ? new Error(`${ETH_NEEDED}; ${BUY_GAS_HINT}`) : error
}
export function closeStepWithGasHint(step: CloseKitStep): CloseKitStep {
  if (step.state === 'refused' && step.reason.startsWith(CANNOT_PAY_TO_CANCEL)) return { ...step, reason: `${step.reason}${CANCEL_HINT}` }
  return step.state === 'refused' && step.reason === ETH_NEEDED ? { ...step, reason: `${ETH_NEEDED}; ${BUY_GAS_HINT}` } : step
}
