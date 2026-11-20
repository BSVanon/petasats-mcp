/**
 * A small CoW Protocol order book client for buy_gas: POST /quote, POST /orders and GET /orders/{uid} on Base.
 * Fetch is injected; nothing else is touched. Every failure is a CowApiError whose kind tells the caller whether the
 * order book answered (rejected), may have acted without an answer (network, unavailable, invalid), or not at all.
 * No reply text leaves this module: an error message carries only the HTTP status and an errorType from a fixed list.
 */
import { COW_BASE_API, type CowQuoteResponse } from './gas-topup-order'

export type CowApiErrorKind = 'network' | 'unavailable' | 'rejected' | 'invalid'
export class CowApiError extends Error {
  constructor(readonly kind: CowApiErrorKind, message: string, readonly status?: number, readonly errorType?: string) {
    super(message)
    this.name = 'CowApiError'
  }
}

export interface CowOrderStatus { uid: string; status: string; executedBuyAmount?: string }
export interface CowOrderBook {
  quote(body: Record<string, unknown>): Promise<CowQuoteResponse>
  /** Resolves with the order uid the order book returned (HTTP 201). */
  postOrder(body: Record<string, unknown>): Promise<string>
  /** Resolves undefined when the order book does not know the uid (HTTP 404). */
  getOrder(uid: string): Promise<CowOrderStatus | undefined>
}

const DEFAULT_TIMEOUT_MS = 20_000
/** Every reply body is read to at most 64 KiB; a longer reply counts as no JSON at all. */
const MAX_REPLY_BYTES = 64 * 1024
const UID = /^0x[0-9a-fA-F]{112}$/
const AMOUNT = /^(?:0|[1-9]\d{0,77})$/
/** The only errorType values a message may name (the order book's OpenAPI error names); any other is dropped. */
const KNOWN_ERROR_TYPES = new Set([
  'DuplicatedOrder', 'QuoteNotFound', 'QuoteNotVerified', 'InvalidQuote', 'MissingFrom', 'WrongOwner', 'InsufficientBalance',
  'InsufficientAllowance', 'InvalidSignature', 'SellAmountOverflow', 'TransferSimulationFailed', 'ZeroAmount', 'TooMuchGas',
  'InsufficientValidTo', 'ExcessiveValidTo', 'UnsupportedToken', 'InvalidAppData', 'AppDataHashMismatch', 'AppdataFromMismatch',
])

/** A local fetch failure's own text (never the order book's reply), kept short and printable. */
function clean(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200)
}

function shortError(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error))
}

/** The reply body as text, or undefined once it passes MAX_REPLY_BYTES; the rest is never read. */
async function cappedText(response: Response): Promise<string | undefined> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_REPLY_BYTES) { void reader.cancel().catch(() => {}); return undefined }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export function makeCowOrderBook(opts: { fetch: typeof fetch; baseUrl?: string; timeoutMs?: number }): CowOrderBook {
  const baseUrl = opts.baseUrl ?? COW_BASE_API
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const call = async (method: 'GET' | 'POST', path: string, what: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    let response: Response
    try {
      response = await opts.fetch(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new CowApiError('network', `the CoW Protocol order book could not be reached for the ${what} (${shortError(error)})`)
    }
    let text: string | undefined
    try { text = await cappedText(response) } catch (error) {
      throw new CowApiError('network', `the CoW Protocol order book's ${what} reply was cut off (${shortError(error)})`, response.status)
    }
    let json: unknown
    try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
    return { status: response.status, json }
  }
  const failure = (status: number, json: unknown, what: string): CowApiError => {
    // The description and every other reply field are dropped: order book text never reaches the AI app or a record.
    const reply = (json && typeof json === 'object' ? json : {}) as { errorType?: unknown }
    const errorType = typeof reply.errorType === 'string' && KNOWN_ERROR_TYPES.has(reply.errorType) ? reply.errorType : undefined
    const detail = errorType ? `HTTP ${status}, ${errorType}` : `HTTP ${status}`
    if (status >= 500 || status === 429) return new CowApiError('unavailable', `the CoW Protocol order book is unavailable for the ${what} (${detail})`, status, errorType)
    // Only a 4xx is a refusal; any other unexpected status may hide an accepted order, so its outcome stays unknown.
    if (status >= 400) return new CowApiError('rejected', `the CoW Protocol order book refused the ${what} (${detail})`, status, errorType)
    return new CowApiError('invalid', `the CoW Protocol order book gave an unexpected answer to the ${what} (${detail})`, status, errorType)
  }
  return {
    quote: async (body) => {
      const { status, json } = await call('POST', '/quote', 'quote', body)
      if (status !== 200) throw failure(status, json, 'quote')
      if (!json || typeof json !== 'object') throw new CowApiError('invalid', 'the CoW Protocol quote is not a JSON object', status)
      return json as CowQuoteResponse
    },
    postOrder: async (body) => {
      const { status, json } = await call('POST', '/orders', 'order', body)
      if (status !== 201) throw failure(status, json, 'order')
      if (typeof json !== 'string' || !UID.test(json)) throw new CowApiError('invalid', 'the CoW Protocol order book did not return an order uid', status)
      return json
    },
    getOrder: async (uid) => {
      const { status, json } = await call('GET', `/orders/${uid}`, 'order status')
      if (status === 404) return undefined
      if (status !== 200) throw failure(status, json, 'order status')
      const order = (json && typeof json === 'object' ? json : {}) as { uid?: unknown; status?: unknown; executedBuyAmount?: unknown }
      if (typeof order.status !== 'string' || typeof order.uid !== 'string' || order.uid.toLowerCase() !== uid.toLowerCase()) {
        throw new CowApiError('invalid', 'the CoW Protocol order status is malformed or names another order', status)
      }
      return {
        uid: order.uid, status: order.status,
        ...(typeof order.executedBuyAmount === 'string' && AMOUNT.test(order.executedBuyAmount) ? { executedBuyAmount: order.executedBuyAmount } : {}),
      }
    },
  }
}
