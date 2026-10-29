import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DoorDeclineError, type BuyerKit, type ConvertRequest, type StartSwapRequest } from 'petasats/sdk'
import { handleToolCall } from '../src/server.js'
import { initResult, isMainModule, startBackgroundRecovery } from '../src/index.js'
import { DOOR_IDENTITY_PLACEHOLDER, initialiseBuyerHome } from '../../src/sdk/buyer/local-state.js'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

test('tool errors redact WIFs, private-key hex, and keys-file paths', async () => {
  const wif = 'L'.padEnd(51, '1'); const hex = `0x${'a'.repeat(64)}`
  const kit = { ...fakePetasats(), quote: async () => { throw new Error(`failed with ${wif} ${hex} at keys.json`) } }
  const result = await handleToolCall(kit, 'get_quote', { from_asset: 'USDC', to_asset: 'BSV', amount_in: '1' })
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text.includes(wif), false)
  assert.equal(result.content[0].text.includes(hex), false)
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
