import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  resolveRoute, createPetaSats, isErc20, isBsv21,
  type Asset, type Quote, type RouteBackend, type ConvertRequest, type SwapResult,
} from '../../src/sdk/convert'

const PDEX: Asset = { bsv21: 'ee388dea2f15337d9f89f6db0f9037994cba680e986c38c1f1437956359bdc2_0' }
const PDEX2: Asset = { bsv21: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff_1' }

describe('convert SDK — route resolution (fail-closed)', () => {
  it('routes ERC-20 ↔ BSV to the bridge (both directions)', () => {
    expect(resolveRoute('USDC', 'BSV')).to.equal('bridge')
    expect(resolveRoute('BSV', 'USDT')).to.equal('bridge')
    expect(resolveRoute('cbBTC', 'BSV')).to.equal('bridge')
  })
  it('routes BSV ↔ BSV-21 to the DEX (both directions)', () => {
    expect(resolveRoute('BSV', PDEX)).to.equal('dex')
    expect(resolveRoute(PDEX, 'BSV')).to.equal('dex')
  })
  it('throws on same-asset and no-direct-route pairs', () => {
    expect(() => resolveRoute('BSV', 'BSV')).to.throw(/unsupported/)
    expect(() => resolveRoute('USDC', 'USDT')).to.throw(/ERC-20↔ERC-20/)
    expect(() => resolveRoute(PDEX, PDEX)).to.throw(/BSV-21↔BSV-21/)
    expect(() => resolveRoute('USDC', PDEX)).to.throw(/ERC-20↔BSV-21/)
  })
  it('type guards classify assets', () => {
    expect(isErc20('USDC')).to.equal(true)
    expect(isErc20('BSV')).to.equal(false)
    expect(isBsv21(PDEX)).to.equal(true)
    expect(isBsv21('USDC')).to.equal(false)
  })
})

// ── fakes: record which backend was hit ──
function fakeBackend(tag: string, calls: string[]): RouteBackend {
  return {
    async quote(req): Promise<Quote> {
      calls.push(`${tag}:quote`)
      return { from: req.from, to: req.to, route: tag === 'bridge' ? 'bridge' : 'dex', amountIn: req.amountIn, amountOut: req.amountIn, expiry: 9_999_999_999, quoteId: `${tag}-q` }
    },
    async execute(_req: ConvertRequest): Promise<SwapResult> {
      calls.push(`${tag}:execute`)
      return { ok: true, route: tag === 'bridge' ? 'bridge' : 'dex', txids: { x: `${tag}-tx` } }
    },
  }
}

describe('convert SDK — dispatch + fail-closed gates', () => {
  const mk = () => {
    const calls: string[] = []
    const sdk = createPetaSats({ bridge: fakeBackend('bridge', calls), dex: fakeBackend('dex', calls), now: () => 1_000 })
    return { sdk, calls }
  }

  it('dispatches to the bridge backend for USDC→BSV', async () => {
    const { sdk, calls } = mk()
    const r = await sdk.convert({ from: 'USDC', to: 'BSV', amountIn: 10_000n, deliverTo: '1abc' })
    expect(r.ok).to.equal(true)
    expect(r.route).to.equal('bridge')
    expect(calls).to.deep.equal(['bridge:execute'])
  })

  it('dispatches to the DEX backend for BSV→BSV-21', async () => {
    const { sdk, calls } = mk()
    await sdk.quote({ from: 'BSV', to: PDEX, amountIn: 5n, deliverTo: '1ord' })
    expect(calls).to.deep.equal(['dex:quote'])
  })

  it('fail-closed: rejects a non-positive amount', async () => {
    const { sdk } = mk()
    let err: Error | undefined
    try { await sdk.convert({ from: 'USDC', to: 'BSV', amountIn: 0n, deliverTo: '1abc' }) } catch (e) { err = e as Error }
    expect(err?.message).to.match(/positive bigint/)
  })

  it('fail-closed: rejects an expired supplied quote', async () => {
    const { sdk } = mk()
    const stale: Quote = { from: 'USDC', to: 'BSV', route: 'bridge', amountIn: 10_000n, amountOut: 1n, expiry: 999, quoteId: 'old' }
    let err: Error | undefined
    try { await sdk.convert({ from: 'USDC', to: 'BSV', amountIn: 10_000n, deliverTo: '1abc', quote: stale }) } catch (e) { err = e as Error }
    expect(err?.message).to.match(/expired/)
  })

  it('fail-closed: rejects a quote whose route ≠ the request route', async () => {
    const { sdk } = mk()
    const wrong: Quote = { from: 'BSV', to: PDEX, route: 'dex', amountIn: 10_000n, amountOut: 1n, expiry: 9_999_999_999, quoteId: 'dexq' }
    let err: Error | undefined
    try { await sdk.convert({ from: 'USDC', to: 'BSV', amountIn: 10_000n, deliverTo: '1abc', quote: wrong }) } catch (e) { err = e as Error }
    expect(err?.message).to.match(/different route/)
  })

  it('fail-closed: rejects a same-route quote for the WRONG direction (replay guard)', async () => {
    const { sdk, calls } = mk()
    // a bridge quote for BSV→USDC replayed into a USDC→BSV request — same route, opposite direction
    const wrongDir: Quote = { from: 'BSV', to: 'USDC', route: 'bridge', amountIn: 10_000n, amountOut: 5n, expiry: 9_999_999_999, quoteId: 'x' }
    let err: Error | undefined
    try { await sdk.convert({ from: 'USDC', to: 'BSV', amountIn: 10_000n, deliverTo: '1abc', quote: wrongDir }) } catch (e) { err = e as Error }
    expect(err?.message).to.match(/different pair/)
    expect(calls).to.have.length(0)
  })

  it('fail-closed: rejects a quote whose amountIn ≠ the request amountIn (stale-amount replay)', async () => {
    const { sdk, calls } = mk()
    const staleAmt: Quote = { from: 'USDC', to: 'BSV', route: 'bridge', amountIn: 10_000n, amountOut: 5n, expiry: 9_999_999_999, quoteId: 'x' }
    let err: Error | undefined
    try { await sdk.convert({ from: 'USDC', to: 'BSV', amountIn: 5_000_000n, deliverTo: '1abc', quote: staleAmt }) } catch (e) { err = e as Error }
    expect(err?.message).to.match(/amountIn/)
    expect(calls).to.have.length(0)
  })

  it('accepts a fully-bound supplied quote (route + pair + amountIn all match)', async () => {
    const { sdk, calls } = mk()
    const good: Quote = { from: 'USDC', to: 'BSV', route: 'bridge', amountIn: 10_000n, amountOut: 5n, expiry: 9_999_999_999, quoteId: 'ok' }
    const r = await sdk.convert({ from: 'USDC', to: 'BSV', amountIn: 10_000n, deliverTo: '1abc', quote: good })
    expect(r.ok).to.equal(true)
    expect(calls).to.deep.equal(['bridge:execute'])
  })

  it('fail-closed: rejects a BSV-21 quote for the WRONG token, same route (assetsEqual genesis-id guard)', async () => {
    const { sdk, calls } = mk()
    // a dex quote for selling token PDEX2 replayed into a request selling token PDEX — same route, different token
    const wrongTok: Quote = { from: PDEX2, to: 'BSV', route: 'dex', amountIn: 5n, amountOut: 100n, expiry: 9_999_999_999, quoteId: 'x' }
    let err: Error | undefined
    try { await sdk.convert({ from: PDEX, to: 'BSV', amountIn: 5n, deliverTo: '1x', quote: wrongTok }) } catch (e) { err = e as Error }
    expect(err?.message).to.match(/different pair/)
    expect(calls).to.have.length(0)
  })

  it('fail-closed: an unsupported pair never reaches a backend', async () => {
    const { sdk, calls } = mk()
    let err: Error | undefined
    try { await sdk.quote({ from: 'USDC', to: 'USDT', amountIn: 10_000n, deliverTo: '0xabc' }) } catch (e) { err = e as Error }
    expect(err?.message).to.match(/ERC-20↔ERC-20/)
    expect(calls).to.have.length(0)
  })
})
