import {
  Hash,
  LockingScript,
  OP,
  P2PKH,
  Random,
  SatoshisPerKilobyte,
  Script,
  Transaction,
  UnlockingScript,
  Utils,
} from '@bsv/sdk'
import { calculatePreimage } from '@bsv/wallet-helper'
import { buildPushTxVerifyScript, DEFAULT_COVENANT_SIGHASH, encodeScriptBigNum } from './pushtx'
import { BigNumber } from '@bsv/sdk'
const HEX32 = /^[0-9a-fA-F]{64}$/
/** Sequence used on the refund input — non-final so consensus enforces nLockTime. */
export const REFUND_SEQUENCE = 0xfffffffe
/** Consensus nLockTime split (BIP-65): a value BELOW this is a BLOCK HEIGHT, a value AT/ABOVE is a UNIX TIMESTAMP.
 *  The covenant refund's nLockTime MUST stay in the block-height domain (< this) so the in-script `nLockTime ≥ T_bsv`
 *  really means "after block T_bsv". Without the upper bound a spender sets nLockTime to a PAST timestamp (≥ 500M):
 *  `≥ T_bsv` passes numerically, but consensus treats it as already-elapsed → the refund mines IMMEDIATELY, bypassing
 *  the height timelock (red-team CRITICAL, 2026-09-01). CLTV/BIP-65 guards this for free; the hand-rolled compare must. */
export const LOCKTIME_THRESHOLD = 500_000_000
// ─── Output-serialization helpers (for the forced hashOutputs constants) ─────
/** uint64 little-endian, 8 bytes. */
function uint64LE(n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('uint64LE: non-negative safe integer required')
  const out: number[] = []
  let lo = n % 0x100000000
  let hi = Math.floor(n / 0x100000000)
  for (let i = 0; i < 4; i++) { out.push(lo & 0xff); lo >>>= 8 }
  for (let i = 0; i < 4; i++) { out.push(hi & 0xff); hi = Math.floor(hi / 256) }
  return out
}

/** Bitcoin varint (script lengths here are always 25 → single byte). */
function varIntBytes(n: number): number[] {
  if (n < 0) throw new Error('varIntBytes: negative')
  if (n < 0xfd) return [n]
  if (n <= 0xffff) return [0xfd, n & 0xff, (n >> 8) & 0xff]
  throw new Error('varIntBytes: script length too large for a P2PKH output')
}

/**
 * Serialize a tx output exactly as BIP-143 hashes it: value(8 LE) ||
 * varint(scriptLen) || script. The script is the real `P2PKH().lock(address)`
 * so the forced constant is byte-identical to the output the spender produces.
 */
function serializeP2pkhOutput(sats: number, address: string): number[] {
  const scriptBytes = Utils.toArray(new P2PKH().lock(address).toHex(), 'hex') as number[]
  return [...uint64LE(sats), ...varIntBytes(scriptBytes.length), ...scriptBytes]
}

/** The SIGHASH_SINGLE hashOutputs value for a single forced P2PKH output. */
export function expectedHashOutputs(sats: number, address: string): number[] {
  return Hash.hash256(serializeP2pkhOutput(sats, address))
}

// ─── Build the covenant lock script ──────────────────────────────────────────

export interface BuildCovenantHtlcParams {
  /** `H = SHA256(s)` as 32-byte hex — the hashlock (matches the Base ERC20Swap sha256). */
  hashHex: string
  /** Where the claim is FORCED to pay (Alice / the swap recipient). */
  payoutAddress: string
  /** Exact sats forced to `payoutAddress` on claim (= the swap amount). */
  payoutSats: number
  
  refundAddress: string
  /** Exact sats forced to `refundAddress` on refund (= covenantSats − a fixed refund-fee budget). */
  refundSats: number
  /** Absolute BSV block height before which the refund cannot confirm (T_bsv). */
  refundLockHeight: number
}

/**
 * Extract the last-32-of-a-tail-stripped field from the preimage on the stack.
 * Emits: strip the trailing `tailBytes`, then take the last `fieldBytes`.
 * Consumes the top preimage copy and leaves `[field]`. (`OP_DUP` first if you
 * need the preimage preserved underneath.)
 */
function emitTailFieldExtract(s: Script, tailBytes: number, fieldBytes: number): void {
  // strip trailing `tailBytes`
  s.writeOpCode(OP.OP_SIZE)
  writeScriptNum(s, tailBytes)
  s.writeOpCode(OP.OP_SUB)
  s.writeOpCode(OP.OP_SPLIT)
  s.writeOpCode(OP.OP_DROP) // [head]
  // take the last `fieldBytes`
  s.writeOpCode(OP.OP_SIZE)
  writeScriptNum(s, fieldBytes)
  s.writeOpCode(OP.OP_SUB)
  s.writeOpCode(OP.OP_SPLIT)
  s.writeOpCode(OP.OP_NIP) // [field]
}

/** Push a small non-negative int as a minimal Script number / minimal push. */
function writeScriptNum(s: Script, n: number): void {
  if (n < 0) throw new Error('writeScriptNum: negative')
  if (n === 0) { s.writeOpCode(OP.OP_0); return }
  if (n >= 1 && n <= 16) { s.writeOpCode(OP.OP_1 - 1 + n); return } // OP_1..OP_16
  s.writeBin(encodeScriptBigNum(new BigNumber(n)))
}

export function buildCovenantHtlcScript(p: BuildCovenantHtlcParams): LockingScript {
  if (!HEX32.test(p.hashHex)) throw new Error('buildCovenantHtlcScript: hashHex must be 32-byte hex')
  if (!Number.isSafeInteger(p.payoutSats) || p.payoutSats < 1) throw new Error('payoutSats must be a positive integer')
  if (!Number.isSafeInteger(p.refundSats) || p.refundSats < 1) throw new Error('refundSats must be a positive integer')
  if (!Number.isSafeInteger(p.refundLockHeight) || p.refundLockHeight < 1 || p.refundLockHeight >= 500_000_000) {
    throw new Error('refundLockHeight must be a positive block height (< 500,000,000)')
  }
  const hash = Utils.toArray(p.hashHex, 'hex') as number[]
  const expClaim = expectedHashOutputs(p.payoutSats, p.payoutAddress)
  const expRefund = expectedHashOutputs(p.refundSats, p.refundAddress)
  const FINAL_SEQ = [0xff, 0xff, 0xff, 0xff]

  const s = new Script()

  // ───── CLAIM branch: reveal s, force output[0] = {payoutSats → payout} ─────
  s.writeOpCode(OP.OP_IF)
  s.writeOpCode(OP.OP_SHA256)
  s.writeBin(hash)
  s.writeOpCode(OP.OP_EQUALVERIFY) // SHA256(s)==H; stack [preimage]
  for (const c of buildPushTxVerifyScript(DEFAULT_COVENANT_SIGHASH).chunks) s.chunks.push(c) // authenticate; [preimage]
  emitTailFieldExtract(s, 8, 32) // hashOutputs = bytes [len-40,len-8); consumes preimage → [hashOutputs]
  s.writeBin(expClaim)
  s.writeOpCode(OP.OP_EQUAL) // [bool] — the claim branch result

  // ───── REFUND branch: force output[0] = {refundSats → refund}, timelocked ──
  s.writeOpCode(OP.OP_ELSE)
  for (const c of buildPushTxVerifyScript(DEFAULT_COVENANT_SIGHASH).chunks) s.chunks.push(c) // authenticate; [preimage]
  // (a) force the refund output
  s.writeOpCode(OP.OP_DUP)
  emitTailFieldExtract(s, 8, 32) // [preimage, hashOutputs]
  s.writeBin(expRefund)
  s.writeOpCode(OP.OP_EQUALVERIFY) // [preimage]
  // (b) enforce T_bsv ≤ nLockTime < LOCKTIME_THRESHOLD. BOTH bounds matter (red-team CRITICAL 2026-09-01): the lower
  //     bound is the timelock; the UPPER bound forces nLockTime into the BLOCK-HEIGHT domain. Without it a spender sets
  //     nLockTime to a PAST UNIX TIMESTAMP (≥ 500,000,000) that passes `≥ T_bsv` numerically but consensus treats as
  //     already-elapsed → the refund mines IMMEDIATELY, bypassing the height timelock (early refund + still-holds-s =
  //     both-legs theft). BIP-65 CLTV enforces this domain match for free; the hand-rolled compare must replicate it.
  s.writeOpCode(OP.OP_DUP)
  emitTailFieldExtract(s, 4, 4) // nLockTime = bytes [len-8,len-4); [preimage, nLockTime4]
  s.writeOpCode(OP.OP_BIN2NUM)  // [preimage, nLockTime]
  s.writeOpCode(OP.OP_DUP)      // [preimage, nLockTime, nLockTime]
  writeScriptNum(s, LOCKTIME_THRESHOLD)
  s.writeOpCode(OP.OP_LESSTHAN) // nLockTime < 500,000,000 → in the block-height domain (not a timestamp)
  s.writeOpCode(OP.OP_VERIFY)   // [preimage, nLockTime]
  writeScriptNum(s, p.refundLockHeight)
  s.writeOpCode(OP.OP_GREATERTHANOREQUAL)
  s.writeOpCode(OP.OP_VERIFY) // [preimage]
  // (c) enforce nSequence ≠ 0xffffffff (non-final → consensus honours nLockTime)
  emitTailFieldExtract(s, 40, 4) // nSequence = bytes [len-44,len-40); consumes preimage → [nSequence4]
  s.writeBin(FINAL_SEQ)
  s.writeOpCode(OP.OP_EQUAL)
  s.writeOpCode(OP.OP_NOT) // [bool] — the refund branch result
  s.writeOpCode(OP.OP_ENDIF)

  return LockingScript.fromHex(s.toHex())
}

/**
 * Rebuild the covenant from the agreed terms and byte-compare — the safe way for
 * Alice / a watchtower to confirm a discovered lock forces the right payout
 * before trusting it (no partial parser: any deviation fails the byte-compare).
 */
export function covenantMatches(scriptHex: string, p: BuildCovenantHtlcParams): boolean {
  try {
    return buildCovenantHtlcScript(p).toHex().toLowerCase() === scriptHex.toLowerCase()
  } catch {
    return false
  }
}

export function assertCovenantMatches(scriptHex: string, p: BuildCovenantHtlcParams): void {
  if (!covenantMatches(scriptHex, p)) {
    throw new Error('covenant script does not match the agreed escrow terms — do NOT trust this lock')
  }
}

// ─── The covenant UTXO + spend paths ─────────────────────────────────────────

export interface CovenantUtxo {
  txid: string
  vout: number
  satoshis: number
  /** The covenant locking script hex (from buildCovenantHtlcScript). */
  scriptHex: string
}

/** Source-tx surrogate so @bsv/sdk can fee/sign the covenant spend (mirrors bsv-htlc). */
export function makeCovenantPrevTx(covenant: CovenantUtxo): Transaction {
  const surrogate = new Transaction()
  for (let i = 0; i < covenant.vout; i++) surrogate.addOutput({ lockingScript: Script.fromHex(''), satoshis: 0 })
  surrogate.addOutput({ lockingScript: LockingScript.fromHex(covenant.scriptHex), satoshis: covenant.satoshis })
  return surrogate
}

/** Claim unlock: `<preimage> <secret> OP_1` (SIGHASH_SINGLE preimage over the spend). */
export function claimUnlockTemplate(covenantScript: Script, covenantSats: number, secret: number[]) {
  const estBytes = Math.ceil(covenantScript.toHex().length / 2) + secret.length + 220
  return {
    sign: async (tx: Transaction, inputIdx: number): Promise<UnlockingScript> => {
      // SIGHASH_SINGLE commits output[inputIdx]; the covenant forces output[0], so the covenant spend MUST sit at
      // input index 0. Hard-enforce it (review 3f290f83 LOW) — an external composer placing it elsewhere would
      // silently force the WRONG output.
      if (inputIdx !== 0) throw new Error('covenant claim must be input index 0 (SIGHASH_SINGLE forces output[0])')
      const { preimage } = calculatePreimage(tx, inputIdx, 'single', false, covenantSats, covenantScript)
      const u = new UnlockingScript()
      u.writeBin(preimage)
      u.writeBin(secret)
      u.writeOpCode(OP.OP_1) // select the IF (claim) branch
      return u
    },
    estimateLength: async (): Promise<number> => estBytes,
  }
}

/** Refund unlock: `<preimage> OP_0` (SIGHASH_SINGLE preimage over the spend). */
export function refundUnlockTemplate(covenantScript: Script, covenantSats: number) {
  const estBytes = Math.ceil(covenantScript.toHex().length / 2) + 210
  return {
    sign: async (tx: Transaction, inputIdx: number): Promise<UnlockingScript> => {
      // Same SIGHASH_SINGLE input-index-0 convention as the claim (review 3f290f83 LOW).
      if (inputIdx !== 0) throw new Error('covenant refund must be input index 0 (SIGHASH_SINGLE forces output[0])')
      const { preimage } = calculatePreimage(tx, inputIdx, 'single', false, covenantSats, covenantScript)
      const u = new UnlockingScript()
      u.writeBin(preimage)
      u.writeOpCode(OP.OP_0) // select the ELSE (refund) branch
      return u
    },
    estimateLength: async (): Promise<number> => estBytes,
  }
}

export interface CovenantClaimParams {
  covenant: CovenantUtxo
  /** The preimage `s` (raw bytes) — `SHA256(s)` must equal the covenant's `H`. */
  secret: number[]
  /** MUST equal the covenant's forced payout address. */
  payoutAddress: string
  /** MUST equal the covenant's forced payout sats. */
  payoutSats: number
  /** Where the leftover (the watchtower tip) goes — output[1], uncommitted. */
  tipAddress: string
  feeRate?: number
}

/**
 * Complete the swap: spend the covenant, forcing `payoutSats → payoutAddress` at
 * output[0], and sweep the remainder (minus fee) to `tipAddress` at output[1].
 * Permissionless — anyone holding `s` can broadcast this; the covenant guarantees
 * the recipient is paid.
 */
export async function buildCovenantClaimTx(p: CovenantClaimParams): Promise<Transaction> {
  const script = Script.fromHex(p.covenant.scriptHex)
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: p.covenant.txid,
    sourceOutputIndex: p.covenant.vout,
    sourceTransaction: makeCovenantPrevTx(p.covenant),
    unlockingScriptTemplate: claimUnlockTemplate(script, p.covenant.satoshis, p.secret),
    sequence: 0xffffffff,
  })
  // output[0] — the FORCED payout (fixed, covenant-committed). NOT a change output.
  tx.addOutput({ lockingScript: new P2PKH().lock(p.payoutAddress), satoshis: p.payoutSats })
  // output[1] — the watchtower tip (uncommitted under SIGHASH_SINGLE); soaks up the change.
  tx.addOutput({ lockingScript: new P2PKH().lock(p.tipAddress), change: true })
  await tx.fee(new SatoshisPerKilobyte(p.feeRate ?? 10))
  await tx.sign()
  return tx
}

/** An MM unlock template (the standard `new P2PKH().unlock(key)` shape) — supplied by the caller so this module stays
 *  key-agnostic (the covenant input needs no key; the fee-bump input does). */
export interface UnlockTemplate {
  sign(tx: Transaction, inputIndex: number): Promise<UnlockingScript>
  estimateLength(tx: Transaction, inputIndex: number): Promise<number>
}

/**
 * Optional fee-bump funding for a covenant refund. The committed refund fee (`covenantSats − refundSats`) is fixed at
 * lock time and cannot be raised later, so a fee spike beyond the sized headroom could strand the refund in the mempool
 * (red-team agent-3, 2026-09-01). Attaching an MM-owned UTXO as input[1] and a change output[1] lets the MM pay an
 * ARBITRARY higher fee at build/rebroadcast time — the strand defense. Both extras are invisible to the covenant: under
 * SIGHASH_SINGLE|FORKID it commits ONLY output[0], input[0]'s own sequence, and the tx nLockTime, so input[1]/output[1]
 * don't touch the forced-output, timelock, or non-final-sequence checks. The covenant stays at input[0]/output[0].
 */
export interface CovenantRefundFunding {
  /** An MM-owned UTXO added as input[1] to raise the total fee ABOVE the committed budget. */
  utxo: CovenantUtxo
  /** Unlock template for input[1] (the MM's key). Caller-supplied → this module stays key-agnostic. */
  unlockingScriptTemplate: UnlockTemplate
  /** Where the change (output[1]) returns — MM-owned; uncommitted under SIGHASH_SINGLE, so free to add. */
  changeAddress: string
  /** Target fee rate (sat/kB) for the whole bumped refund. */
  feeRate: number
}

export interface CovenantRefundParams {
  covenant: CovenantUtxo
  /** MUST equal the covenant's forced refund address. */
  refundAddress: string
  /** MUST equal the covenant's forced refund sats (fee = covenantSats − refundSats). */
  refundSats: number
  /** MUST be ≥ the covenant's refundLockHeight; also becomes the tx nLockTime. */
  refundLockHeight: number
  /** Optional MM UTXO + change to bump the fee above the committed budget (fee-spike strand defense). Omit for the
   *  plain output[0]-only refund (implicit fee = covenantSats − refundSats). */
  funding?: CovenantRefundFunding
}

/**
 * Reclaim an unfilled covenant to `refundAddress` after `refundLockHeight`.
 * Forces output[0] = {refundSats → refundAddress}; the covenant rejects any tx
 * with `nLockTime < refundLockHeight` or a final sequence, so it cannot confirm
 * early. Permissionless (no signature) — but only ever pays the funder.
 *
 * FEE BUMP (optional `p.funding`). Without it the fee is the committed budget
 * (covenantSats − refundSats), UN-bumpable. With it, an MM UTXO rides in as
 * input[1] and the surplus returns as change output[1], so the MM can pay an
 * arbitrary higher fee — the defense against a fee spike beyond the sized
 * headroom. The covenant is agnostic to both (SIGHASH_SINGLE commits only
 * output[0]); the forced refund at input[0]/output[0] is byte-identical either way.
 */
export async function buildCovenantRefundTx(p: CovenantRefundParams): Promise<Transaction> {
  if (p.refundSats >= p.covenant.satoshis) {
    throw new Error('refundSats must be < covenant sats (the difference is the miner fee)')
  }
  // Fail-closed on an out-of-domain nLockTime (red-team CRITICAL): the covenant only accepts a BLOCK-HEIGHT nLockTime
  // (< LOCKTIME_THRESHOLD); building one at/above it (a timestamp) would be rejected by the script anyway — refuse to
  // build an un-broadcastable refund. (A negative/zero height is nonsensical.)
  if (!Number.isInteger(p.refundLockHeight) || p.refundLockHeight < 1 || p.refundLockHeight >= LOCKTIME_THRESHOLD) {
    throw new Error(`buildCovenantRefundTx: refundLockHeight must be a block height in [1, ${LOCKTIME_THRESHOLD}) (got ${p.refundLockHeight})`)
  }
  const script = Script.fromHex(p.covenant.scriptHex)
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: p.covenant.txid,
    sourceOutputIndex: p.covenant.vout,
    sourceTransaction: makeCovenantPrevTx(p.covenant),
    unlockingScriptTemplate: refundUnlockTemplate(script, p.covenant.satoshis),
    sequence: REFUND_SEQUENCE, // non-final → consensus enforces nLockTime
  })
  // output[0] — the FORCED refund (fixed, covenant-committed). NOT a change output.
  tx.addOutput({ lockingScript: new P2PKH().lock(p.refundAddress), satoshis: p.refundSats })

  if (!p.funding) {
    // Plain path: fee = covenantSats − refundSats (implicit; no change output). UN-bumpable.
    tx.lockTime = p.refundLockHeight
    await tx.sign()
    return tx
  }

  // Fee-bump path: add the MM's input[1] + a change output[1] and size the whole tx to the target rate. The covenant
  // input[0]'s own sequence stays non-final (it is the only input that must be, so nLockTime is still enforced); the
  // fee-bump input can be final. The forced refund output[0] is untouched (fixed satoshis → tx.fee() never adjusts it).
  const f = p.funding
  if (!(f.feeRate > 0)) throw new Error(`buildCovenantRefundTx: funding.feeRate must be > 0 (got ${f.feeRate})`)
  if (f.utxo.txid === p.covenant.txid && f.utxo.vout === p.covenant.vout) {
    throw new Error('buildCovenantRefundTx: funding UTXO must differ from the covenant UTXO')
  }
  tx.addInput({
    sourceTXID: f.utxo.txid,
    sourceOutputIndex: f.utxo.vout,
    sourceTransaction: makeCovenantPrevTx(f.utxo),
    unlockingScriptTemplate: f.unlockingScriptTemplate,
    sequence: 0xffffffff, // final is fine — input[0] already carries the non-final sequence that enforces nLockTime
  })
  // output[1] — change back to the MM (uncommitted under SIGHASH_SINGLE). tx.fee() sizes it so fee ≈ feeRate × size.
  tx.addOutput({ lockingScript: new P2PKH().lock(f.changeAddress), change: true })
  tx.lockTime = p.refundLockHeight
  await tx.fee(new SatoshisPerKilobyte(f.feeRate))
  // Fail-closed if the funding UTXO was too small to cover the bumped fee (change collapsed below dust) — never
  // broadcast a refund whose change is a phantom/negative value.
  if ((tx.outputs[1]?.satoshis ?? 0) < 1) {
    throw new Error('buildCovenantRefundTx: funding UTXO too small to cover the bumped fee (change < 1 sat)')
  }
  await tx.sign()
  return tx
}

// ─── Secret helpers ──────────────────────────────────────────────────────────

/** SHA-256 hashlock of a secret, as 32-byte hex (matches the Base ERC20Swap). */
export function covenantHashlockOf(secret: number[]): string {
  return Utils.toHex(Hash.sha256(secret))
}

/** Fresh 32-byte secret + its SHA-256 hashlock. */
export function newCovenantSecret(): { secret: number[]; hashHex: string } {
  const secret = Random(32)
  return { secret, hashHex: covenantHashlockOf(secret) }
}

/**
 * Recover `s` from a broadcast covenant-CLAIM tx (the claim unlock is
 * `<preimage> <secret> OP_1`, so `s` is the second-from-top pushdata). Returns
 * null if the spend isn't a matching covenant claim. Verifies `SHA256(s)==H`.
 */
export function extractCovenantClaimSecret(
  claimTx: Transaction,
  covenantTxid: string,
  vout: number,
  hashHex: string,
): number[] | null {
  const input = claimTx.inputs.find((i) => i.sourceTXID === covenantTxid && i.sourceOutputIndex === vout)
  if (!input || !input.unlockingScript) return null
  const chunks = input.unlockingScript.chunks
  if (chunks.length < 3) return null
  const last = chunks[chunks.length - 1]
  if (last.op !== OP.OP_1) return null // must be the claim (IF) branch
  const secret = chunks[chunks.length - 2].data
  if (!secret) return null
  if (Utils.toHex(Hash.sha256(secret)) !== hashHex.toLowerCase()) return null
  return secret
}
