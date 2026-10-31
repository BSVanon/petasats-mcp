import { AuthFetch } from '@bsv/sdk'
import type { CommsLayer, PeerMessage, WalletInterface } from '@bsv/sdk'
export const DEFAULT_ANVIL_MESSAGEBOX_HOST = 'https://anvil.sendbsv.com'
type Json = Record<string, unknown>
export interface AnvilMessageBoxOpts {
  /** The agent's BRC-100 identity wallet — drives BRC-31 auth. NEVER the operator token. */
  wallet: WalletInterface
  /** MessageBox host, e.g. `https://anvil.sendbsv.com`. One node for both agents (same-node = airtight). */
  host: string
  timeoutMs?: number
  /** Used by settlement channels which do not carry an explicit list limit. */
  defaultListLimit?: number
  /** Test seam for the authenticated HTTP client; production uses AuthFetch. */
  authFetch?: Pick<AuthFetch, 'fetch'>
}
/** Build a `CommsLayer` bound to ONE identity (the wallet's) against a MessageBox host, over BRC-31 `AuthFetch`. */
export function makeAnvilMessageBoxComms(opts: AnvilMessageBoxOpts): CommsLayer {
  if (typeof opts.host !== 'string' || opts.host.length === 0) {
    throw new Error('anvil-messagebox: host is required (e.g. https://anvil.sendbsv.com)')
  }
  const host = opts.host.replace(/\/+$/, '') // no trailing slash
  const auth = opts.authFetch ?? new AuthFetch(opts.wallet)
  let myIdentity: string | undefined // cached; fills PeerMessage.recipient (list is caller-scoped → recipient IS us)
  const timeoutMs = opts.timeoutMs ?? 15_000
  const defaultListLimit = opts.defaultListLimit ?? 16
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error('anvil-messagebox: timeoutMs must be 1000..60000')
  if (!Number.isInteger(defaultListLimit) || defaultListLimit < 1) throw new Error('anvil-messagebox: defaultListLimit must be a positive integer')
  const listsInFlight = new Map<string, { work: Promise<Json>; controller: AbortController }>()

  const deadline = <T>(work: Promise<T>, controller: AbortController, route: string): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { controller.abort(); reject(new Error(`anvil-messagebox ${route} timed out after ${timeoutMs}ms`)) }, timeoutMs)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
  const startPost = (route: string, payload: Json): { work: Promise<Json>; controller: AbortController } => {
    const controller = new AbortController()
    const work = (async (): Promise<Json> => {
      const res = await auth.fetch(`${host}${route}`, {
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
    return { work, controller }
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
      // Do not launch a replacement list while an uncooperative AuthFetch is still
      // unwinding after its caller's deadline.  Reusing it makes polling back off
      // without accumulating stalled requests or their response bodies.
      let listed = listsInFlight.get(messageBox)
      if (!listed) {
        const started = startPost('/listMessages', { messageBox, limit: limit ?? defaultListLimit })
        listed = { ...started, work: started.work.finally(() => { listsInFlight.delete(messageBox) }) }
        listsInFlight.set(messageBox, listed)
      }
      const parsed = await deadline(listed.work, listed.controller, '/listMessages')
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
