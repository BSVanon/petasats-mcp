import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { BuyerKit } from 'petasats/sdk'
import { createPetaSatsMcpServer, INSTRUCTIONS, TOOLS } from '../src/server.js'
import { HOSTED_ALLOWED_TOOLS, HOSTED_QUOTE_ONLY_NOTE, HOSTED_TOOL_REFUSAL, isHostedCopy } from '../src/hosted.js'

function recordingKit(calls: string[]): BuyerKit {
  return {
    quote: async (request) => { calls.push('quote'); return { from: request.from, to: request.to, route: 'bridge', amountIn: request.amountIn, amountOut: request.amountIn * 2n, expiry: 9_999_999_999, quoteId: 'hosted-quote' } },
    convert: async () => { calls.push('convert'); return { ok: true, route: 'bridge', status: 'pending', txids: {} } },
    startSwap: async () => { calls.push('startSwap'); return { swapId: 'a'.repeat(32), stage: 'quoted', expectedMinutes: 20, requestedSpeed: 'standard', agreedSettlementMode: 'confirmed', settlementModeUsed: 'pending' } },
    status: async () => { calls.push('status'); return [] },
    recover: async () => { calls.push('recover'); return [] },
    withdrawBsv: async () => { calls.push('withdrawBsv'); return { sats: 0n } },
    withdrawBase: async () => { calls.push('withdrawBase'); return { asset: 'USDC', amount: 1n, to: '0x1111111111111111111111111111111111111111', txid: '0xtx', status: 'success' } },
    walletInfo: async () => { calls.push('walletInfo'); return { baseAddress: '0xabc', bsvAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', usdc: 1n, eth: 1n, claimedBsvSats: 0n, unconfirmedBsvSats: 0n, capUsdPerSwap: 100 } },
    assertWithdrawDestinations: async () => {},
  }
}

async function clientFor(hosted: boolean, calls: string[]): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createPetaSatsMcpServer({ petasats: recordingKit(calls), hosted })
  await server.connect(serverTransport)
  const client = new Client({ name: 'hosted-test', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return await client.callTool({ name, arguments: args }) as CallToolResult
}

function text(result: CallToolResult, index: number): string {
  const item = result.content.at(index)
  assert.equal(item?.type, 'text')
  return (item as { text: string }).text
}

test('isHostedCopy recognizes only the shared-server flags', () => {
  assert.equal(isHostedCopy({ GLAMA_VERSION: '1.0.0' }), true)
  assert.equal(isHostedCopy({ GLAMA_VERSION: '' }), false)
  assert.equal(isHostedCopy({ PETASATS_QUOTE_ONLY: '1' }), true)
  assert.equal(isHostedCopy({ PETASATS_QUOTE_ONLY: '0' }), false)
  assert.equal(isHostedCopy({}), false)
})

test('hosted mode refuses every non-quote tool before the kit is called', async () => {
  const calls: string[] = []
  const client = await clientFor(true, calls)
  for (const tool of TOOLS.filter(({ name }) => !HOSTED_ALLOWED_TOOLS.has(name))) {
    const result = await call(client, tool.name, {})
    assert.equal(result.isError, true, tool.name)
    assert.equal(JSON.parse(text(result, 0)).error, HOSTED_TOOL_REFUSAL, tool.name)
  }
  assert.deepEqual(calls, [])
  await client.close()
})

test('hosted get_quote calls the kit and appends the quote-only note', async () => {
  const calls: string[] = []
  const client = await clientFor(true, calls)
  const result = await call(client, 'get_quote', { from_asset: 'USDC', to_asset: 'BSV', amount_in: '1000000' })
  assert.equal(result.isError, undefined)
  assert.deepEqual(calls, ['quote'])
  assert.equal(text(result, -1), HOSTED_QUOTE_ONLY_NOTE)
  await client.close()
})

test('normal mode preserves tool calls and adds no hosted note', async () => {
  const calls: string[] = []
  const client = await clientFor(false, calls)
  const quote = await call(client, 'get_quote', { from_asset: 'USDC', to_asset: 'BSV', amount_in: '1000000' })
  assert.equal(quote.content.length, 1)
  assert.equal(text(quote, 0).includes(HOSTED_QUOTE_ONLY_NOTE), false)
  const withdrawal = await call(client, 'withdraw_bsv', { address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' })
  assert.equal(withdrawal.isError, undefined)
  assert.deepEqual(calls, ['quote', 'withdrawBsv'])
  await client.close()
})

test('hosted mode keeps discovery wire-identical and serves empty resource templates', async () => {
  const hosted = await clientFor(true, [])
  const normal = await clientFor(false, [])
  assert.deepEqual(await hosted.listTools(), await normal.listTools())
  assert.equal(hosted.getInstructions(), INSTRUCTIONS)
  assert.equal(hosted.getInstructions(), normal.getInstructions())
  assert.deepEqual(await hosted.listResourceTemplates(), { resourceTemplates: [] })
  await hosted.close()
  await normal.close()
})
