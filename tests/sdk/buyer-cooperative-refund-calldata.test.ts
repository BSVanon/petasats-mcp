import { expect } from 'chai'
import { describe, it } from 'mocha'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, parseAbiParameters, type Hex } from 'viem'
import { base } from 'viem/chains'
import { Erc20SwapEvmClient } from '../../src/bridge/evm/client'
import { encodeRefundCooperative, REFUND_COOPERATIVE_ABI } from '../../src/bridge/evm/cooperative-refund'
import { encodeRefund, type Erc20SwapParams } from '../../src/bridge/evm/erc20swap'
import type { SettlementRecord } from '../../src/bridge/settlement-session'
import { resolveCooperativeRefund } from '../../src/sdk/buyer/cooperative-refund'
import { buyerStageForSettlement } from '../../src/sdk/buyer/engine'

const HASH = `0x${'11'.repeat(32)}` as Hex
const REFUND_TX = `0x${'22'.repeat(32)}` as Hex
const LOCK_TX = `0x${'99'.repeat(32)}` as Hex
const SWAP = `0x${'33'.repeat(20)}` as Hex
const TOKEN = `0x${'44'.repeat(20)}` as Hex
const MAKER = `0x${'55'.repeat(20)}` as Hex
const BUYER = `0x${'66'.repeat(20)}` as Hex
const SIGNATURE = `0x${'77'.repeat(32)}${'88'.repeat(32)}1b` as Hex
const REFUND_ABI = [{
  type: 'event', name: 'Refund', inputs: [{ indexed: true, name: 'preimageHash', type: 'bytes32' }],
}] as const
const LOCKUP_ABI = [{ type: 'event', name: 'Lockup', inputs: [
  { indexed: true, name: 'preimageHash', type: 'bytes32' }, { indexed: false, name: 'amount', type: 'uint256' },
  { indexed: false, name: 'tokenAddress', type: 'address' }, { indexed: true, name: 'claimAddress', type: 'address' },
  { indexed: true, name: 'refundAddress', type: 'address' }, { indexed: false, name: 'timelock', type: 'uint256' },
] }] as const

const params: Erc20SwapParams = {
  preimageHash: HASH,
  amount: 1_000_000n,
  tokenAddress: TOKEN,
  claimAddress: MAKER,
  refundAddress: BUYER,
  timelock: 180_100n,
}

function record(): SettlementRecord {
  return {
    hashHex: HASH.slice(2), role: 'initiator', state: 'base-locked', amountUsdc: params.amount.toString(), amountBsvSats: 10_000,
    quoteRef: 'synthetic', baseTimelockBlock: Number(params.timelock), bsvRefundLocktime: 800_012, claimBudgetBaseBlocks: 36_000,
    baseRefundTs: 1, bsvRefundTs: 1, claimBudgetBaseSecs: 7_200, bsvClaimPubKeyHex: `02${'1'.repeat(64)}`,
    bsvRefundPubKeyHex: `03${'2'.repeat(64)}`, baseChainId: 8453, erc20SwapAddress: SWAP,
    usdcTokenAddress: TOKEN, usdcDecimals: 6, baseClaimAddress: MAKER, baseRefundAddress: BUYER,
    capUsdPerSwap: 100, zeroConfCapUsd: 0, baseLockTxHash: LOCK_TX, baseLockBlock: 100, baseLockLogIndex: 1,
    history: [{ state: 'created', at: 1 }, { state: 'base-locked', at: 2 }],
  }
}

function clientFor(input: Hex): Erc20SwapEvmClient {
  const client = new Erc20SwapEvmClient({ rpcUrl: 'http://unused', address: BUYER, swapAddress: SWAP, chain: base })
  ;(client as any).assertContractIdentity = async () => {}
  ;(client as any).isSwapLocked = async () => false
  ;(client as any).pub = {
    getBlock: async () => ({ number: 123n }),
    getLogs: async ({ event }: { event: { name: string } }) => event.name === 'Refund' ? [{
      address: SWAP,
      transactionHash: REFUND_TX,
      transactionIndex: 2,
      blockNumber: 120n,
      logIndex: 0,
      topics: encodeEventTopics({ abi: REFUND_ABI, eventName: 'Refund', args: { preimageHash: HASH } }),
      data: '0x',
      args: { preimageHash: HASH },
    }] : [],
    getTransactionReceipt: async () => ({
      status: 'success', transactionHash: LOCK_TX, blockNumber: 100n, transactionIndex: 1,
      logs: [{
        address: SWAP, transactionHash: LOCK_TX, blockNumber: 100n, transactionIndex: 1, logIndex: 1,
        topics: encodeEventTopics({
          abi: LOCKUP_ABI, eventName: 'Lockup',
          args: { preimageHash: HASH, claimAddress: MAKER, refundAddress: BUYER },
        }),
        data: encodeAbiParameters(parseAbiParameters('uint256,address,uint256'), [params.amount, TOKEN, params.timelock]),
      }],
    }),
    getTransaction: async () => ({ to: SWAP, input }),
  }
  return client
}

async function resolve(input: Hex, current: SettlementRecord, persist: (next: SettlementRecord) => void) {
  return resolveCooperativeRefund(current, {
    evm: clientFor(input),
    now: () => 9_000,
    reread: () => current,
    persist,
    assertPoolSafe: () => {},
  })
}

describe('buyer cooperative-refund calldata evidence', () => {
  it('recognizes the exact nine-argument call and fences a later BSV-lock observation', async () => {
    let current = record()
    const result = await resolve(encodeRefundCooperative(params, SIGNATURE), current, (next) => { current = next })

    expect(result.kind).to.equal('refunded')
    expect(current).to.include({ state: 'refunded', refundTxid: REFUND_TX })
    expect(buyerStageForSettlement(current.state)).to.equal('refunded')

    // A late message may annotate the tombstone, but cannot return it to a reveal-capable state.
    current = { ...current, bsvLockOutpoint: `${'aa'.repeat(32)}_0` }
    let writes = 0
    const later = await resolve(encodeRefundCooperative(params, SIGNATURE), current, () => { writes += 1 })
    expect(later).to.include({ kind: 'none', record: current })
    expect(current.state).to.equal('refunded')
    expect(current).not.to.have.property('bsvClaimTxid')
    expect(writes).to.equal(0)
  })

  it('does not bind a cooperative call when any one of the six tuple fields differs', async () => {
    const variants: Array<[string, Erc20SwapParams]> = [
      ['preimageHash', { ...params, preimageHash: `0x${'aa'.repeat(32)}` }],
      ['amount', { ...params, amount: params.amount + 1n }],
      ['tokenAddress', { ...params, tokenAddress: `0x${'bb'.repeat(20)}` }],
      ['claimAddress', { ...params, claimAddress: `0x${'cc'.repeat(20)}` }],
      ['refundAddress', { ...params, refundAddress: `0x${'dd'.repeat(20)}` }],
      ['timelock', { ...params, timelock: params.timelock + 1n }],
    ]
    for (const [field, variant] of variants) {
      const current = record()
      let writes = 0
      const result = await resolve(encodeRefundCooperative(variant, SIGNATURE), current, () => { writes += 1 })
      expect(result.kind, field).to.equal('none')
      expect(current.state, field).to.equal('base-locked')
      expect(writes, field).to.equal(0)
    }
  })

  it('accepts arbitrary signature fields but rejects the legacy overload and trailing calldata', async () => {
    const arbitrarySignature = encodeFunctionData({
      abi: REFUND_COOPERATIVE_ABI,
      functionName: 'refundCooperative',
      args: [params.preimageHash, params.amount, params.tokenAddress, params.claimAddress, params.refundAddress, params.timelock, 0, `0x${'00'.repeat(32)}`, `0x${'ff'.repeat(32)}`],
    })
    let current = record()
    expect((await resolve(arbitrarySignature, current, (next) => { current = next })).kind).to.equal('refunded')

    const legacy = encodeFunctionData({
      abi: parseAbi(['function refundCooperative(bytes32,uint256,address,address,uint256,uint8,bytes32,bytes32)']),
      functionName: 'refundCooperative',
      args: [params.preimageHash, params.amount, params.tokenAddress, params.claimAddress, params.timelock, 27, `0x${'00'.repeat(32)}`, `0x${'ff'.repeat(32)}`],
    })
    for (const [shape, input] of [
      ['legacy eight-argument overload', legacy],
      ['trailing byte', `${encodeRefundCooperative(params, SIGNATURE)}00` as Hex],
    ] as const) {
      const unchanged = record()
      let writes = 0
      expect((await resolve(input, unchanged, () => { writes += 1 })).kind, shape).to.equal('none')
      expect(writes, shape).to.equal(0)
    }
  })

  it('keeps the ordinary six-argument refund binding unchanged', async () => {
    let current = record()
    const result = await resolve(encodeRefund(params), current, (next) => { current = next })
    expect(result.kind).to.equal('refunded')
    expect(current).to.include({ state: 'refunded', refundTxid: REFUND_TX })
  })
})
