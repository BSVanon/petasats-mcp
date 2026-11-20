/**
 * The pure parts of buy_gas: one CoW Protocol sell order of exactly 0.50 USDC for native ETH on Base, paid to the
 * kit's own address, whose USDC allowance comes from an EIP-2612 permit carried as an appData pre-hook. No I/O.
 * Sources: CoW Protocol GPv2Order.sol and GPv2Settlement.sol (order type, uid, validTo), the order book OpenAPI and
 * the CoW SDK's getOrderToSign (fee model), the app-data v1.16.0 and hooks v0.2.0 schemas, and Circle's
 * FiatTokenV2_2 / EIP2612.sol (permit).
 */
import { concat, domainSeparator, encodeFunctionData, hashTypedData, isAddress, keccak256, numberToHex, parseSignature, stringToBytes, type Address, type Hex, type TypedDataDomain } from 'viem'
import { BASE_USDC } from '../../bridge/evm/base-tokens'

export const BASE_CHAIN_ID = 8453
export const COW_SETTLEMENT: Address = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
export const COW_VAULT_RELAYER: Address = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'
/** CoW Protocol's marker for the chain's own coin as a buy token: the order pays native ETH, not WETH. */
export const COW_NATIVE_ETH: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
export const COW_BASE_API = 'https://api.cow.fi/base/api/v1'
export const COW_ORDER_URL = 'https://explorer.cow.fi/base/orders/'

/** Exactly 0.50 USDC (6 decimals) per gas purchase; never more. */
export const GAS_TOPUP_SELL = 500_000n
export const GAS_TOPUP_SLIPPAGE_BPS = 200n
export const GAS_TOPUP_VALID_FOR_SECONDS = 1200
/** An order still unfilled this long after its validTo is final: the settlement contract refuses it after validTo. */
export const GAS_TOPUP_EXPIRY_GRACE_SECONDS = 120
/** The quoted ETH may not imply ETH above $20,000: 0.50 USD at $20,000 is 0.000025 ETH. */
export const GAS_TOPUP_MAX_ETH_USD = 20_000n
export const GAS_TOPUP_MIN_QUOTE_WEI = (GAS_TOPUP_SELL * 10n ** 18n) / (GAS_TOPUP_MAX_ETH_USD * 1_000_000n)
/**
 * At or above 0.00002 ETH the kit already has gas, and buy_gas refuses. Every fill the kit accepts pays at least
 * minusSlippage(GAS_TOPUP_MIN_QUOTE_WEI), 0.0000245 ETH, so the call after any fill refuses (tested).
 */
export const ALREADY_HAS_GAS_WEI = 20_000_000_000_000n
/** Gas the hooks trampoline forwards to the permit call: a fresh kit's first permit measured about 72,030. */
export const PERMIT_HOOK_GAS_LIMIT = '100000'
/** The order's validTo, and so its permit deadline, is at most the local clock plus 25 minutes. */
export const GAS_TOPUP_MAX_AHEAD_SECONDS = 1500
/** A Base block time further than 10 minutes from the local clock refuses before anything is signed. */
export const GAS_TOPUP_MAX_CLOCK_SKEW_SECONDS = 600
export const GAS_TOPUP_APP_CODE = 'petasats-mcp'
export const APP_DATA_VERSION = '1.16.0'
export const HOOKS_VERSION = '0.2.0'
const UINT32_MAX = 0xffff_ffff
const ZERO_WORD: Hex = `0x${'0'.repeat(64)}`

export const USDC_PERMIT_DOMAIN = { name: 'USD Coin', version: '2', chainId: BASE_CHAIN_ID, verifyingContract: BASE_USDC } as const
export const COW_ORDER_DOMAIN = { name: 'Gnosis Protocol', version: 'v2', chainId: BASE_CHAIN_ID, verifyingContract: COW_SETTLEMENT } as const
export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const
export const ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' }, { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' }, { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' }, { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' },
  ],
} as const
const PERMIT_ABI = [{
  type: 'function', name: 'permit', stateMutability: 'nonpayable', outputs: [],
  inputs: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
  ],
}] as const

export interface GasPermit { owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint }
export interface GasOrder {
  sellToken: Address; buyToken: Address; receiver: Address
  sellAmount: bigint; buyAmount: bigint; validTo: number; appData: Hex; feeAmount: bigint
  kind: string; partiallyFillable: boolean; sellTokenBalance: string; buyTokenBalance: string
}
export interface GasAppData { json: string; hash: Hex }
/** What the quote and the chain fixed before anything is signed; every signed field is checked against it. */
export interface GasSigningPlan { owner: Address; nonce: bigint; validTo: number; quoteBuyAmount: bigint }
export interface CowQuoteResponse {
  quote?: { sellToken?: unknown; buyToken?: unknown; receiver?: unknown; sellAmount?: unknown; buyAmount?: unknown; feeAmount?: unknown; kind?: unknown }
  from?: unknown
  id?: unknown
  verified?: unknown
}

const sameAddress = (value: unknown, expected: Address): boolean =>
  typeof value === 'string' && isAddress(value, { strict: false }) && value.toLowerCase() === expected.toLowerCase()
const amount = (value: unknown): bigint | undefined =>
  typeof value === 'string' && /^(?:0|[1-9]\d{0,77})$/.test(value) ? BigInt(value) : undefined

/** The USDC EIP-712 domain separator the kit signs permits for; compared with the token's own DOMAIN_SEPARATOR(). */
export function usdcDomainSeparator(): Hex {
  return domainSeparator({ domain: USDC_PERMIT_DOMAIN })
}

export function minusSlippage(buyAmount: bigint): bigint {
  return buyAmount - (buyAmount * GAS_TOPUP_SLIPPAGE_BPS) / 10_000n
}

export function buildGasPermit(owner: Address, nonce: bigint, validTo: number): GasPermit {
  return { owner, spender: COW_VAULT_RELAYER, value: GAS_TOPUP_SELL, nonce, deadline: BigInt(validTo) }
}

/** The hook's call: USDC.permit(owner, spender, value, deadline, v, r, s) with the kit's permit signature. */
export function permitCallData(permit: GasPermit, signature: Hex): Hex {
  const parsed = parseSignature(signature)
  const v = parsed.v !== undefined ? Number(parsed.v) : parsed.yParity + 27
  return encodeFunctionData({ abi: PERMIT_ABI, functionName: 'permit', args: [permit.owner, permit.spender, permit.value, permit.deadline, v, parsed.r, parsed.s] })
}

/** The quote's hook: the same call with zero r and s, which never passes the permit check. A quote signs nothing. */
export function placeholderPermitCallData(permit: GasPermit): Hex {
  return encodeFunctionData({ abi: PERMIT_ABI, functionName: 'permit', args: [permit.owner, permit.spender, permit.value, permit.deadline, 27, ZERO_WORD, ZERO_WORD] })
}

/** The appData hash is keccak256 of the exact UTF-8 bytes of the JSON string sent with the order. */
export function hashAppData(json: string): GasAppData {
  return { json, hash: keccak256(stringToBytes(json)) }
}

/** appData with one pre-hook. Keys are in sorted order, as the CoW SDK writes them; the hash covers these exact bytes. */
export function buildGasAppData(permitCall: Hex): GasAppData {
  return hashAppData(JSON.stringify({
    appCode: GAS_TOPUP_APP_CODE,
    metadata: { hooks: { pre: [{ callData: permitCall, gasLimit: PERMIT_HOOK_GAS_LIMIT, target: BASE_USDC }], version: HOOKS_VERSION } },
    version: APP_DATA_VERSION,
  }))
}

export function buildGasOrder(input: { owner: Address; buyAmount: bigint; validTo: number; appDataHash: Hex }): GasOrder {
  return {
    sellToken: BASE_USDC, buyToken: COW_NATIVE_ETH, receiver: input.owner,
    sellAmount: GAS_TOPUP_SELL, buyAmount: input.buyAmount, validTo: input.validTo, appData: input.appDataHash,
    feeAmount: 0n, kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
  }
}

export function orderDigest(order: GasOrder, domain: TypedDataDomain = COW_ORDER_DOMAIN): Hex {
  return hashTypedData({ domain, types: ORDER_TYPES, primaryType: 'Order', message: order })
}

/** The order uid: the order digest (32 bytes), the owner (20 bytes), then validTo as a big-endian uint32 (4 bytes). */
export function orderUid(order: GasOrder, owner: Address, domain: TypedDataDomain = COW_ORDER_DOMAIN): Hex {
  return concat([orderDigest(order, domain), owner, numberToHex(order.validTo, { size: 4 })]).toLowerCase() as Hex
}

export function quoteRequestBody(owner: Address, validTo: number, appData: GasAppData): Record<string, unknown> {
  return {
    from: owner, sellToken: BASE_USDC, buyToken: COW_NATIVE_ETH, receiver: owner, validTo,
    appData: appData.json, appDataHash: appData.hash, priceQuality: 'verified', signingScheme: 'eip712',
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', kind: 'sell', sellAmountBeforeFee: GAS_TOPUP_SELL.toString(),
  }
}

export function orderCreationBody(order: GasOrder, owner: Address, signature: Hex, appData: GasAppData, quoteId?: number): Record<string, unknown> {
  return {
    sellToken: order.sellToken, buyToken: order.buyToken, receiver: order.receiver,
    sellAmount: order.sellAmount.toString(), buyAmount: order.buyAmount.toString(), validTo: order.validTo,
    feeAmount: order.feeAmount.toString(), kind: order.kind, partiallyFillable: order.partiallyFillable,
    sellTokenBalance: order.sellTokenBalance, buyTokenBalance: order.buyTokenBalance,
    signingScheme: 'eip712', signature, from: owner, appData: appData.json, appDataHash: appData.hash,
    ...(quoteId === undefined ? {} : { quoteId }),
  }
}

/** Refuse any quote that is not a sell of exactly 0.50 USDC for native ETH paid to the kit at a believable price. */
export function checkGasQuote(response: CowQuoteResponse, owner: Address): { buyAmount: bigint; quoteId?: number } {
  const quote = response?.quote
  if (!quote || typeof quote !== 'object') throw new Error('the quote has no order in it')
  if (!sameAddress(quote.sellToken, BASE_USDC)) throw new Error('the quote sells a token other than Base USDC')
  if (!sameAddress(quote.buyToken, COW_NATIVE_ETH)) throw new Error('the quote does not buy native ETH')
  if (quote.receiver !== undefined && quote.receiver !== null && !sameAddress(quote.receiver, owner)) throw new Error("the quote pays an address other than the kit's")
  if (response.from !== undefined && !sameAddress(response.from, owner)) throw new Error('the quote is for another address')
  if (quote.kind !== 'sell') throw new Error('the quote is not a sell order')
  const sell = amount(quote.sellAmount); const fee = amount(quote.feeAmount); const buy = amount(quote.buyAmount)
  if (sell === undefined || fee === undefined || buy === undefined) throw new Error('the quote amounts are not whole numbers')
  if (sell + fee !== GAS_TOPUP_SELL) throw new Error('the quote is not for exactly 0.50 USDC')
  if (buy === 0n) throw new Error('the quote buys no ETH')
  if (buy < GAS_TOPUP_MIN_QUOTE_WEI) throw new Error('the quote prices ETH above $20,000')
  // The record check's own rule (gas-topup-state.ts), so a kept id never makes the saved record unreadable.
  return { buyAmount: buy, ...(typeof response.id === 'number' && Number.isSafeInteger(response.id) && response.id >= 0 ? { quoteId: response.id } : {}) }
}

function refuseField(field: string): never {
  throw new Error(`the gas order failed its ${field} check; nothing was signed`)
}

/** Every permit field, checked before the permit is signed. */
export function assertSignablePermit(permit: GasPermit, plan: GasSigningPlan): void {
  if (!sameAddress(permit.owner, plan.owner)) refuseField('permit owner')
  if (!sameAddress(permit.spender, COW_VAULT_RELAYER)) refuseField('permit spender')
  if (permit.value !== GAS_TOPUP_SELL) refuseField('permit value')
  if (permit.nonce !== plan.nonce) refuseField('permit nonce')
  if (permit.deadline !== BigInt(plan.validTo)) refuseField('permit deadline')
}

/** Every order field, checked before the order is signed; the appData must be exactly this permit's hook. */
export function assertSignableOrder(order: GasOrder, plan: GasSigningPlan, appData: GasAppData, permit: GasPermit, permitSignature: Hex): void {
  if (!sameAddress(order.sellToken, BASE_USDC)) refuseField('sellToken')
  if (!sameAddress(order.buyToken, COW_NATIVE_ETH)) refuseField('buyToken')
  if (!sameAddress(order.receiver, plan.owner)) refuseField('receiver')
  if (order.sellAmount !== GAS_TOPUP_SELL) refuseField('sellAmount')
  if (order.buyAmount !== minusSlippage(plan.quoteBuyAmount) || order.buyAmount < minusSlippage(GAS_TOPUP_MIN_QUOTE_WEI)) refuseField('buyAmount')
  if (order.validTo !== plan.validTo || !Number.isSafeInteger(order.validTo) || order.validTo < 1 || order.validTo > UINT32_MAX) refuseField('validTo')
  if (order.feeAmount !== 0n) refuseField('feeAmount')
  if (order.kind !== 'sell') refuseField('kind')
  if (order.partiallyFillable !== false) refuseField('partiallyFillable')
  if (order.sellTokenBalance !== 'erc20') refuseField('sellTokenBalance')
  if (order.buyTokenBalance !== 'erc20') refuseField('buyTokenBalance')
  const expected = buildGasAppData(permitCallData(permit, permitSignature))
  if (appData.json !== expected.json || appData.hash !== expected.hash || order.appData !== expected.hash) refuseField('appData')
}
