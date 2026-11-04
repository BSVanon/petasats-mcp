import { Transaction, Utils } from '@bsv/sdk'
import type { BuyerExecutor, BuyerStore, BuyerSwapRecord, BuyerSwapStage, BuyerWallet } from './types'

export function makeBuyerDelivery({ deps, now, log, updateRow, write }: {
  deps: { executor: BuyerExecutor; store: BuyerStore; wallet: BuyerWallet }
  now: () => number
  log: (message: string) => void
  updateRow: (record: BuyerSwapRecord, derive: (current: BuyerSwapRecord) => BuyerSwapRecord) => Promise<BuyerSwapRecord>
  write: (record: BuyerSwapRecord, stage: BuyerSwapStage, extra?: Partial<BuyerSwapRecord>) => Promise<BuyerSwapRecord>
}) {
  const hasDurableSweep = (): boolean => !!deps.wallet.buildSweep && !!deps.wallet.broadcastSweep && !!deps.wallet.isSweepConfirmed
  const sweepBroadcastAttempts = new Map<string, number>()
  const broadcastSweep = async (outbox: { rawTx: string; atomicBeefHex?: string; txid: string; sats: string }): Promise<boolean> => {
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
          if (!outbox && deps.executor.readSettlement && deps.wallet.buildEarlySweep) {
            const settlement = await deps.executor.readSettlement(record)
            const claimTxid = record.bsvClaimTxid ?? settlement?.bsvClaimTxid
            if (settlement?.state === 'revealed' && settlement.bsvClaimBeefHex && claimTxid) {
              let claim: Transaction | undefined
              try { claim = Transaction.fromAtomicBEEF(Utils.toArray(settlement.bsvClaimBeefHex, 'hex') as number[]) } catch { /* silently retain the confirmed path */ }
              if (claim && claim.id('hex').toLowerCase() === claimTxid.toLowerCase()) {
                const built = await deps.wallet.buildEarlySweep(record.deliverTo, { claim, claimTxid, settlementModeUsed: record.settlementModeUsed === 'fast' ? 'fast' : 'confirmed' })
                const candidate = { ...built, sats: built.sats.toString() }
                const saved = await updateRow(record, (current) => {
                  if (current.sweepOutbox || current.stage !== 'claiming') return current
                  return { ...record, ...current, bsvClaimTxid: current.bsvClaimTxid ?? claimTxid, sweepOutbox: candidate, updatedAtMs: now() }
                })
                outbox = saved.stage === 'claiming' ? saved.sweepOutbox : undefined
              }
            }
          }
          // When this recovery pass also re-broadcast the parent claim, leave a newly built child durable and send it
          // on the next pass. This preserves parent-before-child relay ordering; a crash still resumes the exact outbox.
          if (outbox && deps.wallet.broadcastSweep && (hadOutbox || !options.deferNewEarlyBroadcast)) {
            try {
              await broadcastSweep(outbox)
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
          }
          if (outbox && record.stage === 'settled') {
            const saved = await updateRow(record, (current) => current.stage === 'settled' ? { ...current, stage: 'sweeping', updatedAtMs: now() } : current)
            if (saved.stage !== 'sweeping') continue
          }
          if (outbox && deps.wallet.broadcastSweep && deps.wallet.isSweepConfirmed) {
            // Check before re-sending: a relay can reject a mined sweep (its input is spent), which must not hide delivery.
            if (await deps.wallet.isSweepConfirmed(outbox.txid, record.deliverTo)) { await write(record, 'delivered'); continue }
            await broadcastSweep(outbox) // safe to repeat: it is the exact durable transaction
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
