import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'mocha'
import { createBuyerKit } from '../../src/sdk/buyer/buyer-kit'
import { DoorDeclineError, mapDoorDecline } from '../../src/sdk/buyer/door-client'
import { initialiseBuyerHome } from '../../src/sdk/buyer/local-state'
import { createBuyerRuntime } from '../../src/sdk/buyer/runtime/runtime'
import type { BuyerSwapRecord, DoorClient } from '../../src/sdk/buyer/types'

const hinted = (reason: string, seconds: number) => new DoorDeclineError(mapDoorDecline(`${reason} (retry after ${seconds}s)`))
const plain = (reason: string) => new DoorDeclineError(mapDoorDecline(reason))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(input: {
  door: DoorClient
  now?: () => number
  stopped?: () => { at: number } | undefined
  signal?: AbortSignal
  wait?: (ms: number, shouldStop: () => boolean, signal?: AbortSignal) => Promise<boolean>
  execute?: () => Promise<{ ok: boolean }>
  log?: (line: string) => void
}) {
  const rows = new Map<string, BuyerSwapRecord>()
  let executions = 0
  const kit = createBuyerKit({ now: input.now ?? (() => 1_000) }, {
    door: input.door,
    store: { list: async () => [...rows.values()], get: async (id) => rows.get(id), put: async (row) => { rows.set(row.swapId, structuredClone(row)) } },
    executor: { execute: async () => { executions++; return input.execute ? input.execute() : { ok: true } } },
    wallet: { baseAddress: '0xabc', bsvAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', balances: async () => ({ usdc: 25_000_000n, eth: 1n, claimedBsvSats: 0n }) },
    spendingStopped: input.stopped, retrySignal: input.signal, retryWait: input.wait, log: input.log,
  })
  return { kit, rows, executions: () => executions }
}

const successfulQuote = (amount: bigint, expiresAtMs = 100_000) => ({ quoteId: 'q'.repeat(16), bsvSats: 10_000, usdcBaseUnits: amount.toString(), expiresAtMs })

describe('buyer door bounded retry', () => {
  it('quote waits at most twice, never exceeds the 20s hint or 45s total bounds, and logs each retry', async () => {
    let calls = 0; const waits: number[] = []; const logs: string[] = []
    const h = harness({
      door: { quote: async () => { calls++; throw hinted('pricer declined quote', 20) }, admit: async () => { throw new Error('unused') } },
      wait: async (ms) => { waits.push(ms); return true }, log: (line) => logs.push(line),
    })
    await assert.rejects(() => h.kit.quote({ from: 'USDC', to: 'BSV', amountIn: 1_000_000n, deliverTo: '' }), DoorDeclineError)
    assert.equal(calls, 3); assert.deepEqual(waits, [20_000, 20_000]); assert.ok(waits.reduce((sum, ms) => sum + ms, 0) <= 45_000)
    assert.equal(logs.length, 2); assert.ok(logs.every((line) => line.includes('pricer declined quote') && line.includes('20s')))
  })

  it('quote never retries an absent or over-20s hint', async () => {
    for (const error of [plain('pricer declined quote'), hinted('pricer declined quote', 21)]) {
      let calls = 0; let waits = 0
      const h = harness({ door: { quote: async () => { calls++; throw error }, admit: async () => { throw new Error('unused') } }, wait: async () => { waits++; return true } })
      await assert.rejects(() => h.kit.quote({ from: 'USDC', to: 'BSV', amountIn: 1_000_000n, deliverTo: '' }), DoorDeclineError)
      assert.equal(calls, 1); assert.equal(waits, 0)
    }
  })

  it('a close signal ends an active quote wait without another request', async () => {
    const lifecycle = new AbortController(); let calls = 0; let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const h = harness({ signal: lifecycle.signal, door: { quote: async () => { calls++; throw hinted('pricer declined quote', 10) }, admit: async () => { throw new Error('unused') } }, log: () => entered() })
    const quote = h.kit.quote({ from: 'USDC', to: 'BSV', amountIn: 1_000_000n, deliverTo: '' })
    await waiting; lifecycle.abort()
    await assert.rejects(() => quote, DoorDeclineError); assert.equal(calls, 1)
  })

  it('runtime close aborts its active quote wait and closes the engine without another request', async () => {
    const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-retry-close-')))
    writeFileSync(home.configPath, JSON.stringify({ doorIdentity: `02${'1'.repeat(64)}`, baseRpcUrls: ['http://synthetic.invalid'], bsvSources: [], anvilHost: 'http://synthetic.invalid', capUsdPerSwap: 100 }))
    let calls = 0; let engineCloses = 0; let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const runtime = await createBuyerRuntime({ home: home.home, log: (line) => { if (line.includes('retrying door quote')) entered() }, factories: {
      makeIdentityOnlyWallet: () => ({}) as any,
      makeAnvilMessageBoxComms: () => ({}) as any,
      makeMessageBoxDoorClient: () => ({ quote: async () => { calls++; throw hinted('quote capacity busy', 10) }, admit: async () => { throw new Error('unused') } }),
      makeBuyerEvmRails: async () => ({ client: {} as any, balances: async () => ({ usdc: 0n, eth: 0n }), assertSafeForNewLock: () => {}, pool: {} as any }),
      makeBuyerBsvRails: () => ({ chainTracker: {} as any }) as any,
      makeBuyerEngine: () => ({ execute: async () => ({ ok: true }), recoverAll: async () => new Map(), close: () => { engineCloses++ } }),
    } as any })
    const rejected = assert.rejects(runtime.kit.quote({ from: 'USDC', to: 'BSV', amountIn: 1_000_000n, deliverTo: '' }), DoorDeclineError)
    await waiting; runtime.close(); await rejected
    assert.equal(calls, 1); assert.equal(engineCloses, 1)
  })

  it('STOP appearing during a quote wait ends it without another request', async () => {
    let stopped = false; let calls = 0
    const h = harness({ stopped: () => stopped ? { at: 1 } : undefined, door: { quote: async () => { calls++; throw hinted('quote capacity busy', 10) }, admit: async () => { throw new Error('unused') } }, wait: async () => { stopped = true; return true } })
    await assert.rejects(() => h.kit.quote({ from: 'USDC', to: 'BSV', amountIn: 1_000_000n, deliverTo: '' }), DoorDeclineError)
    assert.equal(calls, 1)
  })

  it('admission retries the same quoteId and requestId while the durable row remains quoted', async () => {
    const attempts: Array<{ quoteId: string; requestId: string }> = []; const waits: number[] = []; let observedStage = ''
    let h!: ReturnType<typeof harness>
    h = harness({
      door: {
        quote: async (amount) => successfulQuote(amount),
        admit: async (quoteId, _amount, requestId) => { attempts.push({ quoteId, requestId }); if (attempts.length < 3) throw hinted('in-flight limit exceeded', 20); return { swapNamespace: 'a'.repeat(32), handshakeDeadlineMs: 90_000 } },
      },
      wait: async (ms) => { waits.push(ms); observedStage = [...h.rows.values()][0]?.stage ?? ''; return true },
    })
    const started = await h.kit.startSwap({ amountIn: 1_000_000n, minBsvOut: 1n })
    for (let i = 0; i < 10 && (await h.kit.status(started.swapId))[0].stage === 'quoted'; i++) await tick()
    assert.deepEqual(waits, [20_000, 20_000]); assert.equal(observedStage, 'quoted'); assert.equal(attempts.length, 3)
    assert.ok(attempts.every((attempt) => attempt.quoteId === attempts[0].quoteId && attempt.requestId === attempts[0].requestId))
    assert.equal((await h.kit.status(started.swapId))[0].stage, 'settled'); assert.equal(h.executions(), 1)
  })

  it('startSwap retries its quote before creating a durable row', async () => {
    let quotes = 0; let rowsDuringWait = -1; let h!: ReturnType<typeof harness>
    h = harness({
      door: {
        quote: async (amount) => { quotes++; if (quotes === 1) throw hinted('quote capacity busy', 10); return successfulQuote(amount) },
        admit: async () => ({ swapNamespace: 'a'.repeat(32), handshakeDeadlineMs: 90_000 }),
      },
      wait: async () => { rowsDuringWait = h.rows.size; return true },
    })
    const started = await h.kit.startSwap({ amountIn: 1_000_000n, minBsvOut: 1n })
    for (let i = 0; i < 10 && (await h.kit.status(started.swapId))[0].stage === 'quoted'; i++) await tick()
    assert.equal(quotes, 2); assert.equal(rowsDuringWait, 0); assert.equal((await h.kit.status(started.swapId))[0].stage, 'settled')
  })

  it('does not wait when the bound quote cannot survive wait plus five seconds', async () => {
    let admissions = 0; let waits = 0
    const h = harness({
      door: { quote: async (amount) => successfulQuote(amount, 21_000), admit: async () => { admissions++; throw hinted('in-flight limit exceeded', 15) } },
      wait: async () => { waits++; return true },
    })
    const started = await h.kit.startSwap({ amountIn: 1_000_000n, minBsvOut: 1n }); await tick(); await tick()
    const row = (await h.kit.status(started.swapId))[0]
    assert.equal(row.stage, 'failed'); assert.equal(admissions, 1); assert.equal(waits, 0); assert.equal(h.executions(), 0)
  })

  it('a wait that ends too late for the bound quote sends no further admission request', async () => {
    for (const [wokeAt, expectedAdmissions] of [[18_000, 1], [16_000, 2]] as const) {
      let now = 1_000; let admissions = 0
      const h = harness({
        now: () => now,
        door: { quote: async (amount) => successfulQuote(amount, 22_000), admit: async () => { admissions++; if (admissions === 1) throw hinted('in-flight limit exceeded', 15); return { swapNamespace: 'a'.repeat(32), handshakeDeadlineMs: 90_000 } } },
        wait: async () => { now = wokeAt; return true },
      })
      const started = await h.kit.startSwap({ amountIn: 1_000_000n, minBsvOut: 1n })
      for (let i = 0; i < 10 && (await h.kit.status(started.swapId))[0].stage === 'quoted'; i++) await tick()
      assert.equal(admissions, expectedAdmissions, `woke at ${wokeAt}`)
      assert.equal((await h.kit.status(started.swapId))[0].stage, expectedAdmissions === 1 ? 'failed' : 'settled'); assert.equal(h.executions(), expectedAdmissions - 1)
    }
  })

  it('STOP during admission wait leaves no second admission or lock, with no intermediate stage', async () => {
    let stopped = false; let admissions = 0; let stageDuringWait = ''
    let h!: ReturnType<typeof harness>
    h = harness({
      stopped: () => stopped ? { at: 1 } : undefined,
      door: { quote: async (amount) => successfulQuote(amount), admit: async () => { admissions++; throw hinted('in-flight limit exceeded', 10) } },
      wait: async () => { stageDuringWait = [...h.rows.values()][0]?.stage ?? ''; stopped = true; return true },
    })
    const started = await h.kit.startSwap({ amountIn: 1_000_000n, minBsvOut: 1n }); await tick(); await tick()
    assert.equal(stageDuringWait, 'quoted'); assert.equal(admissions, 1); assert.equal(h.executions(), 0); assert.equal((await h.kit.status(started.swapId))[0].stage, 'failed')
  })

  it('never retries after admission or after the executor lock path begins', async () => {
    let admissions = 0; let waits = 0
    const h = harness({
      door: { quote: async (amount) => successfulQuote(amount), admit: async () => { admissions++; return { swapNamespace: 'a'.repeat(32), handshakeDeadlineMs: 90_000 } } },
      execute: async () => { throw hinted('in-flight limit exceeded', 10) }, wait: async () => { waits++; return true },
    })
    const started = await h.kit.startSwap({ amountIn: 1_000_000n, minBsvOut: 1n }); await tick(); await tick()
    assert.equal(admissions, 1); assert.equal(h.executions(), 1); assert.equal(waits, 0); assert.equal((await h.kit.status(started.swapId))[0].stage, 'failed')
  })
})
