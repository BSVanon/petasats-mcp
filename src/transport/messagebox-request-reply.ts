/**
 * Authenticated MessageBox request/reply choreography.
 *
 * A fixed request box lets a responder discover work; each request's validated
 * swap id selects an isolated reply box.  The caller supplies its payload codec,
 * swap-id policy, and domain handler.  This module deliberately owns the
 * transport invariants: peer authentication, box routing, polling, and the
 * acknowledgement order which gives responders at-least-once delivery.
 */

import type { CommsLayer, PeerMessage } from '@bsv/sdk'

const PUBKEY_RE = /^[0-9a-fA-F]{66}$/

type Sleep = (ms: number) => Promise<void>
type Log = (message: string) => void

export interface MessageBoxRequestReplyRequesterOpts<Request, Reply> {
  comms: CommsLayer
  peerIdentityPubKeyHex: string
  peerIdentityOptionName: string
  boxPrefix: string
  getSwapId: (request: Request) => unknown
  isSwapId: (swapId: unknown) => swapId is string
  invalidSwapIdError: (swapId: unknown) => Error
  encodeRequest: (request: Request) => string
  decodeReply: (body: string) => Reply
  isReplyValid: (reply: Reply) => boolean
  malformedReplyError: (error: unknown) => Error
  invalidReplyError: () => Error
  timeoutError: (swapId: string, timeoutMs: number) => Error
  pollMs?: number
  timeoutMs?: number
  sleep?: Sleep
  now?: () => number
  onRequestSent?: (swapId: string) => void
  onReplyReceived?: (swapId: string, reply: Reply) => void
}

/** Build a requester which only accepts an authenticated reply from its configured peer. */
export function makeMessageBoxRequestReplyRequester<Request, Reply>(opts: MessageBoxRequestReplyRequesterOpts<Request, Reply>): (request: Request) => Promise<Reply> {
  if (!PUBKEY_RE.test(opts.peerIdentityPubKeyHex)) {
    throw new Error(`${opts.peerIdentityOptionName} must be a 33-byte compressed pubkey (66 hex)`)
  }
  const peer = opts.peerIdentityPubKeyHex.toLowerCase()
  const pollMs = opts.pollMs ?? 2000
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = opts.now ?? (() => Date.now())

  return async (request: Request): Promise<Reply> => {
    const candidateSwapId = opts.getSwapId(request)
    if (!opts.isSwapId(candidateSwapId)) throw opts.invalidSwapIdError(candidateSwapId)
    const swapId = candidateSwapId
    await opts.comms.sendMessage({ recipient: peer, messageBox: `${opts.boxPrefix}:req`, body: opts.encodeRequest(request) })
    opts.onRequestSent?.(swapId)

    const responseBox = `${opts.boxPrefix}:res:${swapId}`
    const start = now()
    for (;;) {
      const messages: PeerMessage[] = await opts.comms.listMessages({ messageBox: responseBox })
      const reply = messages.find((message) => (message.sender ?? '').toLowerCase() === peer)
      if (reply) {
        // Acknowledge the selected authenticated reply before decoding it.  This
        // intentionally preserves the existing fail-closed malformed-reply path.
        await opts.comms.acknowledgeMessage({ messageIds: [reply.messageId] })
        let decoded: Reply
        try {
          decoded = opts.decodeReply(reply.body)
        } catch (error) {
          throw opts.malformedReplyError(error)
        }
        if (!opts.isReplyValid(decoded)) throw opts.invalidReplyError()
        opts.onReplyReceived?.(swapId, decoded)
        return decoded
      }
      if (now() - start > timeoutMs) throw opts.timeoutError(swapId, timeoutMs)
      await sleep(pollMs)
    }
  }
}

export interface MessageBoxRequestReplyResponderOpts<Request, Reply> {
  comms: CommsLayer
  /** Pin this responder to one authenticated peer (the historic mode). */
  peerIdentityPubKeyHex?: string
  peerIdentityOptionName?: string
  /** Accept a request from any *valid authenticated* BRC-31 identity. */
  acceptAnyAuthenticatedSender?: boolean
  boxPrefix: string
  getSwapId: (request: Request) => unknown
  isSwapId: (swapId: unknown) => swapId is string
  decodeRequest: (body: string) => Request
  encodeReply: (reply: Reply) => string
  handleRequest: (request: Request, swapId: string, sender?: string) => Promise<Reply>
  handleRequestError: (error: unknown, request: Request, swapId: string, sender?: string) => Reply
  pollMs?: number
  sleep?: Sleep
  onUnparseableRequest?: (error: unknown) => void
  onInvalidSwapId?: (swapId: unknown) => void
  onReplySent?: (swapId: string, reply: Reply) => void
  /** Whether a reply synthesized from a handler error receives the normal sent callback. */
  notifyReplySentOnHandlerError?: boolean
  onUnauthorizedDropAckError?: (error: unknown) => void
  onUnauthorizedMessagesDropped?: (count: number, requestBox: string) => void
  onPollError?: (error: unknown) => void
  /** Bound work per poll so a noisy public box cannot starve the event loop. */
  maxPerPoll?: number
  /** Drop (and acknowledge) a request body larger than this before decoding it. */
  maxBodyBytes?: number
}

/** Safe defaults keep every production poll and attacker-controlled body bounded. */
export const DEFAULT_MESSAGEBOX_MAX_PER_POLL = 32
export const DEFAULT_MESSAGEBOX_MAX_BODY_BYTES = 64 * 1024

/** Build a responder loop with authenticated sender filtering and at-least-once request delivery. */
export function makeMessageBoxRequestReplyResponder<Request, Reply>(opts: MessageBoxRequestReplyResponderOpts<Request, Reply>): { start(): () => void } {
  const anySender = opts.acceptAnyAuthenticatedSender === true
  const hasPeer = opts.peerIdentityPubKeyHex !== undefined
  if (anySender === hasPeer) {
    throw new Error('messagebox-request-reply responder requires exactly one of peerIdentityPubKeyHex or acceptAnyAuthenticatedSender')
  }
  if (hasPeer && !PUBKEY_RE.test(opts.peerIdentityPubKeyHex!)) {
    throw new Error(`${opts.peerIdentityOptionName ?? 'peerIdentityPubKeyHex'} must be a 33-byte compressed pubkey (66 hex)`)
  }
  const maxPerPoll = opts.maxPerPoll ?? DEFAULT_MESSAGEBOX_MAX_PER_POLL
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MESSAGEBOX_MAX_BODY_BYTES
  if (!Number.isInteger(maxPerPoll) || maxPerPoll < 1) throw new Error('maxPerPoll must be a positive integer')
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 0) throw new Error('maxBodyBytes must be a non-negative integer')
  const peer = opts.peerIdentityPubKeyHex?.toLowerCase()
  const pollMs = opts.pollMs ?? 2000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const requestBox = `${opts.boxPrefix}:req`

  const handleOne = async (message: PeerMessage, sender?: string): Promise<void> => {
    const acknowledge = () => opts.comms.acknowledgeMessage({ messageIds: [message.messageId] })
    if (Buffer.byteLength(message.body, 'utf8') > maxBodyBytes) {
      await acknowledge()
      return
    }
    let request: Request
    try {
      request = opts.decodeRequest(message.body)
    } catch (error) {
      opts.onUnparseableRequest?.(error)
      await acknowledge() // no validated swap id means no safe reply address
      return
    }

    const candidateSwapId = opts.getSwapId(request)
    if (!opts.isSwapId(candidateSwapId)) {
      opts.onInvalidSwapId?.(candidateSwapId)
      await acknowledge() // an unaddressable request is dropped so its caller times out fail-closed
      return
    }
    const swapId = candidateSwapId

    let reply: Reply
    let handlerFailed = false
    try {
      reply = anySender ? await opts.handleRequest(request, swapId, sender) : await opts.handleRequest(request, swapId)
    } catch (error) {
      handlerFailed = true
      reply = anySender ? opts.handleRequestError(error, request, swapId, sender) : opts.handleRequestError(error, request, swapId)
    }
    // The reply must be durable before the request is acknowledged.  A send or
    // acknowledgement failure leaves the request available for a safe retry.
    await opts.comms.sendMessage({ recipient: message.sender, messageBox: `${opts.boxPrefix}:res:${swapId}`, body: opts.encodeReply(reply) })
    await acknowledge()
    if (!handlerFailed || opts.notifyReplySentOnHandlerError) opts.onReplySent?.(swapId, reply)
  }

  return {
    start(): () => void {
      let stopped = false
      const loop = async (): Promise<void> => {
        while (!stopped) {
          try {
            const listed: PeerMessage[] = await opts.comms.listMessages({ messageBox: requestBox })
            const messages = listed.slice(0, maxPerPoll)
            const strangerIds: string[] = []
            for (const message of messages) {
              if (stopped) break
              const sender = (message.sender ?? '').toLowerCase()
              if (anySender) {
                if (!PUBKEY_RE.test(sender)) {
                  // Public endpoints cannot route a reply without a verified identity.
                  await opts.comms.acknowledgeMessage({ messageIds: [message.messageId] })
                  continue
                }
                await handleOne(message, sender)
                continue
              }
              if (sender !== peer) {
                strangerIds.push(message.messageId)
                continue
              }
              await handleOne(message)
            }
            if (strangerIds.length > 0) {
              try {
                await opts.comms.acknowledgeMessage({ messageIds: strangerIds })
              } catch (error) {
                opts.onUnauthorizedDropAckError?.(error)
              }
              opts.onUnauthorizedMessagesDropped?.(strangerIds.length, requestBox)
            }
          } catch (error) {
            opts.onPollError?.(error)
          }
          if (!stopped) await sleep(pollMs)
        }
      }
      void loop()
      return () => { stopped = true }
    },
  }
}
