import { describe, it } from 'mocha'
import { expect } from 'chai'
import { DEFAULT_BUYER_ANVIL_BASE_URL, makeBuyerBsvRails } from '../../src/sdk/buyer/runtime/bsv-rails'
import { BSV_MAINNET_CHAINTRACKS_URL } from '../../src/wallet/anvil-chaintracks'

const ANVIL = new URL(DEFAULT_BUYER_ANVIL_BASE_URL).host
const WOC = 'api.whatsonchain.com'
const THIRD = new URL(BSV_MAINNET_CHAINTRACKS_URL).host
const ROOT = 'aa'.repeat(32)
const OTHER = 'bb'.repeat(32)
const H = 800_000

/** What one source holds: its tip, and its root at H ('gap' = no header there). */
interface SourceState { tip: number | 'down'; rootAtH?: string | 'gap' }

/** Each host answers only from its own state; a request to any other host fails the test. */
function worldFetch(world: Record<string, SourceState>, seen: Array<{ host: string; auth: string | null }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    seen.push({ host: url.host, auth: new Headers(init?.headers).get('authorization') })
    const state = world[url.host]
    if (!state) throw new Error(`unexpected host ${url.host}`)
    if (state.tip === 'down') throw new Error('synthetic outage')
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
    if (url.host === WOC) {
      if (url.pathname.endsWith('/block/headers')) return json([{ height: state.tip }])
      const m = /\/block\/(\d+)\/header$/.exec(url.pathname)
      if (m && Number(m[1]) === H) {
        if (state.rootAtH === undefined || state.rootAtH === 'gap') return json({ error: 'not found' }, 404)
        return json({ hash: 'cc'.repeat(32), height: H, version: 1, merkleroot: state.rootAtH, time: 1, nonce: 1, bits: '1d00ffff', previousblockhash: 'dd'.repeat(32) })
      }
      throw new Error(`unexpected WhatsOnChain path ${url.pathname}`)
    }
    if (url.pathname === '/getPresentHeight') return json({ status: 'success', value: state.tip })
    if (url.pathname === '/findHeaderHexForHeight' && Number(url.searchParams.get('height')) === H) {
      if (state.rootAtH === undefined || state.rootAtH === 'gap') return json({ status: 'error', code: 'ERR_NOT_FOUND' }, 404)
      return json({ status: 'success', value: { version: 1, previousHash: 'dd'.repeat(32), merkleRoot: state.rootAtH, time: 1, bits: 1, nonce: 1, hash: 'cc'.repeat(32) } })
    }
    throw new Error(`unexpected chaintracks path ${url.pathname}`)
  }) as typeof fetch
}

const railsFor = (world: Record<string, SourceState>, seen: Array<{ host: string; auth: string | null }> = []) =>
  makeBuyerBsvRails({ fetchImpl: worldFetch(world, seen), timeoutMs: 2_000 })

/** The kit's composed height reader. Its public type names only 'recovery'; the runtime passes every purpose through. */
const finality = (rails: ReturnType<typeof makeBuyerBsvRails>): Promise<number> =>
  (rails.readBsvHeight as unknown as (purpose: 'finality') => Promise<number>)('finality')

describe('buyer kit BSV reads: three distinct sources, two must agree', () => {
  it('reads all three hosts with no credentials; risk is the corroborated highest tip, finality the second highest', async () => {
    const seen: Array<{ host: string; auth: string | null }> = []
    const rails = railsFor({ [ANVIL]: { tip: H + 2 }, [WOC]: { tip: H + 1 }, [THIRD]: { tip: H } }, seen)
    expect(await rails.chainHeight()).to.equal(H + 2)
    expect(await finality(rails)).to.equal(H + 1)
    expect(new Set(seen.map((r) => r.host))).to.deep.equal(new Set([ANVIL, WOC, THIRD]))
    expect(seen.every((r) => r.auth === null)).to.equal(true)
  })

  it('one source down keeps swaps open; two down refuse new risk and report no finality', async () => {
    for (const down of [ANVIL, WOC, THIRD]) {
      const world: Record<string, SourceState> = { [ANVIL]: { tip: H }, [WOC]: { tip: H }, [THIRD]: { tip: H } }
      world[down] = { tip: 'down' }
      expect(await railsFor(world).chainHeight(), down).to.equal(H)
    }
    const two = railsFor({ [ANVIL]: { tip: 'down' }, [WOC]: { tip: H }, [THIRD]: { tip: 'down' } })
    let message = ''
    try { await two.chainHeight() } catch (error) { message = (error as Error).message }
    expect(message).to.contain('only 1/2')
    expect(await finality(two)).to.equal(0)
  })

  it('a proof passes on two confirming sources while the third is down or has a gap in its index', async () => {
    const confirmed = { [ANVIL]: { tip: H + 6, rootAtH: ROOT }, [WOC]: { tip: H + 6, rootAtH: ROOT } }
    expect(await railsFor({ ...confirmed, [THIRD]: { tip: 'down' } }).chainTracker.isValidRootForHeight(ROOT, H)).to.equal(true)
    expect(await railsFor({ ...confirmed, [THIRD]: { tip: H + 6, rootAtH: 'gap' } }).chainTracker.isValidRootForHeight(ROOT, H)).to.equal(true)
  })

  it('a proof fails closed when a synced source holds a different header, and with only one confirming source', async () => {
    const conflict = { [ANVIL]: { tip: H + 6, rootAtH: ROOT }, [WOC]: { tip: H + 6, rootAtH: ROOT }, [THIRD]: { tip: H + 6, rootAtH: OTHER } }
    expect(await railsFor(conflict).chainTracker.isValidRootForHeight(ROOT, H)).to.equal(false)
    const single = { [ANVIL]: { tip: H + 6, rootAtH: ROOT }, [WOC]: { tip: H + 6, rootAtH: 'gap' as const }, [THIRD]: { tip: 'down' as const } }
    expect(await railsFor(single).chainTracker.isValidRootForHeight(ROOT, H)).to.equal(false)
  })
})
