import type { CommsLayer } from '@bsv/sdk'
import { DOOR_QUOTE_BOX_PREFIX, DOOR_SWAP_BOX_PREFIX, decodeDoorQuoteReply, decodeDoorSwapReply, encodeDoor, isDoorRequestId, type DoorQuoteReply, type DoorSwapReply } from '../../transport/door-protocol'
import { makeMessageBoxRequestReplyRequester } from '../../transport/messagebox-request-reply'
import type { DoorClient } from './types'

export interface DoorDecline { code: 'busy' | 'limit' | 'rate_limited' | 'unavailable' | 'declined'; retry_hint: string; message: string; nothing_locked: true }
export function mapDoorDecline(reason: string): DoorDecline {
  const value = reason.toLowerCase()
  const code = /global (?:count|usd)|in-flight|admissions\/hour/.test(value) ? 'busy'
    : /per-swap|identity (?:count|usd)/.test(value) ? 'limit'
      : /quote.*rate|rate.*quote/.test(value) ? 'rate_limited'
        : /kill-switch|quote (?:error|unavailable)|pricing|pricer declined quote|pricer did not bind the requested usdc amount|swap admission unavailable|admission store write failed/.test(value) ? 'unavailable' : 'declined'
  const retry_hint = code === 'busy' ? 'retry later' : code === 'rate_limited' ? 'wait before requesting another quote' : code === 'unavailable' ? 'retry later' : code === 'limit' ? 'use a smaller amount or retry tomorrow' : 'request a new quote and retry'
  return { code, retry_hint, message: `The market maker declined this request: ${reason}. Nothing was locked.`, nothing_locked: true }
}
export class DoorDeclineError extends Error {
  constructor(readonly decline: DoorDecline) { super(decline.message); this.name = 'DoorDeclineError' }
}

/** Authenticated request/reply client for the public door. The peer key is pinned, never read from a reply. */
export function makeMessageBoxDoorClient(opts: { comms: CommsLayer; doorIdentity: string; pollMs?: number; timeoutMs?: number; now?: () => number }): DoorClient {
  const common = {
    comms: opts.comms, peerIdentityPubKeyHex: opts.doorIdentity, peerIdentityOptionName: 'doorIdentity',
    isSwapId: isDoorRequestId, invalidSwapIdError: () => new Error('door request id is invalid'),
    pollMs: opts.pollMs, timeoutMs: opts.timeoutMs, now: opts.now,
  }
  const askQuote = makeMessageBoxRequestReplyRequester<{ v: 1; requestId: string; direction: 'usdc_to_bsv'; asset: 'USDC'; usdcBaseUnits: string }, DoorQuoteReply>({
    ...common, boxPrefix: DOOR_QUOTE_BOX_PREFIX, getSwapId: (x) => x.requestId, encodeRequest: encodeDoor, decodeReply: decodeDoorQuoteReply,
    isReplyValid: (x) => x.v === 1, malformedReplyError: (e) => new Error(`malformed door quote reply: ${e instanceof Error ? e.message : String(e)}`),
    invalidReplyError: () => new Error('invalid door quote reply'), timeoutError: () => new Error('market maker quote timed out; nothing was locked'),
  })
  const askSwap = makeMessageBoxRequestReplyRequester<{ v: 1; requestId: string; quoteId: string; direction: 'usdc_to_bsv'; usdcBaseUnits: string }, DoorSwapReply>({
    ...common, boxPrefix: DOOR_SWAP_BOX_PREFIX, getSwapId: (x) => x.requestId, encodeRequest: encodeDoor, decodeReply: decodeDoorSwapReply,
    isReplyValid: (x) => x.v === 1, malformedReplyError: (e) => new Error(`malformed door swap reply: ${e instanceof Error ? e.message : String(e)}`),
    invalidReplyError: () => new Error('invalid door swap reply'), timeoutError: () => new Error('market maker admission timed out; nothing was locked'),
  })
  return {
    async quote(amount, requestId) {
      const reply = await askQuote({ v: 1, requestId, direction: 'usdc_to_bsv', asset: 'USDC', usdcBaseUnits: amount.toString() })
      if (!reply.ok) throw new DoorDeclineError(mapDoorDecline(reply.reason))
      if (reply.requestId !== requestId) throw new Error('market maker returned a quote for another request')
      return reply
    },
    async admit(quoteId, amount, requestId) {
      const reply = await askSwap({ v: 1, requestId, quoteId, direction: 'usdc_to_bsv', usdcBaseUnits: amount.toString() })
      if (!reply.ok) throw new DoorDeclineError(mapDoorDecline(reply.reason))
      if (reply.requestId !== requestId) throw new Error('market maker returned admission for another request')
      return reply
    },
  }
}
