import { Transaction, Utils } from '@bsv/sdk'
export interface BeefSpendBroadcastRails {
  /** The lock tx WITH its merkle path (AtomicBEEF). null ⇒ proof not servable yet (this THROWS). Absent ⇒ bare rail. */
  fetchBeef?: (txid: string) => Promise<Transaction | null>
  /** Broadcast via the mainnet ladder: the RAW tx (for the raw-only tiers — WoC/Bitails, which relay to miners once the
   *  parent confirms) + the optional ATOMIC BEEF (for the BEEF-capable tiers — Anvil/ARC, which carry 0-conf ancestry).
   *  Returns the txid. Passing the raw + BEEF SEPARATELY is what lets the ladder fall through Anvil's 'validated-only'
   *  to a miner-submitter (a single BEEF-as-wire arg broke the WoC/Bitails tiers; drill finding 2026-08-30). */
  broadcast: (rawTx: string, atomicBeefHex?: string) => Promise<string>
}
/**
 * Broadcast `spendTx` (an HTLC claim or refund whose input 0 spends the lock). If the rail is an
 * own-node (`fetchBeef` present), attach the lock's proof and build its atomic BEEF for the BEEF-capable ladder tiers;
 * either way the raw tx feeds the raw-only tiers. Returns the broadcast txid. Throws if the lock proof can't be served
 * yet (fail-closed).
 */
export async function broadcastHtlcSpendAsBeef(spendTx: Transaction, rails: BeefSpendBroadcastRails): Promise<string> {
  const rawTx = spendTx.toHex()
  const lockInput = spendTx.inputs[0]
  const lockTxid = lockInput?.sourceTXID
  let atomicBeefHex: string | undefined
  if (rails.fetchBeef && lockTxid) {
    const lockWithProof = await rails.fetchBeef(lockTxid)
    if (!lockWithProof || lockWithProof.id('hex') !== lockTxid) throw new Error(`HTLC spend: lock merkle proof (BEEF) not yet servable for ${lockTxid}`)
    lockInput.sourceTransaction = lockWithProof
    atomicBeefHex = Utils.toHex(spendTx.toAtomicBEEF())
  }
  return rails.broadcast(rawTx, atomicBeefHex)
}
