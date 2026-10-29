import {
  Hash,
  LockingScript,
  OP,
  P2PKH,
  PrivateKey,
  PublicKey,
  Random,
  SatoshisPerKilobyte,
  Script,
  Spend,
  Transaction,
  UnlockingScript,
  Utils,
} from '@bsv/sdk'
import { signOverScript } from '../sign-over-script'
export { signOverScript }
/** CLTV values ≥ this are interpreted as Unix timestamps, not block heights. */
export const CLTV_TIMESTAMP_THRESHOLD = 500_000_000

const HEX32 = /^[0-9a-fA-F]{64}$/

// ─── The HTLC UTXO being spent ───────────────────────────────────────

export interface BsvHtlcUtxo {
  txid: string
  vout: number
  satoshis: number
  /** The HTLC locking script hex (from buildBsvHtlcScript). */
  scriptHex: string
}

// ─── Build the lock script ───────────────────────────────────────────

export interface BuildBsvHtlcParams {
  /** `H = SHA256(s)` as 32-byte hex — the hashlock (SHA-256, matches Base). */
  hashHex: string
  /** Pubkey that can claim by revealing `s` (unilateral, via the hashlock). */
  claimPubKey: PublicKey
  /**
   * The refund is a 2-of-2 of these two keys — NOT an in-script `OP_CLTV` gate.
   * Post-Genesis BSV treats `OP_CHECKLOCKTIMEVERIFY` as a non-standard NOP (won't
   * relay), so the timeout is enforced on the REFUND TX (`nLockTime` + non-final
   * `nSequence`) and made safe by the counterparty pre-signing ONLY the agreed
   * `nLockTime` version (`SIGHASH_ALL` commits to it). Canonical BSV pattern
   * (cto-bsv V-01 / P2.5 co-signed nLockTime refund). `A` conventionally = the
   * claimer/initiator (pre-signs), `B` = the responder (co-signs + receives).
   */
  refundPubKeyA: PublicKey
  refundPubKeyB: PublicKey
}

export function buildBsvHtlcScript(p: BuildBsvHtlcParams): LockingScript {
  if (!HEX32.test(p.hashHex)) throw new Error('buildBsvHtlcScript: hashHex must be 32-byte hex')
  const hash = Utils.toArray(p.hashHex, 'hex') as number[]
  const claimPk = p.claimPubKey.encode(true) as number[]
  const refundPkA = p.refundPubKeyA.encode(true) as number[]
  const refundPkB = p.refundPubKeyB.encode(true) as number[]

  const s = new Script()
  s.writeOpCode(OP.OP_IF) // claim branch: reveal s (unilateral)
  s.writeOpCode(OP.OP_SHA256)
  s.writeBin(hash)
  s.writeOpCode(OP.OP_EQUALVERIFY)
  s.writeBin(claimPk)
  s.writeOpCode(OP.OP_CHECKSIG)
  s.writeOpCode(OP.OP_ELSE) // refund branch: 2-of-2 {A,B} (timeout on the spending tx)
  s.writeOpCode(OP.OP_2)
  s.writeBin(refundPkA)
  s.writeBin(refundPkB)
  s.writeOpCode(OP.OP_2)
  s.writeOpCode(OP.OP_CHECKMULTISIG)
  s.writeOpCode(OP.OP_ENDIF)
  return LockingScript.fromHex(s.toHex())
}

// ─── Parse (verify a discovered lock matches expectations) ───────────

export interface ParsedBsvHtlc {
  hashHex: string
  claimPubKeyHex: string
  refundPubKeyAHex: string
  refundPubKeyBHex: string
}

/** Parse a BSV HTLC lock script, or null if it isn't the canonical shape. */
export function parseBsvHtlcScript(script: Script | string): ParsedBsvHtlc | null {
  const s = typeof script === 'string' ? Script.fromHex(script) : script
  const c = s.chunks
  // OP_IF OP_SHA256 <H> OP_EQUALVERIFY <claim> OP_CHECKSIG OP_ELSE OP_2 <A> <B> OP_2 OP_CHECKMULTISIG OP_ENDIF
  if (c.length !== 13) return null
  const op = (i: number): number | undefined => c[i].op
  const data = (i: number): number[] | undefined => c[i].data
  if (op(0) !== OP.OP_IF || op(1) !== OP.OP_SHA256) return null
  if ((data(2)?.length ?? 0) !== 32) return null
  if (op(3) !== OP.OP_EQUALVERIFY || (data(4)?.length ?? 0) !== 33 || op(5) !== OP.OP_CHECKSIG) return null
  if (op(6) !== OP.OP_ELSE || op(7) !== OP.OP_2) return null
  if ((data(8)?.length ?? 0) !== 33 || (data(9)?.length ?? 0) !== 33) return null
  if (op(10) !== OP.OP_2 || op(11) !== OP.OP_CHECKMULTISIG || op(12) !== OP.OP_ENDIF) return null
  return {
    hashHex: Utils.toHex(data(2) as number[]),
    claimPubKeyHex: Utils.toHex(data(4) as number[]),
    refundPubKeyAHex: Utils.toHex(data(8) as number[]),
    refundPubKeyBHex: Utils.toHex(data(9) as number[]),
  }
}

// ─── Unlock templates ────────────────────────────────────────────────

/** Claim branch: `<sig> <secret> OP_1`. */
function claimUnlockTemplate(htlcScript: Script, htlcSats: number, claimPk: PrivateKey, secret: number[]) {
  return {
    sign: async (tx: Transaction, inputIdx: number): Promise<UnlockingScript> => {
      const u = new UnlockingScript()
      u.writeBin(signOverScript(claimPk, tx, inputIdx, htlcScript, htlcSats))
      u.writeBin(secret)
      u.writeOpCode(OP.OP_1) // select the IF (claim) branch
      return u
    },
    estimateLength: async (): Promise<number> => 73 + secret.length + 8,
  }
}

/**
 * Refund branch length surrogate — `OP_0 <sigA> <sigB> OP_0` sized for the fee calc, WITHOUT keys.
 * The skeleton is never `tx.sign()`ed (the two halves are attached by `combineHtlcRefund`), so
 * `sign` is a guard. Its `estimateLength` MUST match the real unlock so the fee — and thus the
 * SIGHASH_ALL sighash both parties commit to — is identical whether built single-process or M2M.
 */
function refund2of2LengthTemplate() {
  return {
    sign: async (): Promise<UnlockingScript> => {
      throw new Error('refund skeleton is unsigned — sign each half with signHtlcRefundHalf, then combineHtlcRefund')
    },
    estimateLength: async (): Promise<number> => 1 + 73 + 73 + 1,
  }
}

// ─── Source-tx surrogate (mirrors ordlock/atomic) ────────────────────

function makePrevTxSurrogate(vout: number, scriptHex: string, satoshis: number): Transaction {
  const surrogate = new Transaction()
  for (let i = 0; i < vout; i++) surrogate.addOutput({ lockingScript: Script.fromHex(''), satoshis: 0 })
  surrogate.addOutput({ lockingScript: LockingScript.fromHex(scriptHex), satoshis })
  return surrogate
}

// ─── Spend paths ─────────────────────────────────────────────────────

export interface HtlcClaimParams {
  htlc: BsvHtlcUtxo
  /** The preimage `s` (raw bytes) — `SHA256(s)` must equal the lock's `H`. */
  secret: number[]
  claimPk: PrivateKey
  /** Where the claimed BSV goes. */
  toAddress: string
  feeRate?: number
}

/** Claim the HTLC by revealing `s`. The revealed `s` becomes public on-chain — the
 *  counterparty reads it to claim the OTHER leg (the cross-chain link). */
export async function buildHtlcClaimTx(p: HtlcClaimParams): Promise<Transaction> {
  const script = Script.fromHex(p.htlc.scriptHex)
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: p.htlc.txid,
    sourceOutputIndex: p.htlc.vout,
    sourceTransaction: makePrevTxSurrogate(p.htlc.vout, p.htlc.scriptHex, p.htlc.satoshis),
    unlockingScriptTemplate: claimUnlockTemplate(script, p.htlc.satoshis, p.claimPk, p.secret),
    sequence: 0xffffffff,
  })
  tx.addOutput({ lockingScript: new P2PKH().lock(p.toAddress), change: true })
  await tx.fee(new SatoshisPerKilobyte(p.feeRate ?? 10))
  await tx.sign()
  return tx
}

export interface HtlcRefundParams {
  htlc: BsvHtlcUtxo
  /** The two refund keys (2-of-2), in the script's pubkey order (A then B). */
  refundPkA: PrivateKey
  refundPkB: PrivateKey
  /**
   * The refund tx `nLockTime` — canonically a BSV BLOCK HEIGHT (< 5e8), the proven
   * P2.5 pattern; a timestamp (≥ 5e8, MTP-gated) also works. Consensus refuses the tx
   * (non-final `nSequence`) until this is reached.
   */
  refundLocktime: number
  toAddress: string
  feeRate?: number
}

/** Refund the HTLC after its timelock: a 2-of-2 spend of the ELSE branch with
 *  `nLockTime` + non-final `nSequence`. Both keys sign the same `SIGHASH_ALL` sighash
 *  (which commits to the nLockTime/sequence/output), so the timeout can't be shortened
 *  nor the payout redirected. Single-process convenience — implemented ON TOP of the M2M
 *  split (skeleton → half A → half B → combine); the on-chain tx is byte-identical. */
export async function buildHtlcRefundTx(p: HtlcRefundParams): Promise<Transaction> {
  const skeleton = await buildHtlcRefundSkeleton({ htlc: p.htlc, toAddress: p.toAddress, refundLocktime: p.refundLocktime, feeRate: p.feeRate })
  const sigA = signHtlcRefundHalf({ skeleton, pk: p.refundPkA, htlcScriptHex: p.htlc.scriptHex, htlcSats: p.htlc.satoshis })
  const sigB = signHtlcRefundHalf({ skeleton, pk: p.refundPkB, htlcScriptHex: p.htlc.scriptHex, htlcSats: p.htlc.satoshis })
  return combineHtlcRefund({ skeleton, sigA, sigB, htlcScriptHex: p.htlc.scriptHex, htlcSats: p.htlc.satoshis })
}

// ─── M2M refund pre-sign / co-sign split (§13; pre-dist #4) ───────────

// agents holding only their own key, so the refund can't be signed in one process. The split: one
// side builds the deterministic SKELETON (from the lock txid, known before broadcast), each side
// VERIFIES it recovers correctly + signs ITS half over the identical SIGHASH_ALL sighash, and the two

export interface RefundSkeletonParams {
  htlc: BsvHtlcUtxo
  toAddress: string
  refundLocktime: number
  feeRate?: number
}

/**
 * Build the UNSIGNED 2-of-2 refund skeleton — the deterministic tx both parties sign independently.
 * No keys. Once this returns, the SIGHASH_ALL sighash is fixed (input outpoint, nLockTime, non-final
 * sequence, payout + fee), so `sigA` and `sigB` commit to exactly the same thing. Attaching the
 * unlock later doesn't change the sighash (unlocking scripts are never part of it).
 */
export async function buildHtlcRefundSkeleton(p: RefundSkeletonParams): Promise<Transaction> {
  const tx = new Transaction()
  tx.lockTime = p.refundLocktime
  tx.addInput({
    sourceTXID: p.htlc.txid,
    sourceOutputIndex: p.htlc.vout,
    sourceTransaction: makePrevTxSurrogate(p.htlc.vout, p.htlc.scriptHex, p.htlc.satoshis),
    unlockingScriptTemplate: refund2of2LengthTemplate(), // length-only; not signed here
    sequence: 0xfffffffe, // non-final — so nLockTime is enforced by consensus
  })
  tx.addOutput({ lockingScript: new P2PKH().lock(p.toAddress), change: true })
  await tx.fee(new SatoshisPerKilobyte(p.feeRate ?? 10))
  return tx
}

export interface RefundHalfParams {
  skeleton: Transaction
  /** This party's refund key. Sign only after `assertRefundSkeletonRecovers` passes. */
  pk: PrivateKey
  htlcScriptHex: string
  htlcSats: number
}

/** One party's half of the 2-of-2 refund — its `SIGHASH_ALL|FORKID` signature over the skeleton. */
export function signHtlcRefundHalf(p: RefundHalfParams): number[] {
  return signOverScript(p.pk, p.skeleton, 0, Script.fromHex(p.htlcScriptHex), p.htlcSats)
}

/**
 * Combine the two halves (in pubkey order A,B) into the finished 2-of-2 refund tx — and VALIDATE it
 * (review b908cca5 HIGH). A wrong / truncated / stale / swapped half yields a shape-valid but
 * UNSPENDABLE refund; returning it unchecked would let a party lock BSV against an exit that can't be
 * broadcast. So combine runs the execution proof (`assertCombinedHtlcRefundValid`) and THROWS unless
 * the fully-combined tx actually satisfies the HTLC's 2-of-2 ELSE branch. Requires the HTLC
 * script + sats to validate against.
 */
export function combineHtlcRefund(p: { skeleton: Transaction; sigA: number[]; sigB: number[]; htlcScriptHex: string; htlcSats: number }): Transaction {
  const u = new UnlockingScript()
  u.writeOpCode(OP.OP_0) // OP_CHECKMULTISIG dummy element
  u.writeBin(p.sigA) // A = machine
  u.writeBin(p.sigB) 
  u.writeOpCode(OP.OP_0) // select the ELSE (refund) branch
  p.skeleton.inputs[0].unlockingScript = u
  assertCombinedHtlcRefundValid(p.skeleton, p.htlcScriptHex, p.htlcSats)
  return p.skeleton
}

export function assertCombinedHtlcRefundValid(refundTx: Transaction, htlcScriptHex: string, htlcSats: number): void {
  const input = refundTx.inputs[0]
  if (!input || !input.unlockingScript) throw new Error('combined refund: input 0 has no unlocking script')
  // Value conservation (review 8de9fe5d HIGH): Spend.validate does NOT check outputs ≤ inputs, so an
  // overspending refund is script-valid but a node rejects it. Enforce it here too (last gate).
  const totalOut = refundTx.outputs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0)
  if (totalOut > htlcSats) throw new Error(`combined refund: outputs ${totalOut} EXCEED input ${htlcSats} — overspend, a node would reject it`)
  let ok = false
  try {
    ok = new Spend({
      sourceTXID: input.sourceTXID as string,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: htlcSats,
      lockingScript: LockingScript.fromHex(htlcScriptHex),
      transactionVersion: refundTx.version,
      otherInputs: refundTx.inputs.filter((_, i) => i !== 0),
      outputs: refundTx.outputs,
      inputIndex: 0,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: refundTx.lockTime,
    }).validate()
  } catch {
    ok = false
  }
  if (!ok) throw new Error('combined refund is NOT Spend-valid — a half-signature is wrong/stale/truncated/mis-ordered; DO NOT lock against it')
}

/**
 * The SELF-CONTAINED validator for a persisted / deserialized refund artifact (review 8de9fe5d MED):
 * runs the FULL semantic recovery contract (`assertRefundSkeletonRecovers` — outpoint, address,
 * locktime, non-final sequence, no stray output, value conservation, min recovery) AND the execution
 * proof (`assertCombinedHtlcRefundValid` — the 2-of-2 actually spends). A restart / role-split caller
 * MUST use THIS on a persisted refund before any BSV lock — `assertCombinedHtlcRefundValid` alone
 * proves script + value but NOT the semantic contract.
 */
export function assertRefundArtifactValid(refundTx: Transaction, p: Omit<AssertRefundRecoversParams, 'skeleton'>): void {
  assertRefundSkeletonRecovers({ ...p, skeleton: refundTx })
  assertCombinedHtlcRefundValid(refundTx, p.htlc.scriptHex, p.htlc.satoshis)
}

/**
 * Parse + fully validate a PERSISTED refund HEX against its HTLC — the broadcast-side last gate
 * (review 6c56a3c7): every reclaim/broadcast path (drill `reclaim-bsv`, the watchtower `refundBsv`
 * adapter) MUST run this on the stored `bsvRefundTxHex` immediately before broadcasting, so a
 * corrupted / imported / stale artifact can never spend. Throws on a non-decodable hex or any
 * contract/value/execution violation.
 */
export function assertRefundHexValid(refundTxHex: string, p: Omit<AssertRefundRecoversParams, 'skeleton'>): void {
  let tx: Transaction
  try {
    tx = Transaction.fromHex(refundTxHex)
  } catch {
    throw new Error('refund artifact: not a decodable transaction')
  }
  assertRefundArtifactValid(tx, p)
}

export interface AssertRefundRecoversParams {
  skeleton: Transaction
  htlc: BsvHtlcUtxo
  toAddress: string
  refundLocktime: number
  /** The minimum sats the refund must return to `toAddress` (amount − a bounded fee). */
  minRefundSats: number
}

/**
 * The semantic check a party runs BEFORE signing (money-critical): the skeleton actually recovers
 * the HTLC to the agreed address at the agreed timelock, spending EXACTLY the HTLC outpoint, with a
 * non-final sequence. Throws otherwise — so a party never co-signs a tx that redirects the payout,
 * shortens the timeout, or spends the wrong input.
 */
export function assertRefundSkeletonRecovers(p: AssertRefundRecoversParams): void {
  const tx = p.skeleton
  if (tx.inputs.length !== 1) throw new Error('refund skeleton: must spend exactly the HTLC (one input)')
  const inp = tx.inputs[0]
  if (inp.sourceTXID !== p.htlc.txid || inp.sourceOutputIndex !== p.htlc.vout) {
    throw new Error('refund skeleton: input is not the agreed HTLC outpoint')
  }
  if (tx.lockTime !== p.refundLocktime) throw new Error(`refund skeleton: nLockTime ${tx.lockTime} != agreed ${p.refundLocktime}`)
  if ((inp.sequence ?? 0xffffffff) >= 0xffffffff) throw new Error('refund skeleton: sequence must be non-final so nLockTime is enforced')
  const toScript = new P2PKH().lock(p.toAddress).toHex()
  // Reject value-siphon (review b908cca5 MEDIUM): EVERY output must pay the refund address — a
  // hostile skeleton must not slip a stranger/dust output that drains the input via the fee budget.
  const stray = tx.outputs.find((o) => o.lockingScript.toHex() !== toScript)
  if (stray) throw new Error(`refund skeleton: output pays a non-refund address (${(stray.satoshis ?? 0)} sat) — value siphon`)
  // Value conservation (review 8de9fe5d HIGH): Spend.validate proves the SCRIPT runs but NOT that
  // outputs ≤ inputs — an OVERSPENDING refund passes execution yet a real node rejects it, leaving
  
  for (const o of tx.outputs) {
    if (!Number.isSafeInteger(o.satoshis ?? NaN) || (o.satoshis ?? -1) < 0) {
      throw new Error(`refund skeleton: output satoshis ${o.satoshis} is not a sane non-negative integer`)
    }
  }
  const paid = tx.outputs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0)
  if (paid > p.htlc.satoshis) throw new Error(`refund skeleton: outputs ${paid} EXCEED the HTLC input ${p.htlc.satoshis} — overspend, a node would reject it`)
  if (paid < p.minRefundSats) throw new Error(`refund skeleton: pays ${paid} to the refund address, below the ${p.minRefundSats} minimum`)
}

/** Convenience: `H = SHA256(secret)` as hex, for building the lock from a chosen secret. */
export function hashlockOf(secret: number[]): string {
  return Utils.toHex(Hash.sha256(secret))
}

/**
 * A FRESH swap secret + its hashlock. The INITIATOR generates this per swap from a
 * CSPRNG and keeps `secret` private until it reveals by claiming. NEVER derive `s`
 * deterministically from public data (e.g. an address): `s` is published on-chain at
 * claim time, so a predictable or reused `s` lets the claim-side take the initiator's
 * locked funds WITHOUT performing their own leg (the hashlock stops protecting once
 * `s` is known). One fresh 32-byte `s` per swap ⇒ a unique `H` per swap.
 */
/**
 * Extract + VERIFY the preimage `s` from an HTLC CLAIM tx that spends `lockTxid:vout`. TRUSTLESS: it
 * reads `s` straight off whatever tx spent the outpoint and checks `SHA256(s) === H`, so it works
 * regardless of the claim's payout address (the claim branch does NOT constrain it) and regardless of
 * any off-chain message. Returns null if the tx doesn't spend that outpoint, isn't a claim-branch
 * unlock, or the preimage doesn't hash to H (review 3e96bb3a HIGH — the address-scan watcher was
 * spoofable; the counterparty can claim to any address + withhold the pointer). The claim-branch
 * unlock is `[sig, s, OP_1]`, so `s` is the second pushdata.
 */
export function extractHtlcClaimSecret(claimTx: Transaction, lockTxid: string, vout: number, hashHex: string): number[] | null {
  const inp = claimTx.inputs.find((i) => i.sourceTXID === lockTxid && i.sourceOutputIndex === vout)
  const want = hashHex.toLowerCase().replace(/^0x/, '')
  
  // The TAKER builds the claim tx, and post-Genesis BSV does not enforce CLEANSTACK on a version-2 spend, so a taker
  // can prepend/reorder pushes (e.g. [junk, sig, secret, OP_1]) that shift the secret off index 1 — making a
  
  // FORFEITS the USDC while the taker keeps both legs. A money-critical classifier must find the value that hashes to
  // H wherever the taker put it, not assume the script layout.
  for (const chunk of inp?.unlockingScript?.chunks ?? []) {
    const d = chunk?.data as number[] | undefined
    if (d && d.length === 32 && Utils.toHex(Hash.sha256(d)) === want) return d
  }
  return null
}

export function newHtlcSecret(): { secret: number[]; hashHex: string } {
  const secret = Random(32) // CSPRNG (32 bytes)
  return { secret, hashHex: hashlockOf(secret) }
}

// ─── Lock (fund the HTLC) ────────────────────────────────────────────

export interface HtlcLockParams {
  
  funding: BsvHtlcUtxo
  fundingPk: PrivateKey
  /** The HTLC lock script (from buildBsvHtlcScript). */
  htlcScriptHex: string
  /** BSV to lock in the HTLC output. */
  amountSats: number
  changeAddress: string
  feeRate?: number
}

export async function buildHtlcLockTx(p: HtlcLockParams): Promise<Transaction> {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: p.funding.txid,
    sourceOutputIndex: p.funding.vout,
    sourceTransaction: makePrevTxSurrogate(p.funding.vout, p.funding.scriptHex, p.funding.satoshis),
    unlockingScriptTemplate: new P2PKH().unlock(p.fundingPk),
    sequence: 0xffffffff,
  })
  tx.addOutput({ lockingScript: LockingScript.fromHex(p.htlcScriptHex), satoshis: p.amountSats }) // out0 = HTLC
  tx.addOutput({ lockingScript: new P2PKH().lock(p.changeAddress), change: true }) // out1 = change
  await tx.fee(new SatoshisPerKilobyte(p.feeRate ?? 10))
  await tx.sign()
  return tx
}