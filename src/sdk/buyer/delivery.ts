import { Beef, P2PKH, Transaction, Utils } from '@bsv/sdk'
import type { BuyerExecutor, BuyerStore, BuyerSwapRecord, BuyerSwapStage, BuyerWallet } from './types'

const REFUSED_DELIVERY = "refused a saved delivery that does not pay this swap's address"

// At the kit's 500 sat/KB fee rate this permits a 10 KB sweep, comfortably above its normal size.
export const MAX_SWEEP_FEE_SATS = 5_000

type SavedSweep = { rawTx: string; atomicBeefHex?: string; txid: string; sats: string }

// BRC-95: an Atomic BEEF holds only its subject and the ancestors the subject needs. The SDK parser does not check
// this, and a relay may act on every transaction it is handed, so an unrelated one is refused here.
function assertOnlySweepAncestry(beefBytes: number[], subject: Transaction): void {
  const graph = new Set<string>()
  const visit = (tx: Transaction): void => {
    const id = tx.id('hex').toLowerCase()
    if (graph.has(id)) return
    graph.add(id)
    if (tx.merklePath) return
    for (const input of tx.inputs) {
      if (input.sourceTransaction) visit(input.sourceTransaction)
      else if (input.sourceTXID) graph.add(input.sourceTXID.toLowerCase())
    }
  }
  visit(subject)
  if (Beef.fromBinary(beefBytes).txs.some((entry) => !graph.has(entry.txid.toLowerCase()))) {
    throw new Error('delivery Atomic BEEF holds a transaction outside the sweep ancestry')
  }
}

function claimInputValue(record: BuyerSwapRecord, tx: Transaction, claimArtifact?: Transaction): bigint {
  let total = 0n
  let complete = true
  for (const input of tx.inputs) {
    const claim = input.sourceTransaction ?? claimArtifact
    const source = claim?.outputs[input.sourceOutputIndex]
    if (!claim || claim.id('hex').toLowerCase() !== record.bsvClaimTxid!.toLowerCase() ||
        typeof source?.satoshis !== 'number' || !Number.isSafeInteger(source.satoshis) || source.satoshis < 0) {
      complete = false
      break
    }
    total += BigInt(source.satoshis)
  }
  // Only hash-bound claim bytes count; a figure saved in the buyer row is never trusted for this.
  if (complete) return total
  throw new Error('delivery claim input value cannot be established')
}

/** Last-mile authorization for both newly built and crash-replayed delivery bytes. */
export function assertSweepPaysBuyer(record: BuyerSwapRecord, outbox: SavedSweep, claimArtifact?: Transaction): void {
  if (!record.deliverTo || !record.bsvClaimTxid) throw new Error('delivery record has no destination or claim transaction')
  let tx: Transaction
  try { tx = Transaction.fromHex(outbox.rawTx) } catch { throw new Error('delivery transaction cannot be decoded') }
  if (tx.id('hex').toLowerCase() !== outbox.txid.toLowerCase()) throw new Error('delivery transaction id mismatch')
  // Every sweep builder the kit and the page have shipped saves its Atomic BEEF with the delivery (since saved
  // deliveries began, fbdb99f0). A delivery without one was not made by them and its claim value cannot be proven.
  if (outbox.atomicBeefHex === undefined) throw new Error('delivery has no Atomic BEEF')
  const beefBytes = Utils.toArray(outbox.atomicBeefHex, 'hex') as number[]
  let beefSubject: Transaction
  try { beefSubject = Transaction.fromAtomicBEEF(beefBytes) } catch { throw new Error('delivery Atomic BEEF cannot be decoded') }
  if (beefSubject.id('hex').toLowerCase() !== outbox.txid.toLowerCase()) throw new Error('delivery Atomic BEEF subject id mismatch')
  if (beefSubject.toHex().toLowerCase() !== outbox.rawTx.toLowerCase()) throw new Error('delivery Atomic BEEF subject bytes mismatch')
  assertOnlySweepAncestry(beefBytes, beefSubject)
  if (!tx.inputs.length || tx.inputs.some((input) => (input.sourceTXID ?? input.sourceTransaction?.id('hex'))?.toLowerCase() !== record.bsvClaimTxid!.toLowerCase())) {
    throw new Error('delivery transaction does not spend only this swap claim')
  }
  if (tx.outputs.length !== 1) throw new Error('delivery transaction must have exactly one output')
  let expectedScript: string
  try { expectedScript = new P2PKH().lock(record.deliverTo).toHex() } catch { throw new Error('delivery address is invalid') }
  const output = tx.outputs[0]
  if (output.lockingScript.toHex() !== expectedScript) throw new Error('delivery output address mismatch')
  if (typeof output.satoshis !== 'number' || !Number.isSafeInteger(output.satoshis) || BigInt(output.satoshis) !== BigInt(outbox.sats)) throw new Error('delivery output amount mismatch')
  const fee = claimInputValue(record, beefSubject, claimArtifact) - BigInt(output.satoshis)
  if (fee < 0n || fee > BigInt(MAX_SWEEP_FEE_SATS)) throw new Error('delivery sweep fee exceeds the allowed ceiling')
}

export function makeBuyerDelivery({ deps, now, log, updateRow, write }: {
  deps: { executor: BuyerExecutor; store: BuyerStore; wallet: BuyerWallet }
  now: () => number
  log: (message: string) => void
  updateRow: (record: BuyerSwapRecord, derive: (current: BuyerSwapRecord) => BuyerSwapRecord) => Promise<BuyerSwapRecord>
  write: (record: BuyerSwapRecord, stage: BuyerSwapStage, extra?: Partial<BuyerSwapRecord>) => Promise<BuyerSwapRecord>
}) {
  const hasDurableSweep = (): boolean => !!deps.wallet.buildSweep && !!deps.wallet.broadcastSweep && !!deps.wallet.isSweepConfirmed
  const sweepBroadcastAttempts = new Map<string, number>()
  const broadcastSweep = async (record: BuyerSwapRecord, outbox: SavedSweep, claimArtifact?: Transaction): Promise<boolean> => {
    try { assertSweepPaysBuyer(record, outbox, claimArtifact) } catch { log(REFUSED_DELIVERY); return false }
    const txid = outbox.txid.toLowerCase()
    const attemptedAt = now()
    const lastAttempt = sweepBroadcastAttempts.get(txid)
    if (lastAttempt !== undefined && attemptedAt - lastAttempt < 60_000) return false
    // Record before awaiting the relay so overlapping recoveries cannot both send.
    sweepBroadcastAttempts.set(txid, attemptedAt)
    await deps.wallet.broadcastSweep!(outbox)
    return true
  }
  return {
    hasDurableSweep,
    recover: async (options: { deferNewEarlyBroadcast?: boolean } = {}): Promise<void> => {
      // A revealed claim's Atomic BEEF is enough to build its child without waiting
      // for the UTXO indexer. The settlement checkpoint is the irreversible gate.
      for (const record of await deps.store.list()) {
        if (!record.deliverTo || record.stage !== 'claiming') continue
        try {
          const hadOutbox = !!record.sweepOutbox
          let outbox = record.sweepOutbox
          let deliveryRecord = record
          const settlement = deps.executor.readSettlement && !outbox ? await deps.executor.readSettlement(record) : undefined
          const claimTxid = record.bsvClaimTxid ?? settlement?.bsvClaimTxid
          let claimArtifact: Transaction | undefined
          if (settlement?.state === 'revealed' && settlement.bsvClaimBeefHex && claimTxid) {
            try { claimArtifact = Transaction.fromAtomicBEEF(Utils.toArray(settlement.bsvClaimBeefHex, 'hex') as number[]) } catch { /* silently retain the confirmed path */ }
            if (claimArtifact?.id('hex').toLowerCase() !== claimTxid.toLowerCase()) claimArtifact = undefined
          }
          if (!outbox && deps.wallet.buildEarlySweep && claimArtifact && claimTxid) {
            const built = await deps.wallet.buildEarlySweep(record.deliverTo, { claim: claimArtifact, claimTxid, settlementModeUsed: record.settlementModeUsed === 'fast' ? 'fast' : 'confirmed' })
            const candidate = { ...built, sats: built.sats.toString() }
            const saved = await updateRow(record, (current) => {
              if (current.sweepOutbox || current.stage !== 'claiming') return current
              return { ...record, ...current, bsvClaimTxid: current.bsvClaimTxid ?? claimTxid, sweepOutbox: candidate, updatedAtMs: now() }
            })
            outbox = saved.stage === 'claiming' ? saved.sweepOutbox : undefined
            deliveryRecord = saved
          }
          // When this recovery pass also re-broadcast the parent claim, leave a newly built child durable and send it
          // on the next pass. This preserves parent-before-child relay ordering; a crash still resumes the exact outbox.
          if (outbox && deps.wallet.broadcastSweep && (hadOutbox || !options.deferNewEarlyBroadcast)) {
            try {
              await broadcastSweep(deliveryRecord, outbox, claimArtifact)
            } catch (error) {
              log(`could not send the early delivery for ${record.swapId} (sweep ${outbox.txid}): ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        } catch { /* silently retain the confirmed recovery path and any durable outbox for retry */ }
      }
      // A claim is not safe to deliver until it has independently buried. This
      // confirmed path deliberately reuses an early durable outbox if present.
      for (const record of await deps.store.list()) {
        if (!record.deliverTo || !record.bsvClaimTxid || (record.stage !== 'claimed' && record.stage !== 'settled' && record.stage !== 'sweeping')) continue
        try {
          let outbox = record.sweepOutbox
          let deliveryRecord = record
          if (!outbox && deps.wallet.buildSweep) {
            const built = await deps.wallet.buildSweep(record.deliverTo, { onlyTxid: record.bsvClaimTxid })
            // The signed transaction is durable before it can escape to a relay.
            const candidate = { ...built, sats: built.sats.toString() }
            const saved = await updateRow(record, (current) => {
              if (current.sweepOutbox || (current.stage !== 'claimed' && current.stage !== 'settled' && current.stage !== 'sweeping')) return current
              return { ...record, ...current, stage: 'sweeping', sweepOutbox: candidate, updatedAtMs: now() }
            })
            // A concurrent recovery may have won with another candidate. Never send ours.
            outbox = saved.sweepOutbox
            deliveryRecord = saved
          }
          if (outbox && record.stage === 'settled') {
            const saved = await updateRow(record, (current) => current.stage === 'settled' ? { ...current, stage: 'sweeping', updatedAtMs: now() } : current)
            if (saved.stage !== 'sweeping') continue
          }
          if (outbox && deps.wallet.broadcastSweep && deps.wallet.isSweepConfirmed) {
            try { assertSweepPaysBuyer(deliveryRecord, outbox) } catch { log(REFUSED_DELIVERY); continue }
            // Check before re-sending: a relay can reject a mined sweep (its input is spent), which must not hide delivery.
            if (await deps.wallet.isSweepConfirmed(outbox.txid, record.deliverTo)) { await write(record, 'delivered'); continue }
            await broadcastSweep(deliveryRecord, outbox) // safe to repeat: it is the exact durable transaction
            if (await deps.wallet.isSweepConfirmed(outbox.txid, record.deliverTo)) await write(record, 'delivered')
          } else if (!hasDurableSweep()) {
            log(`cannot automatically deliver_to for ${record.swapId}: deliver_to needs the durable sweep interface (buildSweep, broadcastSweep, and isSweepConfirmed)`)
          }
        } catch (error) {
          log(`could not sweep confirmed BSV for ${record.swapId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
  }
}
