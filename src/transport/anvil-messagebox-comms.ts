import { AuthFetch } from '@bsv/sdk'
import type { CommsLayer, PeerMessage, WalletInterface } from '@bsv/sdk'
export const DEFAULT_ANVIL_MESSAGEBOX_HOST = 'https://anvil.sendbsv.com'
type Json = Record<string, unknown>
type AuthFetchClient = Pick<AuthFetch, 'fetch'>
export interface AnvilMessageBoxOpts {
  /** The agent's BRC-100 identity wallet — drives BRC-31 auth. NEVER the operator token. */
  wallet: WalletInterface
  /** MessageBox host, e.g. `https://anvil.sendbsv.com`. One node for both agents (same-node = airtight). */
  host: string
  timeoutMs?: number
  /** Used by settlement channels which do not carry an explicit list limit. */
  defaultListLimit?: number
  /** Test seam for the authenticated HTTP client; production uses AuthFetch. */
  authFetch?: AuthFetchClient
  /** Test seam for replacing a timed-out authenticated HTTP client. */
  makeAuthFetch?: () => AuthFetchClient
}

/** Build a `CommsLayer` bound to ONE identity (the wallet's) against a MessageBox host, over BRC-31 `AuthFetch`. */
export function makeAnvilMessageBoxComms(opts: AnvilMessageBoxOpts): CommsLayer {
  if (typeof opts.host !== 'string' || opts.host.length === 0) {
    throw new Error('anvil-messagebox: host is required (e.g. https://anvil.sendbsv.com)')
  }
  const host = opts.host.replace(/\/+$/, '') // no trailing slash
  const fixedAuthFetch = opts.authFetch
  const makeAuthFetch = opts.makeAuthFetch ?? (() => new AuthFetch(opts.wallet))
  let auth = fixedAuthFetch ?? makeAuthFetch()
  let generation = 0
  let myIdentity: string | undefined // cached; fills PeerMessage.recipient (list is caller-scoped → recipient IS us)
  const timeoutMs = opts.timeoutMs ?? 15_000
  const defaultListLimit = opts.defaultListLimit ?? 16
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error('anvil-messagebox: timeoutMs must be 1000..60000')
  if (!Number.isInteger(defaultListLimit) || defaultListLimit < 1) throw new Error('anvil-messagebox: defaultListLimit must be a positive integer')
  // An in-flight list is reused until its deadline fires, never after; stalled
  // lists are bounded to one per deadline per box. An abandoned AuthFetch stays
  // reachable while its own work is pending: an HTTP request (AuthFetch ignores
  // the abort signal; Node's fetch ends a silent request after its 300 s header
  // and body timeouts) or a short SDK timer (certificate or payment retry).
  const listsInFlight = new Map<string, { work: Promise<Json>; controller: AbortController; generation: number }>()

  const replaceTimedOutAuthFetch = (): void => {
    generation++
    // A factory failure keeps the current client: the deadline below must still reject its caller.
    if (!fixedAuthFetch) { try { auth = makeAuthFetch() } catch { /* retried at the next deadline */ } }
  }
  const deadline = <T>(work: Promise<T>, controller: AbortController, route: string, onTimeout?: () => void): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      replaceTimedOutAuthFetch()
      onTimeout?.()
      reject(new Error(`anvil-messagebox ${route} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
  const startPost = (route: string, payload: Json): { work: Promise<Json>; controller: AbortController; generation: number } => {
    const controller = new AbortController()
    const requestAuth = auth
    const requestGeneration = generation
    const work = (async (): Promise<Json> => {
      const res = await requestAuth.fetch(`${host}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      } as any)
      const parsed = (await res.json().catch(() => ({}))) as Json
      if (!res.ok || parsed.status === 'error') {
        const detail = (parsed.error ?? parsed.description ?? `HTTP ${res.status}`) as string
        throw new Error(`anvil-messagebox ${route} failed: ${detail}`)
      }
      return parsed
    })()
    return { work, controller, generation: requestGeneration }
  }
  const post = async (route: string, payload: Json): Promise<Json> => {
    const started = startPost(route, payload)
    return deadline(started.work, started.controller, route)
  }

  return {
    async sendMessage({ recipient, messageBox, body }): Promise<string> {
      const parsed = await post('/sendMessage', { recipient, messageBox, body })
      return String(parsed.messageId) // server-minted id — used later to acknowledge
    },
    async listMessages({ messageBox, limit }: { messageBox: string; limit?: number }): Promise<PeerMessage[]> {
      let listed = listsInFlight.get(messageBox)
      if (!listed || listed.generation !== generation) {
        const started = startPost('/listMessages', { messageBox, limit: limit ?? defaultListLimit })
        listed = started
        listsInFlight.set(messageBox, listed)
        const entry = listed
        const removeEntry = (): void => { if (listsInFlight.get(messageBox) === entry) listsInFlight.delete(messageBox) }
        void entry.work.then(removeEntry, removeEntry)
      }
      const entry = listed
      const parsed = await deadline(entry.work, entry.controller, '/listMessages', () => {
        if (listsInFlight.get(messageBox) === entry) listsInFlight.delete(messageBox)
      })
      if (myIdentity === undefined) {
        try { myIdentity = (await opts.wallet.getPublicKey({ identityKey: true })).publicKey } catch { myIdentity = '' }
      }
      const messages: Json[] = Array.isArray(parsed.messages) ? (parsed.messages as Json[]) : []
      // Map Anvil's message → the sdk `PeerMessage` the channel consumes (it reads sender/messageId/body).
      return messages.map((m): PeerMessage => ({
        messageId: String(m.messageId),
        sender: String(m.sender ?? ''),
        recipient: myIdentity ?? '',
        messageBox,
        body: typeof m.body === 'string' ? m.body : JSON.stringify(m.body),
      }))
    },
    async acknowledgeMessage({ messageIds }): Promise<void> {
      await post('/acknowledgeMessage', { messageIds })
    },
  }
}
