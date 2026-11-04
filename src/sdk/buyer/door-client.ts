import type { CommsLayer } from '@bsv/sdk'
import { randomBytes } from 'crypto'
import { DOOR_QUOTE_BOX_PREFIX, DOOR_SWAP_BOX_PREFIX, decodeDoorQuoteReply, decodeDoorSwapReply, encodeDoor, isDoorRequestId, type DoorQuoteReply, type DoorSwapReply } from '../../transport/door-protocol'
import { DOOR_CAPABILITIES_BOX_PREFIX, DOOR_QUOTE_V2_BOX_PREFIX, DOOR_SWAP_V2_BOX_PREFIX, decodeDoorCapabilitiesReply, decodeDoorQuoteReplyV2, decodeDoorSwapReplyV2, encodeDoorV2, type DoorCapabilitiesReply, type DoorQuoteReplyV2, type DoorSwapReplyV2 } from '../../transport/door-protocol-v2'
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
export function makeMessageBoxDoorClient(opts: { comms: CommsLayer; doorIdentity: string; pollMs?: number; timeoutMs?: number; capabilityTimeoutMs?: number; negativeCacheMs?: number; now?: () => number }): DoorClient {
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
  const capabilityTimeoutMs = opts.capabilityTimeoutMs ?? 4_000
  const negativeCacheMs = opts.negativeCacheMs ?? 10 * 60_000
  const askCapability = makeMessageBoxRequestReplyRequester<{ v: 1; requestId: string; supportedDoorVersions: [2, 1] }, DoorCapabilitiesReply>({
    ...common, timeoutMs: capabilityTimeoutMs, boxPrefix: DOOR_CAPABILITIES_BOX_PREFIX, getSwapId: (x) => x.requestId, encodeRequest: encodeDoorV2, decodeReply: decodeDoorCapabilitiesReply,
    isReplyValid: (x) => x.v === 1 && x.selectedDoorVersion === 2, malformedReplyError: () => new Error('malformed door capability reply'), invalidReplyError: () => new Error('invalid door capability reply'), timeoutError: () => new Error('door capability probe timed out'),
  })
  const askQuoteV2 = makeMessageBoxRequestReplyRequester<{ v: 2; requestId: string; direction: 'usdc_to_bsv'; asset: 'USDC'; usdcBaseUnits: string }, DoorQuoteReplyV2>({
    ...common, boxPrefix: DOOR_QUOTE_V2_BOX_PREFIX, getSwapId: (x) => x.requestId, encodeRequest: encodeDoorV2, decodeReply: decodeDoorQuoteReplyV2,
    isReplyValid: (x) => x.v === 2, malformedReplyError: (e) => new Error(`malformed door v2 quote reply: ${e instanceof Error ? e.message : String(e)}`), invalidReplyError: () => new Error('invalid door v2 quote reply'), timeoutError: () => new Error('market maker v2 quote timed out; nothing was locked'),
  })
  const askSwapV2 = makeMessageBoxRequestReplyRequester<{ v: 2; requestId: string; quoteId: string; direction: 'usdc_to_bsv'; usdcBaseUnits: string; requestedSettlementMode: 'confirmed' | 'fast' }, DoorSwapReplyV2>({
    ...common, boxPrefix: DOOR_SWAP_V2_BOX_PREFIX, getSwapId: (x) => x.requestId, encodeRequest: encodeDoorV2, decodeReply: decodeDoorSwapReplyV2,
    isReplyValid: (x) => x.v === 2, malformedReplyError: (e) => new Error(`malformed door v2 swap reply: ${e instanceof Error ? e.message : String(e)}`), invalidReplyError: () => new Error('invalid door v2 swap reply'), timeoutError: () => new Error('market maker v2 admission timed out; nothing was locked'),
  })
  const now = opts.now ?? Date.now
  let v2State: { selected: boolean; until: number } | undefined
  const quoteVersions = new Map<string, 1 | 2>()
  const selectV2 = async (): Promise<boolean> => {
    if (v2State && now() < v2State.until) return v2State.selected
    try {
      const reply = await askCapability({ v: 1, requestId: randomBytes(18).toString('base64url'), supportedDoorVersions: [2, 1] })
      const selected = reply.selectedDoorVersion === 2
      v2State = { selected, until: selected ? Number.POSITIVE_INFINITY : now() + negativeCacheMs }
      return selected
    } catch { v2State = { selected: false, until: now() + negativeCacheMs }; return false }
  }
  const quoteV1 = async (amount: bigint, requestId: string) => {
    const reply = await askQuote({ v: 1, requestId, direction: 'usdc_to_bsv', asset: 'USDC', usdcBaseUnits: amount.toString() })
    if (!reply.ok) throw new DoorDeclineError(mapDoorDecline(reply.reason))
    if (reply.requestId !== requestId) throw new Error('market maker returned a quote for another request')
    quoteVersions.set(reply.quoteId, 1)
    return { ...reply, doorProtocolVersion: 1 as const, fastOffered: false, fastCapUsdcBaseUnits: '0' }
  }
  return {
    async quote(amount, requestId, forceLegacy = false) {
      if (forceLegacy || !await selectV2()) return quoteV1(amount, requestId)
      let reply: DoorQuoteReplyV2
      try {
        reply = await askQuoteV2({ v: 2, requestId, direction: 'usdc_to_bsv', asset: 'USDC', usdcBaseUnits: amount.toString() })
      } catch (error) {
        if (error instanceof DoorDeclineError) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (/\.(?:direction|asset|amountUsd|bsvSats|usdcBaseUnits|midUsdPerBsv|expiresAtMs|quoteId):/.test(message)) throw error
        v2State = { selected: false, until: now() + negativeCacheMs }
        return quoteV1(amount, requestId)
      }
      if (!reply.ok) throw new DoorDeclineError(mapDoorDecline(reply.reason))
      if (reply.requestId !== requestId) throw new Error('market maker returned a quote for another request')
      quoteVersions.set(reply.quoteId, 2)
      return { ...reply, doorProtocolVersion: 2 as const }
    },
    async admit(quoteId, amount, requestId, requestedSettlementMode = 'confirmed', forceLegacy = false) {
      if (!forceLegacy && quoteVersions.get(quoteId) === 2) {
        const request = { v: 2 as const, requestId, quoteId, direction: 'usdc_to_bsv' as const, usdcBaseUnits: amount.toString(), requestedSettlementMode }
        let reply: DoorSwapReplyV2
        try { reply = await askSwapV2(request) } catch { reply = await askSwapV2(request) }
        if (!reply.ok) throw new DoorDeclineError(mapDoorDecline(reply.reason))
        if (reply.requestId !== requestId) throw new Error('market maker returned admission for another request')
        if (requestedSettlementMode === 'confirmed' && reply.settlementMode === 'fast') throw new Error('market maker attempted to upgrade a confirmed admission to fast')
        return { ...reply, doorProtocolVersion: 2 as const }
      }
      const reply = await askSwap({ v: 1, requestId, quoteId, direction: 'usdc_to_bsv', usdcBaseUnits: amount.toString() })
      if (!reply.ok) throw new DoorDeclineError(mapDoorDecline(reply.reason))
      if (reply.requestId !== requestId) throw new Error('market maker returned admission for another request')
      return { ...reply, doorProtocolVersion: 1 as const, settlementMode: 'confirmed' as const, fastCapUsdcBaseUnits: '0' }
    },
  }
}
