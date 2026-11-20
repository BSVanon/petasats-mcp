import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { BUY_GAS_HINT, type BuyerKit, type CloseKitStep, type GasTopUpStep } from 'petasats/sdk'
import { createPetaSatsMcpServer, INSTRUCTIONS } from '../src/server.js'
import { HOSTED_TOOL_REFUSAL } from '../src/hosted.js'
import { closeCommandLoop } from '../src/index.js'

/** A minimal BuyerKit; buy_gas reaches only its optional buyGas method. */
function kitWith(buyGas?: () => Promise<GasTopUpStep>, withdrawBase?: BuyerKit['withdrawBase']): BuyerKit {
  const unused = async (): Promise<never> => { throw new Error('not used by buy_gas') }
  return {
    quote: unused, convert: unused, startSwap: unused, status: async () => [], recover: async () => [], withdrawBsv: unused, withdrawBase: withdrawBase ?? unused,
    walletInfo: async () => ({ baseAddress: '0xabc', bsvAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', usdc: 1n, eth: 0n, claimedBsvSats: 0n, unconfirmedBsvSats: 0n, capUsdPerSwap: 100 }),
    assertWithdrawDestinations: async () => {},
    ...(buyGas ? { buyGas } : {}),
  }
}

async function clientFor(kit: BuyerKit, hosted = false, closeKit?: () => Promise<CloseKitStep>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await createPetaSatsMcpServer({ petasats: kit, hosted, closeKit }).connect(serverTransport)
  const client = new Client({ name: 'gas-tool-test', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

function text(result: CallToolResult): string {
  const item = result.content.at(0)
  assert.equal(item?.type, 'text')
  return (item as { text: string }).text
}

test('buy_gas is listed as a money tool with no arguments, and its texts ask for the user\'s yes', async () => {
  const client = await clientFor(kitWith())
  const tool = (await client.listTools()).tools.find((t) => t.name === 'buy_gas')
  assert.ok(tool, 'buy_gas must be registered')
  assert.deepEqual(tool!.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true })
  assert.deepEqual(tool!.inputSchema, { type: 'object', properties: {}, required: [] })
  assert.match(tool!.description!, /exactly 0\.50 USDC/)
  assert.match(tool!.description!, /call it only after the user says yes/)
  assert.match(INSTRUCTIONS, /Each yes covers one purchase\./)
  assert.match(INSTRUCTIONS, /that purchase is over: ask again before another\./)
  await client.close()
})

test('F11 a shared-server copy refuses buy_gas before the kit is called', async () => {
  let called = 0
  const client = await clientFor(kitWith(async () => { called++; return { state: 'refused', reason: 'x' } }), true)
  const result = await client.callTool({ name: 'buy_gas', arguments: {} }) as CallToolResult
  assert.equal(result.isError, true)
  assert.equal(JSON.parse(text(result)).error, HOSTED_TOOL_REFUSAL)
  assert.equal(called, 0)
  await client.close()
})

test('buy_gas returns each kit step unchanged, and a kit that is not set up gives a clear error', async () => {
  const steps: GasTopUpStep[] = [
    { state: 'refused', reason: 'the kit already has gas (0.0001 ETH); nothing was signed' },
    { state: 'pending', uid: `0x${'a'.repeat(112)}`, order_url: `https://explorer.cow.fi/base/orders/0x${'a'.repeat(112)}`, sold: '0.50 USDC', min_eth: '0.0002 ETH', call_again_after_seconds: 30, note: 'waiting' },
    { state: 'filled', uid: `0x${'b'.repeat(112)}`, order_url: `https://explorer.cow.fi/base/orders/0x${'b'.repeat(112)}`, sold: '0.50 USDC', min_eth: '0.0002 ETH', eth_received: '0.00021 ETH' },
    { state: 'expired', uid: `0x${'c'.repeat(112)}`, order_url: `https://explorer.cow.fi/base/orders/0x${'c'.repeat(112)}`, sold: 'nothing', min_eth: '0.0002 ETH', reason: 'nothing was sold' },
  ]
  for (const step of steps) {
    const client = await clientFor(kitWith(async () => step))
    const result = await client.callTool({ name: 'buy_gas', arguments: {} }) as CallToolResult
    assert.equal(result.isError, undefined, step.state)
    assert.deepEqual(JSON.parse(text(result)), step, step.state)
    await client.close()
  }
  const client = await clientFor(kitWith())
  const missing = await client.callTool({ name: 'buy_gas', arguments: {} }) as CallToolResult
  assert.equal(missing.isError, true)
  assert.equal(JSON.parse(text(missing)).error, 'buy_gas is not available until the kit is set up')
  await client.close()
})

test('withdraw_base and close_kit add the buy_gas hint to the kit\'s no-ETH refusal, and pass every other text through', async () => {
  const hinted = `ETH is needed for Base gas; ${BUY_GAS_HINT}`
  for (const [message, shown] of [['ETH is needed for Base gas', hinted], ['amount exceeds USDC balance', 'amount exceeds USDC balance']]) {
    const client = await clientFor(kitWith(undefined, async () => { throw new Error(message) }))
    const result = await client.callTool({ name: 'withdraw_base', arguments: { asset: 'USDC', to: '0x3333333333333333333333333333333333333333', amount: 'all' } }) as CallToolResult
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(text(result)).error, shown)
    await client.close()
  }
  for (const [reason, shown] of [['ETH is needed for Base gas', hinted], ['nope', 'nope']]) {
    const client = await clientFor(kitWith(), false, async () => ({ state: 'refused', reason, sent: [] }))
    const result = await client.callTool({ name: 'close_kit', arguments: { base_address: '0x3333333333333333333333333333333333333333', bsv_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' } }) as CallToolResult
    assert.deepEqual(JSON.parse(text(result)), { state: 'refused', reason: shown, sent: [] })
    await client.close()
  }
})

test('buy_gas names the 0.00002 ETH threshold and the brief wait, and says a call never places a new order while an earlier one could still fill', async () => {
  const client = await clientFor(kitWith())
  const description = (await client.listTools()).tools.find((t) => t.name === 'buy_gas')!.description!
  for (const phrase of [
    'Refused when the kit already has gas (0.00002 ETH or more), holds less than 0.50 USDC, or spending is stopped. While a Base withdrawal or swap lock is still being confirmed, it is refused for 30 s; call it again then. Each call returns within about a minute;',
    'Calling again never places a new order while an earlier one could still fill.',
    'and, once filled, eth_received when it is known; or reason.',
  ]) assert.ok(description.includes(phrase), phrase)
  for (const old of ['0.00005', 'returns at once', 'second order']) assert.ok(!description.includes(old), old)
  assert.ok(INSTRUCTIONS.includes('get a clear yes. This is the only time to ask about the swap. If they already gave you an amount'))
  await client.close()
})

test('the per-purchase rule is in INSTRUCTIONS, the buy_gas description and the skill file, and none of them tells the AI to keep going until filled or to ask only once', async () => {
  const client = await clientFor(kitWith())
  const description = (await client.listTools()).tools.find((t) => t.name === 'buy_gas')!.description!
  // The skill sits under the template here, at the repository root once published.
  const mcpRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const skillPath = [join(mcpRoot, 'public', 'template', 'skills', 'petasats-buy-bsv', 'SKILL.md'), join(mcpRoot, '..', 'skills', 'petasats-buy-bsv', 'SKILL.md')].find((p) => existsSync(p))
  assert.ok(skillPath, 'the skill file must exist in this tree')
  const skill = readFileSync(skillPath, 'utf8')
  for (const [name, value] of [['INSTRUCTIONS', INSTRUCTIONS], ['the buy_gas description', description], ['the skill file', skill]]) {
    assert.ok(value.includes('Each yes covers one purchase.'), name)
    for (const old of ["until it is filled", "until state is 'filled'", 'until it is `filled`', 'ask the user once']) {
      assert.ok(!value.includes(old), `${name}: ${old}`)
    }
  }
  await client.close()
})

/** The kit's refusal when it has no ETH to cancel a refused withdrawal (withdrawal-intent.ts, buyer-kit.ts), and the hint each surface adds. */
const CANCEL_HASH = `0x${'0123456789abcdef'.repeat(4)}`
const cannotCancel = (hash: string): string => `the account cannot pay the gas to cancel the refused withdrawal ${hash}. Add a little ETH for Base gas, then call again. The kit will then complete or cancel it, never both. Nothing new was sent.`
const CANCEL_HINT = ` To add ETH: ${BUY_GAS_HINT}.`

test('8 close_kit adds the buy_gas hint to the cannot-pay-to-cancel refusal', async () => {
  const client = await clientFor(kitWith(), false, async () => ({ state: 'refused', reason: cannotCancel(CANCEL_HASH), sent: [] }))
  const result = await client.callTool({ name: 'close_kit', arguments: { base_address: '0x3333333333333333333333333333333333333333', bsv_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' } }) as CallToolResult
  assert.deepEqual(JSON.parse(text(result)), { state: 'refused', reason: `${cannotCancel(CANCEL_HASH)}${CANCEL_HINT}`, sent: [] })
  await client.close()
})

test('8 the CLI close adds the buy_gas hint to the cannot-pay-to-cancel refusal', async () => {
  const result = await closeCommandLoop(async () => ({ state: 'refused', reason: cannotCancel(CANCEL_HASH), sent: [] }), { baseAddress: '', bsvAddress: '' }, { sleep: async () => {}, log: () => {} })
  assert.deepEqual(result, { exitCode: 1, output: `${cannotCancel(CANCEL_HASH)}${CANCEL_HINT}` })
})

test('8 withdraw_base adds the buy_gas hint to the cannot-pay-to-cancel refusal', async () => {
  const client = await clientFor(kitWith(undefined, async () => { throw new Error(cannotCancel(CANCEL_HASH)) }))
  const result = await client.callTool({ name: 'withdraw_base', arguments: { asset: 'USDC', to: '0x3333333333333333333333333333333333333333', amount: 'all' } }) as CallToolResult
  assert.equal(result.isError, true)
  // A tool error hides any 64-hex value, as it always has; the hint follows the kit's own text.
  assert.equal(JSON.parse(text(result)).error, `${cannotCancel('[redacted secret]')}${CANCEL_HINT}`)
  await client.close()
})

test('the CLI close adds the buy_gas hint to the kit\'s no-ETH refusal, as close_kit does, and passes every other text through', async () => {
  const request = { baseAddress: '', bsvAddress: '' } // the step below never reads it
  const quiet = { sleep: async () => {}, log: () => {} }
  const noEth = await closeCommandLoop(async () => ({ state: 'refused', reason: 'ETH is needed for Base gas', sent: [] }), request, quiet)
  assert.deepEqual(noEth, { exitCode: 1, output: `ETH is needed for Base gas; ${BUY_GAS_HINT}` })
  const other = await closeCommandLoop(async () => ({ state: 'refused', reason: 'nope', sent: [] }), request, quiet)
  assert.deepEqual(other, { exitCode: 1, output: 'nope' })
})
