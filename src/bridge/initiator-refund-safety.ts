import { P2PKH, Transaction } from '@bsv/sdk'
import { bridgeCovenantRefundSats, extractBridgeCovenantSecret } from '../settlement/htlc/bridge-covenant'
import { DEFAULT_BSV_FINALITY_CONFIRMATIONS } from './bsv-claim-proof'
import { SettlementSession, type SettlementRecord } from './settlement-session'

export interface InitiatorRefundSafetyBsvRails {
  resolveSpender: (txid: string, vout: number) => Promise<string | null>
  fetchTx: (txid: string) => Promise<Transaction | null>
  /** Header-validated Merkle/depth proof. A discovery-provider confirmation count is insufficient. */
  proveFinality?: (txid: string, minimumConfirmations: number) => Promise<boolean>
  /** Read every confirmed and unconfirmed transaction associated with an exact BSV locking script. */
  readScriptHistory?: (lockingScriptHex: string) => Promise<string[]>
}

export interface BsvLockRefundEvidence {
  spenderTxid: string
  observedAtMs: number
}

export function isLockSpentByCovenantRefund(rec: SettlementRecord, spend: Transaction, lockTxid: string, vout: number): boolean {
  try {
    const session = SettlementSession.fromRecord(rec)
    const terms = session.covenantTerms()
    const input = spend.inputs.find((candidate) => candidate.sourceTXID?.toLowerCase() === lockTxid.toLowerCase() && candidate.sourceOutputIndex === vout)
    const out0 = spend.outputs[0]
    return !!input && !extractBridgeCovenantSecret(spend, lockTxid, vout, rec.hashHex) && spend.lockTime >= terms.bsvRefundLocktime &&
      out0?.satoshis === bridgeCovenantRefundSats(terms) &&
      out0.lockingScript.toHex() === new P2PKH().lock(terms.mmBsvAddress).toHex()
  } catch { return false }
}

function requiredLockOutpoint(rec: SettlementRecord): { lockTxid: string; vout: number } {
  const [lockTxid = '', voutText = ''] = (rec.bsvLockOutpoint ?? '').split('_')
  const vout = Number(voutText)
  if (!/^[0-9a-fA-F]{64}$/.test(lockTxid) || !Number.isSafeInteger(vout) || vout < 0) {
    throw new Error('durable BSV lock outpoint is malformed; Base refund safety is unknown')
  }
  return { lockTxid, vout }
}

async function requireBuriedCovenantRefund(spenderTxid: string, rails: InitiatorRefundSafetyBsvRails): Promise<void> {
  if (!rails.proveFinality) throw new Error('BSV covenant refund finality proof rail is unavailable; Base refund refused')
  let proved: boolean
  try { proved = await rails.proveFinality(spenderTxid, DEFAULT_BSV_FINALITY_CONFIRMATIONS) }
  catch (error) {
    throw new Error(`BSV covenant refund ${spenderTxid} finality proof failed; Base refund refused: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!proved) {
    throw new Error(`BSV covenant refund ${spenderTxid} is not header-validated at depth ${DEFAULT_BSV_FINALITY_CONFIRMATIONS}; Base refund refused`)
  }
}

/** Freshly prove the exact BSV outpoint was consumed by the responder's canonical covenant refund. */
export async function proveBsvLockCovenantRefund(
  rec: SettlementRecord,
  rails: InitiatorRefundSafetyBsvRails,
  nowMs: () => number = Date.now,
): Promise<BsvLockRefundEvidence> {
  const { lockTxid, vout } = requiredLockOutpoint(rec)
  let spenderTxid: string | null
  try { spenderTxid = await rails.resolveSpender(lockTxid, vout) }
  catch (error) {
    throw new Error(`BSV lock-spend read failed; Base refund safety is unknown: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!spenderTxid) throw new Error('BSV lock outpoint is unspent; responder covenant refund is not proven')

  let spend: Transaction | null
  try { spend = await rails.fetchTx(spenderTxid) }
  catch (error) {
    throw new Error(`BSV lock spender ${spenderTxid} could not be inspected; Base refund refused: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!spend || spend.id('hex').toLowerCase() !== spenderTxid.toLowerCase()) {
    throw new Error(`BSV lock spender ${spenderTxid} is unavailable or mismatched; Base refund refused`)
  }
  if (extractBridgeCovenantSecret(spend, lockTxid, vout, rec.hashHex)) {
    throw new Error(`BSV lock outpoint was spent by claim ${spenderTxid}; preimage is public and Base refund is forbidden`)
  }
  if (!isLockSpentByCovenantRefund(rec, spend, lockTxid, vout)) {
    throw new Error(`BSV lock outpoint has unknown non-claim spend ${spenderTxid}; Base refund refused`)
  }
  await requireBuriedCovenantRefund(spenderTxid, rails)
  return { spenderTxid: spenderTxid.toLowerCase(), observedAtMs: nowMs() }
}

async function assertOutpointSafe(
  rec: SettlementRecord,
  rails: InitiatorRefundSafetyBsvRails,
  lockTxid: string,
  vout: number,
): Promise<void> {
  let spender: string | null
  try { spender = await rails.resolveSpender(lockTxid, vout) }
  catch (error) {
    throw new Error(`BSV lock-spend read failed; Base refund safety is unknown: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!spender) return

  let spend: Transaction | null
  try { spend = await rails.fetchTx(spender) }
  catch (error) {
    throw new Error(`BSV lock spender ${spender} could not be inspected; Base refund refused: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!spend || spend.id('hex').toLowerCase() !== spender.toLowerCase()) {
    throw new Error(`BSV lock spender ${spender} is unavailable or mismatched; Base refund refused`)
  }
  if (extractBridgeCovenantSecret(spend, lockTxid, vout, rec.hashHex)) {
    throw new Error(`BSV lock outpoint was spent by claim ${spender}; preimage is public and Base refund is forbidden`)
  }

  if (!rec.bsvRefundTxHex) {
    if (isLockSpentByCovenantRefund(rec, spend, lockTxid, vout)) {
      await requireBuriedCovenantRefund(spender, rails)
      return
    }
    throw new Error(`BSV lock outpoint has unknown non-claim spend ${spender}; Base refund refused`)
  }
  let refund: Transaction
  try {
    SettlementSession.fromRecord(rec).assertPersistedRefundValid()
    refund = Transaction.fromHex(rec.bsvRefundTxHex)
  } catch (error) {
    throw new Error(`BSV lock outpoint has an unverified spend ${spender}; Base refund refused: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (refund.id('hex').toLowerCase() !== spender.toLowerCase()) {
    throw new Error(`BSV lock outpoint has unknown spend ${spender}; Base refund refused`)
  }
  await requireBuriedCovenantRefund(spender, rails)
}

/** Fail closed unless no BSV lock ever existed, or every discovered exact lock is provably safe. */
export async function assertInitiatorRefundSafeOnBsv(
  rec: SettlementRecord,
  rails?: InitiatorRefundSafetyBsvRails,
): Promise<void> {
  const covenantRefundEvidence = rec.role === 'initiator' &&
    (rec.state === 'revealed' || rec.state === 'refunding') ? rec.bsvLockRefundEvidence : undefined
  if (covenantRefundEvidence) {
    if (!rails) throw new Error('BSV lock-spend rails are unavailable; Base refund safety is unknown')
    const fresh = await proveBsvLockCovenantRefund(rec, rails)
    if (fresh.spenderTxid !== covenantRefundEvidence.spenderTxid.toLowerCase()) {
      throw new Error('fresh responder covenant-refund proof does not match the persisted routing evidence; Base refund refused')
    }
    return
  }
  if (rec.state === 'revealed' || rec.bsvClaimTxid || rec.bsvClaimTxHex || rec.bsvClaimBeefHex) {
    throw new Error('durable BSV claim/reveal evidence exists; Base refund is unsafe')
  }
  if (rec.bsvLockOutpoint) {
    if (!rails) throw new Error('BSV lock-spend rails are unavailable; Base refund safety is unknown')
    const { lockTxid, vout } = requiredLockOutpoint(rec)
    await assertOutpointSafe(rec, rails, lockTxid, vout)
    return
  }

  // New records guarantee that the reveal state + exact claim bytes reach durable storage before broadcast. With no
  // claim evidence, this build never broadcast a claim, whether or not an unrecorded responder lock once existed.
  if (rec.bsvClaimWriteAhead === true) return

  if (!rails) throw new Error('legacy record has no BSV lock outpoint or write-ahead marker, and BSV lock-spend rails are unavailable; Base refund safety is unknown')
  if (!rails.readScriptHistory) {
    throw new Error('legacy record has no BSV lock outpoint or write-ahead marker, and script-history rails are unavailable; Base refund refused — operator must restore a read-only BSV history source')
  }
  let lockingScriptHex: string
  try { lockingScriptHex = SettlementSession.fromRecord(rec).bsvHtlcScriptHex() }
  catch (error) {
    throw new Error(`legacy record BSV lock script cannot be derived from its swap terms; Base refund refused — operator must repair the record: ${error instanceof Error ? error.message : String(error)}`)
  }
  let historyTxids: string[]
  try { historyTxids = await rails.readScriptHistory(lockingScriptHex) }
  catch (error) {
    throw new Error(`legacy record BSV script-history read failed; Base refund refused and watchtower health is critical — operator must restore the chain reader: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (historyTxids.length === 0) return

  const outpoints: Array<{ txid: string; vout: number }> = []
  for (const txid of historyTxids) {
    let tx: Transaction | null
    try { tx = await rails.fetchTx(txid) }
    catch (error) {
      throw new Error(`legacy record BSV script-history transaction ${txid} could not be read; Base refund refused and watchtower health is critical: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!tx || tx.id('hex').toLowerCase() !== txid.toLowerCase()) {
      throw new Error(`legacy record BSV script-history transaction ${txid} is unavailable or mismatched; Base refund refused and watchtower health is critical`)
    }
    tx.outputs.forEach((output, vout) => {
      if (output.lockingScript.toHex().toLowerCase() === lockingScriptHex.toLowerCase()) outpoints.push({ txid, vout })
    })
  }
  if (outpoints.length === 0) {
    throw new Error('legacy record BSV script history reported activity but no exact lock output could be verified; Base refund refused and watchtower health is critical')
  }
  for (const outpoint of outpoints) await assertOutpointSafe(rec, rails, outpoint.txid, outpoint.vout)
}
