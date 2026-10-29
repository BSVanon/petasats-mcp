import type { CommsLayer, PeerMessage } from '@bsv/sdk'
/** Default box namespace prefix. Both peers must use the same one (they do, by sharing this default). */
export const DEFAULT_BOX_PREFIX = 'petasats:swap'
export interface MessageBoxChannelOpts {
  /** The BRC-100 messagebox client, authenticated AS this party (MessageBoxClient in prod; a fake in tests). */
  comms: CommsLayer
  /** The swap's fresh, unique namespace (== the orchestrator swapId). Isolates this channel's boxes. Alnum/-/_ ≤64. */
  namespace: string
  peerIdentityPubKeyHex?: string
  /** Box namespace prefix (default {@link DEFAULT_BOX_PREFIX}). Both peers must agree. */
  boxPrefix?: string
  /** Poll interval while waiting for a message (ms; default 2000). */
  pollMs?: number
  /** Give-up timeout for a blocking `recv` (ms; default 20 min — a human-attended swap horizon). */
  timeoutMs?: number
  /** Maximum messages inspected on one poll (default 32). */
  maxPerPoll?: number
  /** Maximum encoded body bytes accepted from the authenticated peer (default 64KiB). */
  maxBodyBytes?: number
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>
  /** Injectable clock → ms (tests). */
  now?: () => number
  log?: (tag: string, msg: string) => void
}

export interface MessageBoxChannel {
  /** Send `obj` (JSON) to the peer's `kind` box. Throws if the peer identity is not yet known. */
  send(kind: string, obj: unknown): Promise<void>
  /** Block (poll) until the peer sends to our `kind` box, then ack + return it. Throws on timeout or a malformed body. */
  recv<T>(kind: string, validate?: (value: unknown) => value is T): Promise<T>
  /** One-shot: return the peer's `kind` message if already present (ack it), else null. Never blocks. */
  tryRecv<T>(kind: string, validate?: (value: unknown) => value is T): Promise<T | null>
  /** The pinned peer identity (once known), for inspection/tests. */
  peer(): string | undefined
}

const NS_RE = /^[A-Za-z0-9_-]{1,64}$/
const KIND_RE = /^[a-z0-9-]{1,64}$/
const PUBKEY_RE = /^[0-9a-fA-F]{66}$/
export const DEFAULT_CHANNEL_MAX_PER_POLL = 32
export const DEFAULT_CHANNEL_MAX_BODY_BYTES = 64 * 1024

export function makeMessageBoxChannel(opts: MessageBoxChannelOpts): MessageBoxChannel {
  const { comms } = opts
  const namespace = opts.namespace
  if (!NS_RE.test(namespace)) {
    throw new Error(`messagebox-channel: namespace must be alphanumeric/-/_ ≤64 (got '${namespace}') — it becomes a box name component`)
  }
  const boxPrefix = opts.boxPrefix ?? DEFAULT_BOX_PREFIX
  const pollMs = opts.pollMs ?? 2000
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000
  const maxPerPoll = opts.maxPerPoll ?? DEFAULT_CHANNEL_MAX_PER_POLL
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_CHANNEL_MAX_BODY_BYTES
  if (!Number.isInteger(maxPerPoll) || maxPerPoll < 1) throw new Error('messagebox-channel: maxPerPoll must be a positive integer')
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error('messagebox-channel: maxBodyBytes must be a positive integer')
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? (() => Date.now())
  const log = opts.log ?? (() => {})

  // Pinned peer identity (lowercased). undefined ⇒ capture from the first authenticated inbound.
  let peer: string | undefined
  if (opts.peerIdentityPubKeyHex !== undefined) {
    if (!PUBKEY_RE.test(opts.peerIdentityPubKeyHex)) {
      throw new Error('messagebox-channel: peerIdentityPubKeyHex must be a 33-byte compressed pubkey (66 hex chars)')
    }
    peer = opts.peerIdentityPubKeyHex.toLowerCase()
  }

  const boxFor = (kind: string): string => {
    if (!KIND_RE.test(kind)) throw new Error(`messagebox-channel: kind must be [a-z0-9-] ≤64 (got '${kind}')`)
    return `${boxPrefix}:${namespace}:${kind}`
  }

  const send = async (kind: string, obj: unknown): Promise<void> => {
    if (peer === undefined) {
      throw new Error(`messagebox-channel: cannot send '${kind}' — the peer identity is not known yet (no inbound message captured, and no peerIdentityPubKeyHex was provided)`)
    }
    const body = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
    await comms.sendMessage({ recipient: peer, messageBox: boxFor(kind), body })
    log('mb', `→ sent ${kind}`)
  }

  /**
   * Take (and ack) the peer's next message in the `kind` box, or null if none is present right now. Filters by the
   * AUTHENTICATED `sender`: foreign and malformed-sender messages are acknowledged as disposable noise after the scan;
   * they are never decoded or acted on. If the
   * peer is not yet pinned, the FIRST authenticated inbound pins it. A malformed body from the (authenticated) peer is
   * a protocol violation → throw (fail-closed): the swap aborts rather than proceed on garbage.
   */
  const takeOne = async <T>(kind: string, validate?: (value: unknown) => value is T): Promise<T | null> => {
    const box = boxFor(kind)
    const msgs: PeerMessage[] = await comms.listMessages({ messageBox: box })
    const foreignMessageIds: string[] = []
    const peerMessages: PeerMessage[] = []
    for (const m of msgs) {
      const from = (m.sender ?? '').toLowerCase()
      if (peer === undefined) {
        if (!PUBKEY_RE.test(from)) { foreignMessageIds.push(m.messageId); continue }
        peer = from // capture + pin the counterparty (a responder learning who is calling)
        log('mb', `peer pinned to ${from.slice(0, 16)}… (captured from ${kind})`)
      } else if (from !== peer) {
        foreignMessageIds.push(m.messageId)
        continue
      }
      if (peerMessages.length < maxPerPoll) peerMessages.push(m)
    }
    if (foreignMessageIds.length > 0) {
      // One line per poll, not per message: the whole remote list is scanned, so per-message lines would let a flood
      // write thousands of journal lines on every poll.
      log('mb', `ignore ${foreignMessageIds.length} ${kind} message(s) without the pinned peer's identity (acknowledging up to 64)`)
      try {
        await comms.acknowledgeMessage({ messageIds: foreignMessageIds.slice(0, 64) })
      } catch (e) {
        log('mb', `failed to acknowledge ${Math.min(foreignMessageIds.length, 64)} foreign ${kind} message(s): ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    for (const m of peerMessages) {
      // Accepted (authenticated peer). Ack/drop oversized bodies so one peer
      // cannot pin this namespace's poll forever. Base64 is checked before
      // decoding so JSON.parse never sees an unbounded attacker body.
      await comms.acknowledgeMessage({ messageIds: [m.messageId] })
      if (Buffer.byteLength(m.body, 'utf8') > maxBodyBytes) {
        log('mb', `drop ${kind}: oversized peer body`)
        continue
      }
      let decoded: T
      try {
        const bytes = Buffer.from(m.body, 'base64')
        if (bytes.length > maxBodyBytes) throw new Error('decoded body exceeds limit')
        const parsed: unknown = JSON.parse(bytes.toString('utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object')
        if (validate && !validate(parsed)) throw new Error('body does not match the message schema')
        decoded = parsed as T
      } catch (e) {
        throw new Error(`messagebox-channel: malformed '${kind}' body from the peer (fail-closed): ${e instanceof Error ? e.message : String(e)}`)
      }
      log('mb', `← got ${kind}`)
      return decoded
    }
    return null
  }

  const recv = async <T>(kind: string, validate?: (value: unknown) => value is T): Promise<T> => {
    const start = now()
    // Backstop against a NON-ADVANCING injected clock: the wall-clock timeout below is the primary bound, but a frozen
    // `now` (a caller footgun) would make `now()-start` perpetually 0 and never fire it. Cap the poll count too, so a
    // stuck clock FAILS CLOSED (throws) instead of hanging a money swap. With a real clock the wall-timeout fires first.
    let polls = 0
    const maxPolls = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollMs))) + 2
    for (;;) {
      const got = await takeOne<T>(kind, validate)
      if (got !== null) return got
      if (now() - start > timeoutMs || ++polls > maxPolls) {
        throw new Error(`messagebox-channel: timed out waiting for '${kind}' (${timeoutMs}ms / ${maxPolls} polls)`)
      }
      await sleep(pollMs)
    }
  }

  return {
    send,
    recv,
    tryRecv: <T>(kind: string, validate?: (value: unknown) => value is T) => takeOne<T>(kind, validate),
    peer: () => peer,
  }
}
