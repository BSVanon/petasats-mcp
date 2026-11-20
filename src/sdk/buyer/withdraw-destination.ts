import { isAddress } from 'viem'
import { assertBuyerMainnetP2pkhAddress } from './runtime/address'
import { assertBaseDestination, assertBsvDestination, type BuyerLimits } from './limits'

/** The refusal for a Base destination that is not a non-zero checksummed address, or not a string at all. */
export const BASE_DESTINATION_FORMAT_REFUSAL = 'to must be a non-zero checksummed Base address'

/** The kit's own Base address, and the contracts it never withdraws to (the swap contract, the USDC token). */
export interface WithdrawDestinationRules { kitBaseAddress: string; forbiddenBase: readonly string[] }

/**
 * Every Base destination rule, on every call: the format, the limits file's baseDestinations, the kit's own address and
 * the forbidden contracts. A value that is not a string gets the format refusal. withdrawBase and close_kit both run it.
 */
export function assertBaseWithdrawDestination(rules: WithdrawDestinationRules, limits: BuyerLimits | undefined, base: unknown): void {
  if (typeof base !== 'string' || !isAddress(base, { strict: true }) || /^0x0{40}$/i.test(base)) throw new Error(BASE_DESTINATION_FORMAT_REFUSAL)
  assertBaseDestination(limits, base)
  if (base.toLowerCase() === rules.kitBaseAddress.toLowerCase()) throw new Error('cannot withdraw to the kit address')
  if (rules.forbiddenBase.some((address) => address.toLowerCase() === base.toLowerCase())) throw new Error('cannot withdraw to a swap or token contract')
}

/**
 * Every BSV destination rule, on every call: a mainnet P2PKH address (a value that is not a string gets that same
 * refusal), then the limits file's bsvDestinations. withdrawBsv and close_kit both run it.
 */
export function assertBsvWithdrawDestination(limits: BuyerLimits | undefined, bsv: unknown): void {
  const address = typeof bsv === 'string' ? bsv : '' // '' is never an address, so it gets the malformed-address refusal
  assertBuyerMainnetP2pkhAddress(address)
  assertBsvDestination(limits, address)
}
