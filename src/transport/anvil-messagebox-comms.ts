import { AuthFetch } from '@bsv/sdk'
import type { CommsLayer, PeerMessage, WalletInterface } from '@bsv/sdk'
export const DEFAULT_ANVIL_MESSAGEBOX_HOST = 'https://anvil.sendbsv.com'
type Json = Record<string, unknown>
export interface AnvilMessageBoxOpts {
  /** The agent's BRC-100 identity wallet — drives BRC-31 auth. NEVER the operator token. */
  wallet: WalletInterface
  /** MessageBox host, e.g. `https://anvil.sendbsv.com`. One node for both agents (same-node = airtight). */
  host: string
}
/** Build a `CommsLayer` bound to ONE identity (the wallet's) against a MessageBox host, over BRC-31 `AuthFetch`. */
export function makeAnvilMessageBoxComms(opts: AnvilMessageBoxOpts): CommsLayer {
  if (typeof opts.host !== 'string' || opts.host.length === 0) {
    throw new Error('anvil-messagebox: host is required (e.g. https://anvil.sendbsv.com)')
  }
  const host = opts.host.replace(/\/+$/, '') // no trailing slash
  const auth = new AuthFetch(opts.wallet)
  let myIdentity: string | undefined // cached; fills PeerMessage.recipient (list is caller-scoped → recipient IS us)

  const post = async (route: string, payload: Json): Promise<Json> => {
    const res = await auth.fetch(`${host}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const parsed = (await res.json().catch(() => ({}))) as Json
    if (!res.ok || parsed.status === 'error') {
      const detail = (parsed.error ?? parsed.description ?? `HTTP ${res.status}`) as string
      throw new Error(`anvil-messagebox ${route} failed: ${detail}`)
    }
    return parsed
  }

  return {
    async sendMessage({ recipient, messageBox, body }): Promise<string> {
      const parsed = await post('/sendMessage', { recipient, messageBox, body })
      return String(parsed.messageId) // server-minted id — used later to acknowledge
    },
    async listMessages({ messageBox }): Promise<PeerMessage[]> {
      const parsed = await post('/listMessages', { messageBox })
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
