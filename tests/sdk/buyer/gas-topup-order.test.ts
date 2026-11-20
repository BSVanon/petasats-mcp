import { expect } from 'chai'
import { decodeFunctionData, domainSeparator, keccak256, recoverTypedDataAddress, stringToBytes, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { BASE_USDC } from '../../../src/bridge/evm/base-tokens'
import {
  ALREADY_HAS_GAS_WEI, assertSignableOrder, assertSignablePermit, buildGasAppData, buildGasOrder, buildGasPermit, checkGasQuote,
  COW_NATIVE_ETH, COW_ORDER_DOMAIN, COW_VAULT_RELAYER, GAS_TOPUP_MIN_QUOTE_WEI, GAS_TOPUP_SELL, minusSlippage, ORDER_TYPES,
  orderUid, PERMIT_TYPES, permitCallData, placeholderPermitCallData, USDC_PERMIT_DOMAIN, usdcDomainSeparator,
  type CowQuoteResponse, type GasOrder,
} from '../../../src/sdk/buyer/gas-topup-order'

const PERMIT_CALL_ABI = [{
  type: 'function', name: 'permit', stateMutability: 'nonpayable', outputs: [],
  inputs: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
  ],
}] as const

// CoW Protocol's published order vector: cowprotocol/services crates/model/src/order.rs, tests compute_order_uid and
// order_creation_signature, copied there from cowprotocol/contracts v1.1.2 test/GPv2Signing.test.ts ("should compute
// order unique identifier", "should recover signing address for all supported ECDSA-based schemes"). The vector's
// domain separator is 0x74e0...9b09: "Gnosis Protocol" v2 on chain 31337 at the first Hardhat deployment address.
const VECTOR_DOMAIN = { name: 'Gnosis Protocol', version: 'v2', chainId: 31337, verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3' } as const
const VECTOR_SEPARATOR = '0x74e0b11bd18120612556bae4578cfd3a254d7e2495f543c569a92ff5794d9b09'
const VECTOR_OWNER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const VECTOR_ORDER: GasOrder = {
  sellToken: '0x0101010101010101010101010101010101010101', buyToken: '0x0202020202020202020202020202020202020202', receiver: '0x0303030303030303030303030303030303030303',
  sellAmount: 0x0246ddf97976680000n, buyAmount: 0xb98bc829a6f90000n, validTo: 0xffffffff, appData: `0x${'00'.repeat(32)}`,
  feeAmount: 0x0de0b6b3a7640000n, kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
}
const VECTOR_UID = '0x0e45d31fd31b28c26031cdd81b35a8938b2ccca2cc425fcf440fd3bfed1eede970997970c51812dc3a010c7d01b50e0d17dc79c8ffffffff'
const VECTOR_EIP712_SIGNATURE: Hex = '0x59c0f5c151071c1320575f6da826a6c276525bbe733234bad1afb2879657d65d2afe6812746f4cc97f28f3a5dfdbfc7087511695d23da5e9792cd7ed6c9ddeb71c'
// Base USDC's DOMAIN_SEPARATOR(), read from Base mainnet (eth_call at block 59635432); name "USD Coin", version "2".
const BASE_USDC_DOMAIN_SEPARATOR = '0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f'
// GPv2Settlement.domainSeparator() on Base, read at the same block.
const BASE_COW_ORDER_SEPARATOR = '0xd72ffa789b6fae41254d0b5a13e6e1e92ed947ec6a251edf1cf0b6c02c257b4b'

async function signedFixture() {
  const account = privateKeyToAccount(generatePrivateKey())
  const validTo = 1_800_001_200
  const plan = { owner: account.address, nonce: 7n, validTo, quoteBuyAmount: 276_833_333_333_333n }
  const permit = buildGasPermit(account.address, plan.nonce, validTo)
  const permitSignature = await account.signTypedData({ domain: USDC_PERMIT_DOMAIN, types: PERMIT_TYPES, primaryType: 'Permit', message: permit })
  const appData = buildGasAppData(permitCallData(permit, permitSignature))
  const order = buildGasOrder({ owner: account.address, buyAmount: minusSlippage(plan.quoteBuyAmount), validTo, appDataHash: appData.hash })
  return { account, plan, permit, permitSignature, appData, order }
}

function quote(over: Record<string, unknown> = {}, owner: Address, outer: Record<string, unknown> = {}): CowQuoteResponse {
  return { quote: { sellToken: BASE_USDC, buyToken: COW_NATIVE_ETH, receiver: owner, sellAmount: '498300', buyAmount: '276833333333333', feeAmount: '1700', kind: 'sell', ...over }, from: owner, id: 4242, verified: true, ...outer }
}

describe('buy_gas order builders', () => {
  it('reproduces CoW Protocol\'s published order uid and EIP-712 signature vector', async () => {
    expect(domainSeparator({ domain: VECTOR_DOMAIN })).eq(VECTOR_SEPARATOR)
    expect(orderUid(VECTOR_ORDER, VECTOR_OWNER, VECTOR_DOMAIN)).eq(VECTOR_UID)
    expect(VECTOR_UID.length).eq(2 + 56 * 2)
    expect(await recoverTypedDataAddress({ domain: VECTOR_DOMAIN, types: ORDER_TYPES, primaryType: 'Order', message: VECTOR_ORDER, signature: VECTOR_EIP712_SIGNATURE })).eq(VECTOR_OWNER)
  })

  it('signs for the Base domains read on chain: USDC permits and CoW Protocol orders', () => {
    expect(usdcDomainSeparator()).eq(BASE_USDC_DOMAIN_SEPARATOR)
    expect(domainSeparator({ domain: COW_ORDER_DOMAIN })).eq(BASE_COW_ORDER_SEPARATOR)
    expect(GAS_TOPUP_MIN_QUOTE_WEI).eq(25_000_000_000_000n) // 0.50 USD at $20,000 per ETH
    expect(minusSlippage(1_000_000n)).eq(980_000n)
  })

  it('1a any fill the kit accepts reaches the gas threshold, so the call after it refuses as already having gas', () => {
    expect(ALREADY_HAS_GAS_WEI).eq(20_000_000_000_000n) // 0.00002 ETH
    // The smallest buyAmount assertSignableOrder lets the kit sign is minusSlippage(GAS_TOPUP_MIN_QUOTE_WEI).
    expect(minusSlippage(GAS_TOPUP_MIN_QUOTE_WEI) >= ALREADY_HAS_GAS_WEI, 'the smallest accepted fill is below the threshold').eq(true)
  })

  it('builds an appData of one permit pre-hook whose hash is keccak256 of the exact JSON sent', async () => {
    const { account, permit, permitSignature, appData } = await signedFixture()
    expect(appData.hash).eq(keccak256(stringToBytes(appData.json)))
    expect(Buffer.byteLength(appData.json)).lessThan(1000) // small: the live order book accepted this appData
    const doc = JSON.parse(appData.json)
    expect(Object.keys(doc)).deep.eq(['appCode', 'metadata', 'version'])
    expect(doc).deep.include({ appCode: 'petasats-mcp', version: '1.16.0' })
    expect(doc.metadata.hooks.version).eq('0.2.0')
    expect(doc.metadata.hooks.pre).length(1)
    expect(doc.metadata.hooks.post).eq(undefined)
    const hook = doc.metadata.hooks.pre[0]
    expect(hook.target).eq(BASE_USDC); expect(hook.gasLimit).eq('100000') // a fresh kit's first permit measured about 72,030
    const call = decodeFunctionData({ abi: PERMIT_CALL_ABI, data: hook.callData })
    const [owner, spender, value, deadline, v, r, s] = call.args
    expect([owner, spender, value, deadline]).deep.eq([account.address, COW_VAULT_RELAYER, GAS_TOPUP_SELL, permit.deadline])
    const recovered = await recoverTypedDataAddress({ domain: USDC_PERMIT_DOMAIN, types: PERMIT_TYPES, primaryType: 'Permit', message: permit, signature: `${r}${s.slice(2)}${v.toString(16)}` as Hex })
    expect(recovered).eq(account.address)
    expect(`${r}${s.slice(2)}${v.toString(16)}`).eq(permitSignature)
  })

  it('quotes with a hook of the same shape that carries no signature at all', async () => {
    const { permit, appData } = await signedFixture()
    const placeholder = buildGasAppData(placeholderPermitCallData(permit))
    expect(placeholder.json.length).eq(appData.json.length)
    const call = decodeFunctionData({ abi: PERMIT_CALL_ABI, data: JSON.parse(placeholder.json).metadata.hooks.pre[0].callData })
    expect(call.args[5]).eq(`0x${'0'.repeat(64)}`); expect(call.args[6]).eq(`0x${'0'.repeat(64)}`)
  })

  it('F5 the signed order is never partially fillable, sells exactly 0.50 USDC with a zero fee, and pays the kit', async () => {
    const { account, plan, permit, permitSignature, appData, order } = await signedFixture()
    expect(order).deep.include({ partiallyFillable: false, sellAmount: 500_000n, feeAmount: 0n, kind: 'sell', receiver: account.address, sellToken: BASE_USDC, buyToken: COW_NATIVE_ETH, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' })
    expect(() => assertSignableOrder(order, plan, appData, permit, permitSignature)).not.to.throw()
    expect(() => assertSignableOrder({ ...order, partiallyFillable: true }, plan, appData, permit, permitSignature)).to.throw('partiallyFillable check')
  })

  it('F6 refuses to sign a permit when any one of its fields is wrong', async () => {
    const { plan, permit } = await signedFixture()
    expect(() => assertSignablePermit(permit, plan)).not.to.throw()
    const other: Address = '0x4444444444444444444444444444444444444444'
    const cases: Array<[string, Partial<typeof permit>]> = [
      ['permit owner', { owner: other }], ['permit spender', { spender: other }], ['permit value', { value: GAS_TOPUP_SELL + 1n }],
      ['permit nonce', { nonce: plan.nonce + 1n }], ['permit deadline', { deadline: permit.deadline + 1n }],
    ]
    for (const [field, change] of cases) expect(() => assertSignablePermit({ ...permit, ...change }, plan), field).to.throw(`the gas order failed its ${field} check; nothing was signed`)
  })

  it('F6 refuses to sign an order when any one of its fields is wrong', async () => {
    const { plan, permit, permitSignature, appData, order } = await signedFixture()
    const other: Address = '0x4444444444444444444444444444444444444444'
    const otherHook = buildGasAppData(placeholderPermitCallData(permit))
    const cases: Array<[string, Partial<GasOrder>]> = [
      ['sellToken', { sellToken: other }], ['buyToken', { buyToken: other }], ['receiver', { receiver: other }],
      ['sellAmount', { sellAmount: GAS_TOPUP_SELL + 1n }], ['buyAmount', { buyAmount: order.buyAmount - 1n }],
      ['validTo', { validTo: plan.validTo + 1 }], ['feeAmount', { feeAmount: 1n }], ['kind', { kind: 'buy' }],
      ['partiallyFillable', { partiallyFillable: true }], ['sellTokenBalance', { sellTokenBalance: 'external' }],
      ['buyTokenBalance', { buyTokenBalance: 'internal' }], ['appData', { appData: otherHook.hash }],
    ]
    for (const [field, change] of cases) expect(() => assertSignableOrder({ ...order, ...change }, plan, appData, permit, permitSignature), field).to.throw(`the gas order failed its ${field} check; nothing was signed`)
    expect(() => assertSignableOrder(order, plan, otherHook, permit, permitSignature), 'appData document').to.throw('appData check')
    expect(() => assertSignableOrder(order, { ...plan, quoteBuyAmount: GAS_TOPUP_MIN_QUOTE_WEI - 1n }, appData, permit, permitSignature), 'buy floor').to.throw('buyAmount check')
  })

  it('F2 refuses a quote with a wrong token, receiver, owner or kind, a wrong total, no ETH, or ETH above $20,000', () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address
    const other = '0x4444444444444444444444444444444444444444'
    expect(checkGasQuote(quote({}, owner), owner)).deep.eq({ buyAmount: 276_833_333_333_333n, quoteId: 4242 })
    expect(checkGasQuote(quote({ receiver: null }, owner), owner).buyAmount).eq(276_833_333_333_333n)
    const bad: Array<[string, CowQuoteResponse]> = [
      ['sells a token other than Base USDC', quote({ sellToken: other }, owner)],
      ['does not buy native ETH', quote({ buyToken: other }, owner)],
      ["pays an address other than the kit's", quote({ receiver: other }, owner)],
      ['is for another address', quote({}, owner, { from: other })],
      ['is not a sell order', quote({ kind: 'buy' }, owner)],
      ['is not for exactly 0.50 USDC', quote({ sellAmount: '500000' }, owner)],
      ['amounts are not whole numbers', quote({ buyAmount: '1.5' }, owner)],
      ['buys no ETH', quote({ buyAmount: '0' }, owner)],
      ['prices ETH above $20,000', quote({ buyAmount: (GAS_TOPUP_MIN_QUOTE_WEI - 1n).toString() }, owner)],
      ['has no order in it', { from: owner }],
    ]
    for (const [reason, response] of bad) expect(() => checkGasQuote(response, owner), reason).to.throw(reason)
    expect(checkGasQuote(quote({ buyAmount: GAS_TOPUP_MIN_QUOTE_WEI.toString() }, owner), owner).buyAmount).eq(GAS_TOPUP_MIN_QUOTE_WEI)
  })
})
