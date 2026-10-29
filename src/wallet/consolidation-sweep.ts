/**
 * consolidation-sweep — build the raw P2PKH sweep that DEFINITIVELY reclaims a stranded reserve (2026-09-08, doc 23).
 *
 * A stranded lock (an ambiguous-broadcast HTLC lock that never relayed) still spends a reserve coin. The only safe way
 * to kill it is to SPEND that coin in a confirmed tx (review 2026-09-08: an absence check is NOT authority). This builds
 * the spend: a single P2PKH transaction consuming EVERY supplied reserve UTXO into ONE consolidated output back to the
 * reserve address. Whichever coin the stranded lock spends is among the inputs, so once this confirms the lock is a
 * permanent double-spend — dead forever.
 *
 * Pure + I/O-free (the caller fetches each input's `sourceTx` — ideally an own-node AtomicBEEF with a merkle path, which
 * gives both the correct sighash value AND a broadcastable SPV ancestry) so the whole builder is harness-testable
 * against the mockchain. It is deliberately NOT a toolbox `createAction`: a raw tx strands NOTHING on an ambiguous
 * broadcast (all-or-nothing — it mines, or the caller retries; the coin is never half-spent, the wallet DB never
 * corrupted), which is the failure mode that created the stranded lock in the first place.
 */
import { P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction, type ScriptTemplateUnlock } from '@bsv/sdk'

export class ConsolidationSweepError extends Error {
  constructor(message: string) { super(`consolidation-sweep: ${message}`); this.name = 'ConsolidationSweepError' }
}

export interface SweepInput {
  txid: string
  vout: number
  satoshis: number
  /** The parent tx (its output at `vout` must be P2PKH(reserveAddress) worth `satoshis`); supplies sighash value +
   *  broadcast ancestry. Provide one carrying a merkle path so `tx.toBEEF()` is SPV-complete. */
  sourceTx: Transaction
  /** Optional wallet-derived signer for a non-root P2PKH input. */
  unlock?: ScriptTemplateUnlock
}

export interface BuiltSweep {
  tx: Transaction
  txid: string
  totalIn: number
  outSats: number
  fee: number
}

export interface SweepOpts {
  /** Fee rate; default 110 sat/kb (the mainnet ARC floor). */
  feeSatPerKb?: number
  /** Sanity ceiling on the fee (a consolidation should be tiny); default 100_000 sat. */
  maxFeeSats?: number
  /** Minimum acceptable consolidated output; default 546 sat. */
  dustSats?: number
}

/** Keep journal validation bound to the same ceiling the default sweep builder uses. */
export const DEFAULT_SWEEP_MAX_FEE_SATS = 100_000

/**
 * Build + sign the consolidation sweep. Fail-closed: every input's on-chain output must be EXACTLY P2PKH(reserve) worth
 * the declared value (poison guard), the result must be a single P2PKH(reserve) output, the fee must be positive and
 * bounded, and scripts-only verification must pass — else it throws and NOTHING is broadcast.
 */
export async function buildConsolidationSweep(
  inputs: SweepInput[],
  reserveKey: PrivateKey,
  reserveAddress: string,
  opts: SweepOpts = {},
): Promise<BuiltSweep> {
  const feeSatPerKb = opts.feeSatPerKb ?? 110
  const maxFeeSats = opts.maxFeeSats ?? DEFAULT_SWEEP_MAX_FEE_SATS
  const dustSats = opts.dustSats ?? 546
  if (inputs.length === 0) throw new ConsolidationSweepError('no inputs to sweep')

  const p2pkhLockHex = new P2PKH().lock(reserveAddress).toHex()
  const tx = new Transaction()
  let totalIn = 0
  const seen = new Set<string>()
  for (const u of inputs) {
    const key = `${u.txid}.${u.vout}`
    if (seen.has(key)) throw new ConsolidationSweepError(`duplicate input ${key}`)
    seen.add(key)
    if (u.sourceTx.id('hex') !== u.txid) throw new ConsolidationSweepError(`${key}: sourceTx id ${u.sourceTx.id('hex')} ≠ declared txid`)
    const sout = u.sourceTx.outputs[u.vout]
    if (!sout) throw new ConsolidationSweepError(`${key}: source tx has no output at vout ${u.vout}`)
    if (sout.satoshis !== u.satoshis) throw new ConsolidationSweepError(`${key}: source output ${sout.satoshis} sat ≠ declared ${u.satoshis} sat`)
    if (!u.unlock && sout.lockingScript.toHex() !== p2pkhLockHex) throw new ConsolidationSweepError(`${key}: output is not P2PKH(${reserveAddress}) — refusing (not a reserve coin)`)
    tx.addInput({
      sourceTransaction: u.sourceTx,
      sourceOutputIndex: u.vout,
      unlockingScriptTemplate: u.unlock ?? new P2PKH().unlock(reserveKey, 'all', false),
    })
    totalIn += u.satoshis
  }

  tx.addOutput({ lockingScript: new P2PKH().lock(reserveAddress), change: true })
  await tx.fee(new SatoshisPerKilobyte(feeSatPerKb))
  await tx.sign()

  if (tx.outputs.length !== 1) throw new ConsolidationSweepError(`sweep must have exactly 1 output, got ${tx.outputs.length}`)
  if (tx.outputs[0].lockingScript.toHex() !== p2pkhLockHex) throw new ConsolidationSweepError('sweep output is not P2PKH(reserve) — funds would not return to the reserve')
  const outSats = tx.outputs[0].satoshis ?? 0
  const fee = totalIn - outSats
  if (outSats <= dustSats) throw new ConsolidationSweepError(`sweep output ${outSats} sat ≤ dust (${dustSats})`)
  if (fee <= 0 || fee > maxFeeSats) throw new ConsolidationSweepError(`sweep fee ${fee} sat out of bounds (0, ${maxFeeSats}]`)
  if (!(await tx.verify('scripts only'))) throw new ConsolidationSweepError('scripts-only verification FAILED on the signed sweep')

  return { tx, txid: tx.id('hex') as string, totalIn, outSats, fee }
}
