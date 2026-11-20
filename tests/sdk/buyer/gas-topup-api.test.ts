import { expect } from 'chai'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { CowApiError, makeCowOrderBook } from '../../../src/sdk/buyer/gas-topup-api'
import { UNTRUSTED_ERROR_TYPE as UNTRUSTED_TYPE, UNTRUSTED_DESCRIPTION as UNTRUSTED_TEXT } from './helpers/gas-fakes'

const UID = `0x${'ab'.repeat(56)}`

function bookAnswering(status: number, body: unknown, seen: string[] = []) {
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return new Response(body === undefined ? '' : typeof body === 'string' && body.startsWith('raw:') ? body.slice(4) : JSON.stringify(body), { status })
  }) as typeof globalThis.fetch
  return makeCowOrderBook({ fetch })
}

async function failure(promise: Promise<unknown>): Promise<CowApiError> {
  try { await promise } catch (error) { expect(error).instanceOf(CowApiError); return error as CowApiError }
  throw new Error('expected a CowApiError')
}

describe('buy_gas CoW Protocol order book client', () => {
  it('calls the Base order book paths', async () => {
    const seen: string[] = []
    await bookAnswering(201, UID, seen).postOrder({})
    await bookAnswering(404, { errorType: 'NotFound' }, seen).getOrder(UID)
    await bookAnswering(200, { quote: {} }, seen).quote({})
    expect(seen).deep.eq([
      'POST https://api.cow.fi/base/api/v1/orders', `GET https://api.cow.fi/base/api/v1/orders/${UID}`, 'POST https://api.cow.fi/base/api/v1/quote',
    ])
  })

  it('maps only a 4xx to a refusal; a 5xx or 429 is unavailable; any other status leaves the outcome unknown', async () => {
    const refused = await failure(bookAnswering(400, { errorType: 'InsufficientAllowance', description: 'no\nallowance' }).postOrder({}))
    expect(refused).to.include({ kind: 'rejected', status: 400, errorType: 'InsufficientAllowance' })
    expect(refused.message).eq('the CoW Protocol order book refused the order (HTTP 400, InsufficientAllowance)')
    expect((await failure(bookAnswering(503, undefined).postOrder({}))).kind).eq('unavailable')
    expect((await failure(bookAnswering(429, undefined).postOrder({}))).kind).eq('unavailable')
    expect((await failure(bookAnswering(200, UID).postOrder({}))).kind).eq('invalid') // created orders answer 201
    expect((await failure(bookAnswering(201, 'not-a-uid').postOrder({}))).kind).eq('invalid')
  })

  it('2 a message carries only the HTTP status and an errorType from the fixed list, never the description', async () => {
    const untrusted = { errorType: UNTRUSTED_TYPE, description: UNTRUSTED_TEXT }
    const answers: Array<[string, () => Promise<unknown>, string]> = [
      ['order', () => bookAnswering(400, untrusted).postOrder({}), 'the CoW Protocol order book refused the order (HTTP 400)'],
      ['quote', () => bookAnswering(400, untrusted).quote({}), 'the CoW Protocol order book refused the quote (HTTP 400)'],
      ['order status', () => bookAnswering(400, untrusted).getOrder(UID), 'the CoW Protocol order book refused the order status (HTTP 400)'],
      ['5xx', () => bookAnswering(500, untrusted).getOrder(UID), 'the CoW Protocol order book is unavailable for the order status (HTTP 500)'],
      ['3xx', () => bookAnswering(302, untrusted).quote({}), 'the CoW Protocol order book gave an unexpected answer to the quote (HTTP 302)'],
    ]
    for (const [what, call, message] of answers) {
      const error = await failure(call())
      expect(error.message, what).eq(message)
      expect(error.errorType, what).eq(undefined)
    }
    // A listed errorType is kept even beside an untrusted description; the description still never is.
    const listed = await failure(bookAnswering(400, { errorType: 'QuoteNotFound', description: UNTRUSTED_TEXT }).quote({}))
    expect(listed.message).eq('the CoW Protocol order book refused the quote (HTTP 400, QuoteNotFound)')
  })

  it('reads at most 64 KiB of any reply', async () => {
    const huge = `raw:"${'a'.repeat(70 * 1024)}"`
    expect((await failure(bookAnswering(201, huge).postOrder({}))).message).eq('the CoW Protocol order book did not return an order uid')
    const padded = { errorType: 'InsufficientBalance', padding: 'x'.repeat(70 * 1024) }
    expect((await failure(bookAnswering(400, padded).postOrder({}))).message).eq('the CoW Protocol order book refused the order (HTTP 400)')
    const fits = { errorType: 'InsufficientBalance', padding: 'x'.repeat(60 * 1024) }
    expect((await failure(bookAnswering(400, fits).postOrder({}))).message).eq('the CoW Protocol order book refused the order (HTTP 400, InsufficientBalance)')
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(16 * 1024)) } })
    const stream = makeCowOrderBook({ fetch: (async () => new Response(endless, { status: 400 })) as typeof fetch })
    expect((await failure(stream.quote({}))).message).eq('the CoW Protocol order book refused the quote (HTTP 400)')
    expect(pulled).lessThan(10) // it stopped reading
  })

  it('reads an order status, treats 404 as unknown, and refuses a status for another uid', async () => {
    expect(await bookAnswering(404, { errorType: 'NotFound' }).getOrder(UID)).eq(undefined)
    expect(await bookAnswering(200, { uid: UID, status: 'fulfilled', executedBuyAmount: '123' }).getOrder(UID)).deep.eq({ uid: UID, status: 'fulfilled', executedBuyAmount: '123' })
    expect(await bookAnswering(200, { uid: UID, status: 'open', executedBuyAmount: '-1' }).getOrder(UID)).deep.eq({ uid: UID, status: 'open' })
    expect((await failure(bookAnswering(200, { uid: `0x${'cd'.repeat(56)}`, status: 'fulfilled' }).getOrder(UID))).kind).eq('invalid')
  })

  it('turns an unreachable or hung order book into a network error', async () => {
    const down = makeCowOrderBook({ fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch })
    expect((await failure(down.quote({}))).kind).eq('network')
    const hung = makeCowOrderBook({ timeoutMs: 50, fetch: ((_: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch })
    expect((await failure(hung.getOrder(UID))).kind).eq('network')
  })
})
