import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  CLOSED_STOP_REASON, closeKitStep, initialiseBuyerHome,
  type BuyerKit, type CloseKitRequest, type CloseKitStep,
} from 'petasats/sdk'
// makeBuyerWithdrawalIntents and BuyerWithdrawalRails are not in the public kit's narrow surface (src/sdk/buyer-sdk.ts):
// import the module directly, as server.test.ts:8 already does, so the public export still ships this file (B1).
import { makeBuyerWithdrawalIntents, type BuyerWithdrawalRails } from '../../src/sdk/buyer/withdrawal-intent.js'
import { createPetaSatsMcpServer, handleToolCall } from '../src/server.js'
import { HOSTED_TOOL_REFUSAL } from '../src/hosted.js'
import { closeArgs, closeCommandLoop } from '../src/index.js'

const DEST_BASE = '0x3333333333333333333333333333333333333333'
const DEST_BSV = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'

/** A minimal BuyerKit so createPetaSatsMcpServer has one; close_kit itself goes through the separate closeKit dep. */
function dummyKit(): BuyerKit {
  return {
    quote: async (request) => ({ from: request.from, to: request.to, route: 'bridge', amountIn: request.amountIn, amountOut: request.amountIn, expiry: 9_999_999_999, quoteId: 'q' }),
    convert: async () => ({ ok: true, route: 'bridge', status: 'pending', txids: {} }),
    startSwap: async () => ({ swapId: 'a'.repeat(32), stage: 'quoted', expectedMinutes: 20, requestedSpeed: 'standard', agreedSettlementMode: 'confirmed', settlementModeUsed: 'pending' }),
    status: async () => [],
    recover: async () => [],
    withdrawBsv: async () => ({ sats: 0n }),
    withdrawBase: async () => ({ asset: 'USDC', amount: 1n, to: DEST_BASE, txid: '0xtx', status: 'success' }),
    walletInfo: async () => ({ baseAddress: '0xabc', bsvAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', usdc: 1n, eth: 1n, claimedBsvSats: 0n, unconfirmedBsvSats: 0n, capUsdPerSwap: 100 }),
    assertWithdrawDestinations: async () => {},
  }
}

async function clientFor(deps: { hosted?: boolean; closeKit?: (request: CloseKitRequest) => Promise<CloseKitStep> }): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createPetaSatsMcpServer({ petasats: dummyKit(), ...deps })
  await server.connect(serverTransport)
  const client = new Client({ name: 'close-tool-test', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

async function callCloseKit(client: Client, args: Record<string, unknown>): Promise<CallToolResult> {
  return await client.callTool({ name: 'close_kit', arguments: args }) as CallToolResult
}

function text(result: CallToolResult, index = 0): string {
  const item = result.content.at(index)
  assert.equal(item?.type, 'text')
  return (item as { text: string }).text
}

test('F15 a hosted copy refuses close_kit before any closeKit function is called', async () => {
  let called = 0
  const closeKit = async (): Promise<CloseKitStep> => {
    called++
    return { state: 'closed', closed_at: new Date().toISOString(), sent: [], final: { usdc: '0', eth_wei: '0', bsv_sats: '0' }, keys_note: 'note' }
  }
  const client = await clientFor({ hosted: true, closeKit })
  const result = await callCloseKit(client, { base_address: DEST_BASE, bsv_address: DEST_BSV })
  assert.equal(result.isError, true)
  assert.equal(JSON.parse(text(result)).error, HOSTED_TOOL_REFUSAL)
  assert.equal(called, 0)
  await client.close()
})

test('F16 close_kit is wired into tools/list, the missing-closeKit error, and each result shape', async () => {
  // tools/list: close_kit is present with its exact annotations.
  const listClient = await clientFor({})
  const tools = await listClient.listTools()
  const tool = tools.tools.find((t) => t.name === 'close_kit')
  assert.ok(tool, 'close_kit must be registered')
  assert.deepEqual(tool!.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true })
  await listClient.close()

  // Missing closeKit (the kit is not set up yet): a clear tool error, not a crash.
  const noCloseKitClient = await clientFor({})
  const missing = await callCloseKit(noCloseKitClient, { base_address: DEST_BASE, bsv_address: DEST_BSV })
  assert.equal(missing.isError, true)
  assert.equal(JSON.parse(text(missing)).error, 'close_kit is not available until the kit is set up')
  await noCloseKitClient.close()

  // Result JSON shape per state: refused, in_progress and closed each pass through unchanged, and the
  // tool parses base_address/bsv_address into the baseAddress/bsvAddress request closeKitStep expects.
  const steps: CloseKitStep[] = [
    { state: 'refused', reason: 'nope', sent: [] },
    { state: 'in_progress', did: 'did it', next: 'do more', call_again_after_seconds: 30, sent: [] },
    { state: 'closed', closed_at: '2026-01-01T00:00:00.000Z', sent: [], final: { usdc: '0', eth_wei: '0', bsv_sats: '0' }, keys_note: 'note' },
  ]
  for (const step of steps) {
    let seen: CloseKitRequest | undefined
    const closeKit = async (request: CloseKitRequest): Promise<CloseKitStep> => { seen = request; return step }
    const client = await clientFor({ closeKit })
    const result = await callCloseKit(client, { base_address: DEST_BASE, bsv_address: DEST_BSV })
    assert.equal(result.isError, undefined, step.state)
    assert.deepEqual(JSON.parse(text(result)), step, step.state)
    assert.deepEqual(seen, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV }, step.state)
    await client.close()
  }
})

test('F17 closeArgs enforces exactly two positional arguments', () => {
  assert.equal(closeArgs([]), undefined)
  assert.equal(closeArgs(['0xonly']), undefined)
  assert.equal(closeArgs(['0xbase', '1bsv', 'extra']), undefined)
  assert.deepEqual(closeArgs(['0xbase', '1bsv']), { baseAddress: '0xbase', bsvAddress: '1bsv' })
})

test('F17 closeCommandLoop exits 0 on closed, 1 on refused, 2 after the deadline, and never sleeps past 300 seconds', async () => {
  const request: CloseKitRequest = { baseAddress: '0xbase', bsvAddress: '1bsv' }
  const logs: string[] = []
  const sleep = async (ms: number): Promise<void> => { sleeps.push(ms) }
  let sleeps: number[] = []

  // closed: exit 0, the JSON report as output.
  {
    const closed: CloseKitStep = { state: 'closed', closed_at: '2026-01-01T00:00:00.000Z', sent: [], final: { usdc: '0', eth_wei: '0', bsv_sats: '0' }, keys_note: 'note' }
    const result = await closeCommandLoop(async () => closed, request, { sleep, log: (line) => logs.push(line) })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(JSON.parse(result.output), closed)
  }

  // refused: exit 1, the reason as output.
  {
    const refused: CloseKitStep = { state: 'refused', reason: 'nope, not today', sent: [] }
    const result = await closeCommandLoop(async () => refused, request, { sleep, log: (line) => logs.push(line) })
    assert.equal(result.exitCode, 1)
    assert.equal(result.output, 'nope, not today')
  }

  // never sleeps longer than 300 seconds per step, even when a step asks for much more.
  {
    sleeps = []
    let calls = 0
    const closed: CloseKitStep = { state: 'closed', closed_at: '2026-01-01T00:00:00.000Z', sent: [], final: { usdc: '0', eth_wei: '0', bsv_sats: '0' }, keys_note: 'note' }
    const step = async (): Promise<CloseKitStep> => {
      calls++
      if (calls > 1) return closed
      return { state: 'in_progress', did: 'did something', next: 'wait a long time', call_again_after_seconds: 9_999, sent: [] }
    }
    const result = await closeCommandLoop(step, request, { sleep, log: (line) => logs.push(line) })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(sleeps, [300_000])
  }

  // after the 3-hour deadline, still in_progress: exit 2 with the "still closing" message, and no sleep.
  {
    sleeps = []
    let now = 0
    const stillGoing: CloseKitStep = { state: 'in_progress', did: 'did something', next: 'wait', call_again_after_seconds: 30, sent: [] }
    const step = async (): Promise<CloseKitStep> => { now += 4 * 60 * 60 * 1000; return stillGoing } // past the 3-hour deadline after this one step
    const result = await closeCommandLoop(step, request, { sleep, log: (line) => logs.push(line), now: () => now })
    assert.equal(result.exitCode, 2)
    assert.equal(result.output, 'still closing; run the same command again')
    assert.deepEqual(sleeps, [])
  }
})

const LOOP_REQUEST: CloseKitRequest = { baseAddress: '0xbase', bsvAddress: '1bsv' }
const CLOSED_STEP: CloseKitStep = { state: 'closed', closed_at: '2026-01-01T00:00:00.000Z', sent: [], final: { usdc: '0', eth_wei: '0', bsv_sats: '0' }, keys_note: 'note' }
const BRIEF_REFUSAL: CloseKitStep = { state: 'refused', reason: 'the indexer timed out', retry_after_seconds: 60, sent: [] }

test('S6 closeCommandLoop tries a refusal that carries retry_after_seconds again, then finishes', async () => {
  const sleeps: number[] = []
  const logs: string[] = []
  let calls = 0
  const step = async (): Promise<CloseKitStep> => (++calls === 1 ? BRIEF_REFUSAL : CLOSED_STEP)
  const result = await closeCommandLoop(step, LOOP_REQUEST, { sleep: async (ms) => { sleeps.push(ms) }, log: (line) => logs.push(line) })
  assert.equal(result.exitCode, 0)
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [60_000])
  assert.deepEqual(logs, ['refused for now: the indexer timed out; trying again in 60 seconds'])
})

test('S6 a brief refusal still there at the 3-hour deadline ends the loop with its reason, printed once', async () => {
  let now = 0
  let calls = 0
  const sleeps: number[] = []
  const logs: string[] = []
  const step = async (): Promise<CloseKitStep> => { calls++; now += 2 * 60 * 60 * 1000; return BRIEF_REFUSAL }
  const result = await closeCommandLoop(step, LOOP_REQUEST, { sleep: async (ms) => { sleeps.push(ms) }, log: (line) => logs.push(line), now: () => now })
  assert.equal(result.exitCode, 1)
  assert.equal(result.output, 'the indexer timed out')
  assert.equal(calls, 2, 'tried again at 2 hours; past the deadline at 4 hours')
  assert.deepEqual(sleeps, [60_000])
  assert.equal(logs.length, 1, 'only the retry is logged; the final refusal is the output')
})

test('N5 a refusal without retry_after_seconds is printed once: it is the output and nothing is logged', async () => {
  const logs: string[] = []
  const sleeps: number[] = []
  const refused: CloseKitStep = { state: 'refused', reason: 'nope, not today', sent: [] }
  const result = await closeCommandLoop(async () => refused, LOOP_REQUEST, { sleep: async (ms) => { sleeps.push(ms) }, log: (line) => logs.push(line) })
  assert.equal(result.exitCode, 1)
  assert.equal(result.output, 'nope, not today')
  assert.deepEqual(logs, [])
  assert.deepEqual(sleeps, [])
})

test('S6 the close loop stops at a refusal only the user can clear instead of trying it again', async () => {
  const permission = Object.assign(new Error("EACCES: permission denied, rename 'close.json'"), { code: 'EACCES' })
  for (const error of [new Error('Base USDC transfer reverted'), new Error('invalid Base withdrawal record'), permission]) {
    const paths = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-close-loop-')))
    let sends = 0
    const kit: BuyerKit = { ...dummyKit(), withdrawBase: async () => { sends++; throw error } }
    const sleeps: number[] = []
    const logs: string[] = []
    // Each sleep moves the clock past the deadline, so a loop that tried again would stop at once instead of spinning.
    let now = 0
    const opts = { sleep: async (ms: number) => { sleeps.push(ms); now += 4 * 60 * 60 * 1000 }, log: (line: string) => logs.push(line), now: () => now }
    const result = await closeCommandLoop((request) => closeKitStep({ kit, paths }, request), { baseAddress: DEST_BASE, bsvAddress: DEST_BSV }, opts)
    assert.deepEqual({ exitCode: result.exitCode, output: result.output, sends, sleeps, logs }, { exitCode: 1, output: error.message, sends: 1, sleeps: [], logs: [] }, error.message)
  }
})

test('S6 the close loop stops at the nonce warning instead of trying it again', async () => {
  const paths = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-close-loop-nonce-')))
  const nonceHash = `0x${'a'.repeat(64)}` as `0x${string}`
  // Real rails through the real withdrawal-intent reconciler, not a stand-in message: no receipt, and a finalized
  // nonce one past the recorded withdrawal's nonce, is what withdrawal-intent.ts treats as a consumed nonce.
  const rails: BuyerWithdrawalRails = {
    receipt: async () => undefined,
    finalizedBlockNumber: async () => 100n,
    nonceAtBlock: async () => 5,
    resendSigned: async () => { throw new Error('resendSigned should not be called: this record has no cancels') },
  }
  const intents = makeBuyerWithdrawalIntents(paths, rails)
  await intents.record({ asset: 'USDC', to: DEST_BASE, amount: 1n, hash: nonceHash, signedTx: `0x${'b'.repeat(64)}`, nonce: 4 })
  const kit: BuyerKit = { ...dummyKit(), reconcileWithdrawals: () => intents.reconcile() }
  const sleeps: number[] = []
  const logs: string[] = []
  // Each sleep moves the clock past the deadline, so a loop that tried again would stop at once instead of spinning.
  let now = 0
  const opts = { sleep: async (ms: number) => { sleeps.push(ms); now += 4 * 60 * 60 * 1000 }, log: (line: string) => logs.push(line), now: () => now }
  const result = await closeCommandLoop((request) => closeKitStep({ kit, paths }, request), { baseAddress: DEST_BASE, bsvAddress: DEST_BSV }, opts)
  assert.equal(result.exitCode, 1)
  assert.match(result.output, /used its nonce but its receipt was not found/)
  assert.deepEqual(sleeps, [])
  assert.deepEqual(logs, [])
})

test('S4 stop_spending refuses the reason close_kit keeps for itself and passes any other reason on', async () => {
  assert.equal(CLOSED_STOP_REASON, 'closed by close_kit')
  const reasons: Array<string | undefined> = []
  const kit: BuyerKit = { ...dummyKit(), stopSpending: async (reason) => { reasons.push(reason); return { alreadyStopped: false, at: 1, ...(reason ? { reason } : {}) } } }
  const reserved = await handleToolCall(kit, 'stop_spending', { reason: CLOSED_STOP_REASON })
  assert.equal(reserved.isError, true)
  assert.equal(JSON.parse(reserved.content[0].text).error, "the reason 'closed by close_kit' is reserved for close_kit; give another reason")
  const tooLong = await handleToolCall(kit, 'stop_spending', { reason: 'x'.repeat(201) })
  assert.equal(JSON.parse(tooLong.content[0].text).error, 'reason must be 200 characters or fewer')
  assert.deepEqual(reasons, [], 'no refused reason reaches the kit')
  for (const reason of ['pause', `${CLOSED_STOP_REASON} later`, undefined]) {
    const result = await handleToolCall(kit, 'stop_spending', reason === undefined ? {} : { reason })
    assert.equal(result.isError, undefined, String(reason))
  }
  assert.deepEqual(reasons, ['pause', `${CLOSED_STOP_REASON} later`, undefined])
})

test('N2 the about resource lists every tool, close_kit included', async () => {
  const client = await clientFor({})
  const about = await client.readResource({ uri: 'petasats://about' })
  const aboutText = (about.contents[0] as { text: string }).text
  const names = (await client.listTools()).tools.map((tool) => tool.name)
  assert.ok(names.includes('close_kit'))
  for (const name of names) assert.match(aboutText, new RegExp(`\\b${name}\\b`), name)
  await client.close()
})
