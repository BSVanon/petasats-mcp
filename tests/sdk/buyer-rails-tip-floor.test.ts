import { expect } from 'chai'
import { describe, it } from 'mocha'
import { keccak256, parseTransaction, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { makeBuyerEvmRails } from '../../src/sdk/buyer/runtime/evm-rails'

const KEY = `0x${'11'.repeat(32)}` as Hex
const ACCOUNT = privateKeyToAccount(KEY)
const SWAP = '0x1111111111111111111111111111111111111111' as const
const USDC = '0x2222222222222222222222222222222222222222' as const
const TO = '0x3333333333333333333333333333333333333333' as const
const PROBE_HASH = `0x${'ab'.repeat(32)}` as Hex
const BASE_FEE = 5_000_000n
const SUGGESTION = 1_000_000n
const INCLUDED = 50_000_000n

const reply = (id: unknown, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', result, id }), { headers: { 'content-type': 'application/json' } })
const hex = (n: bigint) => `0x${n.toString(16)}`
const block = (number: bigint) => ({ number: hex(number), hash: `0x${'cd'.repeat(32)}`, timestamp: '0x1', baseFeePerGas: hex(BASE_FEE), gasLimit: '0x1c9c380' })
const receipt = (hash: Hex, number: bigint) => ({ transactionHash: hash, blockHash: `0x${'ef'.repeat(32)}`, blockNumber: hex(number), from: ACCOUNT.address, to: USDC, status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`, transactionIndex: '0x0', type: '0x2', contractAddress: null })

/** Synthetic Base node in the measured 2026-11-02 state: RPC suggests 0.001 gwei, recent blocks include ~0.05 gwei. */
function fakeNode(opts: { history: boolean }) {
  const finalized = 100n
  const sent: Hex[] = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: unknown[] }
    if (method === 'eth_chainId') return reply(id, '0x2105')
    if (method === 'eth_blockNumber') return reply(id, hex(finalized + 2n))
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0]
      if (params[1] === true && tag !== 'pending') return reply(id, { ...block(typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : finalized), transactions: [PROBE_HASH] })
      return reply(id, block(tag === 'finalized' || tag === 'safe' ? finalized : finalized + 2n))
    }
    if (method === 'eth_getLogs') return reply(id, [])
    if (method === 'eth_getTransactionCount') return reply(id, '0x7')
    if (method === 'eth_maxPriorityFeePerGas') return reply(id, hex(SUGGESTION))
    if (method === 'eth_gasPrice') return reply(id, hex(BASE_FEE + SUGGESTION))
    if (method === 'eth_feeHistory') {
      return opts.history ? reply(id, { oldestBlock: hex(finalized - 7n), baseFeePerGas: [], gasUsedRatio: [], reward: Array.from({ length: 10 }, () => [hex(INCLUDED)]) }) : reply(id, null)
    }
    if (method === 'eth_estimateGas') return reply(id, '0x5208')
    if (method === 'eth_call') return reply(id, `0x${'1'.padStart(64, '0')}`)
    if (method === 'eth_sendRawTransaction') { const signed = params[0] as Hex; sent.push(signed); return reply(id, keccak256(signed)) }
    if (method === 'eth_getTransactionReceipt') {
      const hash = params[0] as Hex
      if (hash === PROBE_HASH) return reply(id, receipt(PROBE_HASH, finalized - 200n))
      return sent.some((signed) => keccak256(signed) === hash) ? reply(id, receipt(hash, finalized)) : reply(id, null)
    }
    return reply(id, null)
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, sent }
}

const rails = (fetchImpl: typeof globalThis.fetch) => makeBuyerEvmRails({ privateKey: KEY, swapAddress: SWAP, usdcTokenAddress: USDC, rpcUrls: ['http://base.test'], fetchImpl, retryDelayMs: 1 })

describe('buyer rails price Base tips from recent included blocks', () => {
  it('a buyer ERC-20 send built by makeBuyerEvmRails signs the recent included tip, not the 0.001 gwei suggestion', async () => {
    const node = fakeNode({ history: true })
    await (await rails(node.fetch)).client.transferErc20(USDC, TO, 1n)
    expect(node.sent).to.have.length(1)
    const tx = parseTransaction(node.sent[0])
    expect(tx.maxPriorityFeePerGas).eq(INCLUDED)
    expect(tx.maxFeePerGas).eq(BASE_FEE * 12n / 10n + INCLUDED)
  })

  it('the buyer ETH withdrawal price uses the same raised tip', async () => {
    const price = await (await rails(fakeNode({ history: true }).fetch)).client.priceNativeTransfer(TO)
    expect(price.maxPriorityFeePerGas).eq(INCLUDED)
    expect(price.maxFeePerGas).eq(BASE_FEE * 12n / 10n + INCLUDED)
  })

  it('without fee history the buyer send keeps the RPC suggestion, as in 0.2.6', async () => {
    const node = fakeNode({ history: false })
    await (await rails(node.fetch)).client.transferErc20(USDC, TO, 1n)
    expect(parseTransaction(node.sent[0]).maxPriorityFeePerGas).eq(SUGGESTION)
  })
})
