import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DoorDeclineError, type BuyerKit, type ConvertRequest, type StartSwapRequest } from 'petasats/sdk'
import { isAddress } from 'viem'
import { handleToolCall, TOOLS } from '../src/server.js'
import { initResult, isMainModule, limitsOutput, resumeOutput, startBackgroundRecovery, statusOutput, withdrawalOutput, withdrawalsOutput } from '../src/index.js'
import { DOOR_IDENTITY_PLACEHOLDER, initialiseBuyerHome } from '../../src/sdk/buyer/local-state.js'
import { makeBuyerWithdrawalIntents } from '../../src/sdk/buyer/withdrawal-intent.js'
import { createBuyerKit } from '../../src/sdk/buyer/buyer-kit.js'
import { readSpendingStop, stopSpending } from '../../src/sdk/buyer/stop.js'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** A fake buyer kit: quote doubles the input and startSwap records the request. */
function fakePetasats(sink: { last?: StartSwapRequest } = {}): BuyerKit {
  return {
    quote: async (req) => ({ from: req.from, to: req.to, route: 'bridge', amountIn: req.amountIn, amountOut: req.amountIn * 2n, expiry: 9_999_999_999, quoteId: 'q1' }),
    convert: async (req) => ({ ok: true, route: 'bridge', status: 'pending', txids: { x: 'tx1' } }),
    startSwap: async (request) => { sink.last = request; return { swapId: 'a'.repeat(32), stage: 'quoted', expectedMinutes: 20 } },
    status: async () => [], recover: async () => [], withdrawBsv: async () => ({ sats: 0n }), withdrawBase: async () => ({ asset: 'USDC', amount: 1n, to: '0x1111111111111111111111111111111111111111', txid: '0xtx', status: 'success' }),
    walletInfo: async () => ({ baseAddress: '0xabc', bsvAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', usdc: 1n, eth: 1n, claimedBsvSats: 0n, capUsdPerSwap: 100 }),
  }
}

/** Parse a non-error tool result's JSON payload. */
function payload(r: { content: Array<{ text: string }>; isError?: boolean }): any {
  assert.equal(r.isError, undefined, `unexpected tool error: ${r.content[0]?.text}`)
  return JSON.parse(r.content[0].text)
}

const MCP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('get_quote prices a pair (bigint amounts as strings)', async () => {
  const r = await handleToolCall(fakePetasats(), 'get_quote', { from_asset: 'USDC', to_asset: 'BSV', amount_in: '1000000' })
  const p = payload(r)
  assert.equal(p.route, 'bridge')
  assert.equal(p.from, 'USDC')
  assert.equal(p.to, 'BSV')
  assert.equal(p.amount_in, '1000000')
  assert.equal(p.amount_out, '2000000')
  assert.equal(p.quote_id, 'q1')
  for (const field of ['expires_at', 'usdc_in', 'bsv_out', 'est_bsv_claim_fee_sats', 'est_bsv_received_sats', 'rate_usd_per_bsv', 'market_mid_usd_per_bsv', 'price_vs_mid_percent', 'costs', 'fee_note', 'limits']) assert.ok(field in p, `missing ${field}`)
  assert.deepEqual(p.usdc_in, { atomic: '1000000', display: '1.00 USDC' })
})

test('swap_asset_to_bsv accepts only the phase-1 USDC source', async () => {
  const sink: { last?: StartSwapRequest } = {}
  const r = await handleToolCall(fakePetasats(sink), 'swap_asset_to_bsv', { from_asset: 'USDC', amount_in: '5000', deliver_to: '1BsvAddr', quote_id: 'q1' })
  const p = payload(r)
  assert.equal(p.stage, 'quoted')
  assert.equal(sink.last?.amountIn, 5000n)
  assert.equal(sink.last?.deliverTo, '1BsvAddr')
})

test('swap_asset_to_bsv binds a supplied quote (reconstructed to the SDK Quote)', async () => {
  const sink: { last?: StartSwapRequest } = {}
  const quote = { from: 'USDC', to: 'BSV', route: 'bridge', amount_in: '1000000', amount_out: '2000000', expiry: 9_999_999_999, quote_id: 'q1' }
  const r = await handleToolCall(fakePetasats(sink), 'swap_asset_to_bsv', { from_asset: 'USDC', amount_in: '1000000', deliver_to: '1B', quote })
  payload(r)
  assert.equal(sink.last?.quote?.amountOut, 2000000n)
  assert.equal(sink.last?.quote?.route, 'bridge')
})

test('buyer-kit adapter starts in background and exposes status without secrets', async () => {
  const fake = {
    ...fakePetasats(),
    startSwap: async () => ({ swapId: 'a'.repeat(32), stage: 'quoted' as const, expectedMinutes: 20 }),
    status: async () => [{ swapId: 'a'.repeat(32), requestId: 'r1', stage: 'waiting_bsv_lock' as const, amountIn: '1000000', quote: {} as any, createdAtMs: 1, updatedAtMs: 1 }],
    walletInfo: async () => ({ baseAddress: '0xabc', bsvAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', usdc: 1n, eth: 1n, claimedBsvSats: 0n, capUsdPerSwap: 100 }),
    withdrawBsv: async () => ({ sats: 1n }), withdrawBase: async () => ({ asset: 'USDC' as const, amount: 1n, to: '0x1111111111111111111111111111111111111111', txid: '0xtx', status: 'success' }), recover: async () => [],
  }
  const started = payload(await handleToolCall(fake, 'swap_asset_to_bsv', { from_asset: 'USDC', amount_in: '1000000', quote_id: 'q1' }))
  assert.equal(started.stage, 'quoted')
  const status = payload(await handleToolCall(fake, 'swap_status', { swap_id: 'a'.repeat(32) }))
  assert.equal(status.swaps[0].stage, 'waiting_bsv_lock')
  assert.equal(JSON.stringify(status).includes('secret'), false)
})

test('withdraw_base renders decimal display values rather than raw atomic units', async () => {
  const kit = { ...fakePetasats(), withdrawBase: async () => ({ asset: 'ETH' as const, amount: 199_000_000_000_000n, to: '0x1111111111111111111111111111111111111111', txid: '0xtx', status: 'success' }) }
  const result = payload(await handleToolCall(kit, 'withdraw_base', { asset: 'ETH', to: '0x1111111111111111111111111111111111111111', amount: '1' }))
  assert.deepEqual(result.amount, { atomic: '199000000000000', display: '0.000199 ETH' })
})

test('a door decline is surfaced as structured nothing-locked tool data', async () => {
  const decline = new DoorDeclineError({ code: 'unavailable', retry_hint: 'retry later', message: 'door unavailable', nothing_locked: true })
  const kit = { ...fakePetasats(), quote: async () => { throw decline } }
  const result = await handleToolCall(kit, 'get_quote', { from_asset: 'USDC', to_asset: 'BSV', amount_in: '1000000' })
  assert.equal(result.isError, true)
  assert.deepEqual(JSON.parse(result.content[0].text), { error: { code: 'unavailable', retry_hint: 'retry later', message: 'door unavailable', nothing_locked: true } })
})

test('wallet_info includes the pinned door identity and never serializes private material', async () => {
  const identity = `02${'1'.repeat(64)}`
  const result = payload(await handleToolCall(fakePetasats(), 'wallet_info', {}, { doorIdentity: identity }))
  assert.equal(result.door_identity, identity)
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('stop_spending is registered, idempotent, and fund_wallet asks the core planning guard with amount_in', async () => {
  const tool = TOOLS.find((item) => item.name === 'stop_spending')
  assert.deepEqual(tool?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true })
  let planned = ''; let plannedAmount: bigint | undefined; let stopped = ''
  const kit = { ...fakePetasats(), assertCanPlanSwap: async (address: string, amount: bigint) => { planned = address; plannedAmount = amount }, stopSpending: async (reason?: string) => { stopped = reason ?? ''; return { alreadyStopped: false, at: 1, reason } } }
  payload(await handleToolCall(kit, 'fund_wallet', { bsv_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', amount_in: '1' }))
  assert.equal(planned, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT')
  assert.equal(plannedAmount, 1n)
  assert.equal(payload(await handleToolCall(kit, 'stop_spending', { reason: 'pause' })).stopped, true); assert.equal(stopped, 'pause')
})

test('background recovery starts immediately without blocking and serializes overlapping ticks', async () => {
  let recoveries = 0; let release!: () => void
  const kit = { ...fakePetasats(), recover: async () => { recoveries++; await new Promise<void>((resolve) => { release = resolve }); return [] } }
  const stop = startBackgroundRecovery(kit, 1)
  assert.equal(recoveries, 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(recoveries, 1)
  release(); stop()
})

test('init reports public addresses and changes its next step when a door identity is baked in', () => {
  const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-mcp-init-')))
  const first = initResult(home)
  assert.match(String(first.base_address), /^0x[0-9a-f]{40}$/i)
  assert.match(String(first.bsv_address), /^1/)
  assert.match(String(first.next), /set config\.json doorIdentity/)
  const config = JSON.parse(readFileSync(home.configPath, 'utf8'))
  assert.equal(config.doorIdentity, DOOR_IDENTITY_PLACEHOLDER)
  config.doorIdentity = `02${'1'.repeat(64)}`
  writeFileSync(home.configPath, JSON.stringify(config))
  assert.match(String(initResult(home).next), /fund the Base address with USDC/)
})

test('tool errors redact WIFs, private-key hex, signed data, and keys-file paths', async () => {
  const wif = 'L'.padEnd(51, '1'); const hex = `0x${'a'.repeat(64)}`; const signedData = `0x${'b'.repeat(200)}`
  const kit = { ...fakePetasats(), quote: async () => { throw new Error(`failed with ${wif} ${hex} ${signedData} at keys.json`) } }
  const result = await handleToolCall(kit, 'get_quote', { from_asset: 'USDC', to_asset: 'BSV', amount_in: '1' })
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text.includes(wif), false)
  assert.equal(result.content[0].text.includes(hex), false)
  assert.equal(result.content[0].text.includes(signedData), false)
  assert.equal(result.content[0].text.includes('[redacted signed data]'), true)
  assert.equal(result.content[0].text.includes('b'.repeat(20)), false)
  assert.equal(result.content[0].text.includes('keys.json'), false)
})

test('swap_asset_to_bsv rejects BSV as the source', async () => {
  const r = await handleToolCall(fakePetasats(), 'swap_asset_to_bsv', { from_asset: 'BSV', amount_in: '5000', deliver_to: '1B' })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /not available/)
})

test('fund_wallet returns a quote + the swap_call to run', async () => {
  const r = await handleToolCall(fakePetasats(), 'fund_wallet', { bsv_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', amount_in: '1000000' })
  const p = payload(r)
  assert.equal(p.quote.to, 'BSV')
  assert.equal(p.swap_call.tool, 'swap_asset_to_bsv')
  assert.equal(p.swap_call.deliver_to, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT')
  assert.equal(p.swap_call.from_asset, 'USDC') // default source
})

test('fund_wallet rejects an invalid BSV address and swap_asset_to_bsv rejects zero or unbounded slippage floors', async () => {
  const sink: { last?: StartSwapRequest } = {}
  const kit = fakePetasats(sink)
  const badAddress = await handleToolCall(kit, 'fund_wallet', { bsv_address: '1Fund', amount_in: '1000000' })
  assert.equal(badAddress.isError, true)
  assert.match(badAddress.content[0].text, /mainnet Base58Check P2PKH/)
  for (const min_bsv_out of ['0', '2100000000000001']) {
    const r = await handleToolCall(kit, 'swap_asset_to_bsv', { from_asset: 'USDC', amount_in: '5000', min_bsv_out })
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /positive bounded sats integer/)
  }
  assert.equal(sink.last, undefined)
})

test('list_liquidity returns the non-custodial pair matrix; filter narrows it', async () => {
  const all = payload(await handleToolCall(fakePetasats(), 'list_liquidity', {}))
  assert.equal(all.non_custodial, true)
  assert.equal(all.count, 1)
  const usdc = payload(await handleToolCall(fakePetasats(), 'list_liquidity', { asset: 'USDC' }))
  assert.equal(usdc.count, 1)
  assert.equal(usdc.pairs[0].route, 'bridge')
})

test('fail-closed: bad asset, bad amount, unknown tool', async () => {
  assert.equal((await handleToolCall(fakePetasats(), 'get_quote', { from_asset: 'XRP', to_asset: 'BSV', amount_in: '1' })).isError, true)
  assert.equal((await handleToolCall(fakePetasats(), 'get_quote', { from_asset: 'USDC', to_asset: 'BSV', amount_in: 'not-a-number' })).isError, true)
  assert.equal((await handleToolCall(fakePetasats(), 'nope', {})).isError, true)
})

test('get_quote honestly refuses a non-phase-1 pair', async () => {
  const r = await handleToolCall(fakePetasats(), 'get_quote', { from_asset: 'USDC', to_asset: 'USDT', amount_in: '1000000' })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /not available/)
})

test('the entry point runs when started through a symlinked bin (npm global install)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'petasats-main-'))
  const real = join(dir, 'petasats-mcp.mjs'); writeFileSync(real, '')
  const link = join(dir, 'petasats-mcp'); symlinkSync(real, link)
  assert.equal(isMainModule(link, pathToFileURL(real).href), true)
  assert.equal(isMainModule(real, pathToFileURL(real).href), true)
  assert.equal(isMainModule(join(dir, 'other.mjs'), pathToFileURL(real).href), false)
  assert.equal(isMainModule(undefined, pathToFileURL(real).href), false)
})

test('init prints absolute MCP launch paths', () => {
  const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-init-mcp-')))
  const mcp = initResult(home).mcp as { command: string; args: string[] }
  assert.equal(mcp.command, process.execPath)
  assert.equal(mcp.args.length, 1)
  assert.match(mcp.args[0], /^\//)
})

test('a 0.2.2 home without withdrawals works with status, limits, and resume CLI handlers', async () => {
  const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-mcp-old-home-')))
  const config = JSON.parse(readFileSync(home.configPath, 'utf8'))
  config.doorIdentity = `02${'1'.repeat(64)}`
  writeFileSync(home.configPath, JSON.stringify(config)); chmodSync(home.configPath, 0o600)
  rmdirSync(home.withdrawalsDir)
  assert.deepEqual(JSON.parse(await statusOutput(home)), { swaps: [] })
  assert.equal(limitsOutput(home), 'none')
  writeFileSync(home.stopPath, '{'); chmodSync(home.stopPath, 0o600)
  assert.equal(resumeOutput(home), 'removed invalid STOP; spending resumed')
  assert.equal(existsSync(home.stopPath), false)
  const limits = { format: 'not-a-limit' }
  writeFileSync(home.limitsPath, JSON.stringify(limits)); chmodSync(home.limitsPath, 0o600)
  const renderedLimits = limitsOutput(home)
  assert.match(renderedLimits, /^limits\.json format must be petasats\.limits\/1$/)
  assert.equal(renderedLimits.includes('refused by your limits file'), false)
  assert.equal(existsSync(home.withdrawalsDir), false)
})

test('withdrawals CLI lists no signed bytes and only resolves a nonce-consumed record', async () => {
  const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-mcp-withdrawals-')))
  const hash = `0x${'a'.repeat(64)}` as `0x${string}`; const signed = `0x${'b'.repeat(64)}` as `0x${string}`
  const intents = makeBuyerWithdrawalIntents(home, { finalizedBlockNumber: async () => 10n, nonceAtBlock: async () => 2, receipt: async () => undefined, resendSigned: async () => hash })
  await intents.record({ asset: 'USDC', to: '0x1111111111111111111111111111111111111111', amount: 1n, hash, signedTx: signed, nonce: 1 })
  await assert.rejects(withdrawalOutput(hash, 'sent', home), /may still land; wait for it to confirm/)
  await assert.rejects(intents.reconcile(), /used its nonce but its receipt was not found/)
  writeFileSync(join(home.withdrawalsDir, `${hash}.lock`), JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + '\n', { mode: 0o600 })
  const listed = withdrawalsOutput(home)
  assert.match(listed, /nonce-consumed-requires-user-outcome/); assert.equal(listed.includes(signed), false)
  unlinkSync(join(home.withdrawalsDir, `${hash}.lock`))
  assert.equal(JSON.parse(await withdrawalOutput(hash, 'not-sent', home)).outcome, 'not-sent')
  assert.deepEqual(JSON.parse(withdrawalsOutput(home)), { withdrawals: [] })
})

test('T4 withdrawal CLI preserves the stored outcome and refuses a conflicting one', async () => {
  const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-mcp-withdrawal-outcome-')))
  const hash = `0x${'a'.repeat(64)}` as `0x${string}`; const signed = `0x${'b'.repeat(64)}` as `0x${string}`
  const intents = makeBuyerWithdrawalIntents(home, { finalizedBlockNumber: async () => 10n, nonceAtBlock: async () => 2, receipt: async () => undefined, resendSigned: async () => hash })
  await intents.record({ asset: 'USDC', to: '0x1111111111111111111111111111111111111111', amount: 1n, hash, signedTx: signed, nonce: 1 }); await intents.reconcile().catch(() => {})
  assert.equal(JSON.parse(await withdrawalOutput(hash, 'sent', home)).outcome, 'sent')
  await assert.rejects(withdrawalOutput(hash, 'not-sent', home), /already recorded as sent; nothing changed/)
})

test('the limits README Base address is a copyable 40-hex address', () => {
  // The development tree keeps the README as a template; the published repository has it at its root.
  const readme = [join(MCP_ROOT, 'public', 'template', 'README.md'), join(MCP_ROOT, '..', 'README.md')].find((path) => existsSync(path))
  assert.ok(readme)
  const template = readFileSync(readme, 'utf8')
  const address = template.match(/"baseDestinations": \["(0x[0-9a-fA-F]+)"\]/)?.[1]
  assert.ok(address)
  assert.match(address!, /^0x[0-9a-fA-F]{40}$/)
  assert.equal(isAddress(address!, { strict: true }), true)
})

function guardedCore(home: ReturnType<typeof initialiseBuyerHome>, limits: () => any = () => undefined) {
  return createBuyerKit({}, {
    limits, spendingStopped: () => readSpendingStop(home), stopSpending: (reason) => stopSpending(home, reason),
    store: { list: async () => [], get: async () => undefined, put: async () => {} },
    wallet: { baseAddress: '0x2222222222222222222222222222222222222222', bsvAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', balances: async () => ({ usdc: 1n, eth: 1n, claimedBsvSats: 0n }), withdrawBsv: async () => ({ sats: 0n }), transferUsdc: async () => ({ hash: `0x${'a'.repeat(64)}`, status: 'success' }) },
    door: { quote: async () => ({ quoteId: 'q'.repeat(16), bsvSats: 1, usdcBaseUnits: '1', expiresAtMs: Date.now() + 60_000 }), admit: async () => ({ swapNamespace: 'a'.repeat(32), handshakeDeadlineMs: Date.now() + 60_000 }) }, executor: { execute: async () => ({ ok: true }) },
  })
}

test('S3 every MCP tool leaves STOP in place', async () => {
  const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-mcp-stop-'))); stopSpending(home, 'pause', 1)
  const args: Record<string, Record<string, unknown>> = {
    get_quote: { from_asset: 'USDC', to_asset: 'BSV', amount_in: '1' }, swap_asset_to_bsv: { from_asset: 'USDC', amount_in: '1', min_bsv_out: '1' }, wait_for_swap: { swap_id: 'x', max_wait_seconds: 1 }, swap_status: {}, wallet_info: {}, stop_spending: { reason: 'again' }, withdraw_bsv: { address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }, withdraw_base: { asset: 'USDC', to: '0x1111111111111111111111111111111111111111', amount: '1' }, fund_wallet: { bsv_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', amount_in: '1' }, list_liquidity: {},
  }
  for (const tool of TOOLS) { await handleToolCall(guardedCore(home), tool.name, args[tool.name]); assert.equal(existsSync(home.stopPath), true, tool.name) }
})

test('S2 STOP leaves every read-only MCP tool available', async () => {
  const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-mcp-read-stop-'))); stopSpending(home, 'pause', 1)
  const terminal = { swapId: 'a'.repeat(32), requestId: 'r', stage: 'settled' as const, amountIn: '1', quote: {} as any, createdAtMs: 1, updatedAtMs: 1 }
  const readable = { ...guardedCore(home), status: async () => [terminal] }
  for (const [tool, args] of [
    ['get_quote', { from_asset: 'USDC', to_asset: 'BSV', amount_in: '1' }], ['swap_status', {}], ['wait_for_swap', { swap_id: terminal.swapId, max_wait_seconds: 1 }], ['wallet_info', {}], ['list_liquidity', {}],
  ] as const) assert.equal((await handleToolCall(readable, tool, args)).isError, undefined, tool)
})

test('M1 fund_wallet sends STOP and limits refusals to the tool result, and wallet_info carries stop and limits fields', async () => {
  const stoppedHome = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-mcp-refusal-'))); stopSpending(stoppedHome, 'pause', 9)
  const stopped = await handleToolCall(guardedCore(stoppedHome), 'fund_wallet', { bsv_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', amount_in: '1' })
  assert.equal(stopped.isError, true); assert.match(stopped.content[0].text, /spending is stopped/)
  const limitsHome = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-mcp-limit-')))
  const limited = await handleToolCall(guardedCore(limitsHome, () => ({ format: 'petasats.limits/1', bsvDestinations: [] })), 'fund_wallet', { bsv_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', amount_in: '1' })
  assert.equal(limited.isError, true); assert.match(limited.content[0].text, /bsvDestinations/)
  const info = payload(await handleToolCall(guardedCore(stoppedHome, () => ({ format: 'petasats.limits/1', maxSwapUsdPerDay: 3 })), 'wallet_info', {}))
  assert.deepEqual({ spending_stopped: info.spending_stopped, stopped_at: info.stopped_at, stop_reason: info.stop_reason, limits: info.limits }, { spending_stopped: true, stopped_at: 9, stop_reason: 'pause', limits: { format: 'petasats.limits/1', maxSwapUsdPerDay: 3 } })
})
