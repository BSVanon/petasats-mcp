import {
  BigNumber,
  Curve,
  ECDSA,
  Hash,
  OP,
  PublicKey,
  Script,
  Signature,
  TransactionSignature,
} from '@bsv/sdk'
/**
 * Magic keypair for the Push TX trick. Private key is the scalar 1, so the
 * public key equals the secp256k1 generator point G. Public knowledge — it
 * MUST NOT sign anything meant to be private; it exists only to derive Push TX
 * signatures that OP_CHECKSIG cross-references against the real spend sighash.
 */
const CURVE = new Curve()
const GENERATOR_X = CURVE.g.x
if (GENERATOR_X === null) throw new Error('unreachable: secp256k1 generator has a null x coordinate')
export const MAGIC_R: BigNumber = GENERATOR_X
export const CURVE_N: BigNumber = CURVE.n
export const MAGIC_PUBKEY: PublicKey = PublicKey.fromString(
  CURVE.g.encode(true, 'hex') as string,
)
/**
 * Default sighash flag for covenant spends: `SIGHASH_SINGLE | SIGHASH_FORKID
 * = 0x43`. Under BIP-143 SIGHASH_SINGLE, `hashOutputs` commits to ONLY
 * `output[inputIndex]` — by covenant convention output 0, the forced payout.
 * Other outputs (watchtower tip, change) are uncommitted and free.
 */
export const DEFAULT_COVENANT_SIGHASH =
  TransactionSignature.SIGHASH_SINGLE | TransactionSignature.SIGHASH_FORKID

/**
 * Floor(N/2). BIP-62 low-s threshold: strict-DER verifiers (incl. BSV's
 * Spend.validate) require `s <= N/2`. If the magic-keypair `s` lands in the
 * upper half we replace it with `N - s` (equivalent under ECDSA, canonical low-s).
 */
export const HALF_CURVE_N: BigNumber = CURVE_N.ushrn(1)

/**
 * Derive the Push TX signature for a preimage. Returns the (r,s) pair; use
 * `pushTxChecksigArg` for the DER || sighashType bytes OP_CHECKSIG pops.
 *
 * Low-s normalization: after `s = (sighash + r) mod N`, if `s > N/2` replace
 * with `N - s`. Without this ~50% of preimages produce high-s sigs that
 * strict-DER Spend.validate rejects — a real production footgun. The Script
 * emitter applies the same normalization after its OP_MOD so the two agree.
 */
export function derivePushTxSignature(preimageBytes: number[]): Signature {
  const sighash = new BigNumber(Hash.hash256(preimageBytes))
  let s = sighash.add(MAGIC_R).umod(CURVE_N)
  if (s.cmp(HALF_CURVE_N) > 0) {
    s = CURVE_N.sub(s)
  }
  return new Signature(MAGIC_R, s)
}

/** Concatenate DER(signature) || sighashType — the OP_CHECKSIG signature arg. */
export function pushTxChecksigArg(
  preimageBytes: number[],
  sighashType: number = DEFAULT_COVENANT_SIGHASH,
): number[] {
  const sig = derivePushTxSignature(preimageBytes)
  const der = sig.toDER() as number[]
  return [...der, sighashType & 0xff]
}

/**
 * Off-chain check that the Push TX signature for a preimage validates against
 * the magic pubkey using sighash = HASH256(preimage). This is the exact
 * invariant the in-Script logic reproduces.
 */
export function verifyPushTxSignature(preimageBytes: number[]): boolean {
  const sighash = new BigNumber(Hash.hash256(preimageBytes))
  const sig = derivePushTxSignature(preimageBytes)
  return ECDSA.verify(sighash, sig, MAGIC_PUBKEY)
}

/* ══════════════════════════════════════════════════════════════════════════
 *  Script-level BLOCK-1 helpers (emit opcodes equivalent to the TS math)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Encode a non-negative BigNumber as Bitcoin-Script bignum bytes (little-endian
 * sign-magnitude). Appends a trailing 0x00 iff the natural LE-magnitude high bit
 * is set (keeps it positive) — the layout OP_BIN2NUM produces and OP_ADD/OP_MOD
 * expect.
 */
export function encodeScriptBigNum(bn: BigNumber): number[] {
  if (bn.isZero()) return []
  if (bn.isNeg()) throw new Error('encodeScriptBigNum: negative values not supported')
  const be = bn.toArray('be') as number[]
  const le = be.slice().reverse()
  const msb = le[le.length - 1]
  if ((msb & 0x80) !== 0) le.push(0x00)
  return le
}

/**
 * Emit Script opcodes reversing the top `size` bytes in place. Implements
 * OP_REVERSEBYTES behavior manually since @bsv/sdk's interpreter maps 0xbc to
 * OP_NOP13. Each iteration peels the last byte off `rem` onto `acc`.
 * O(size) opcodes; callers must know the exact byte length in advance.
 */
export function buildBytesReverseScript(size: number): Script {
  if (size < 0) throw new Error('buildBytesReverseScript: size must be non-negative')
  const s = new Script()
  s.writeOpCode(OP.OP_0) // [..., bytes, empty]
  s.writeOpCode(OP.OP_SWAP) // [..., empty, bytes]

  for (let i = 0; i < size; i++) {
    s.writeOpCode(OP.OP_SIZE) // [acc, rem, rem.size]
    s.writeOpCode(OP.OP_1SUB) // [acc, rem, rem.size-1]
    s.writeOpCode(OP.OP_SPLIT) // [acc, rem_head, last_byte]
    s.writeOpCode(OP.OP_TOALTSTACK) // alt<-last_byte; [acc, rem_head]
    s.writeOpCode(OP.OP_SWAP) // [rem_head, acc]
    s.writeOpCode(OP.OP_FROMALTSTACK) // [rem_head, acc, last_byte]
    s.writeOpCode(OP.OP_CAT) // [rem_head, acc||last_byte]
    s.writeOpCode(OP.OP_SWAP) // [acc||last_byte, rem_head]
  }

  s.writeOpCode(OP.OP_DROP) // drop empty rem; [..., reversed_bytes]
  return s
}

/**
 * TS reference for DER-encoding the (MAGIC_R, s) pair the in-Script emitter must
 * reproduce: DER = 0x30 <len> 0x02 <r_len> <r_be> 0x02 <s_len> <s_be>. r is
 * constant (MAGIC_R BE starts 0x79, high bit clear → never needs the 0x00 prepend).
 */
export function derEncodeMagicSig(s: BigNumber): number[] {
  const rBE = MAGIC_R.toArray('be') as number[]
  const sBERaw = s.toArray('be') as number[]
  const sBE = (sBERaw[0] & 0x80) !== 0 ? [0x00, ...sBERaw] : sBERaw
  const rSection = [0x02, rBE.length, ...rBE]
  const sSection = [0x02, sBE.length, ...sBE]
  const body = [...rSection, ...sSection]
  return [0x30, body.length, ...body]
}

/**
 * Emit Script turning a Script bignum `s` (top of stack) into the DER signature
 * bytes matching `derEncodeMagicSig`. A canonical Script number's byte length is
 * already the correct DER length for that value; padding to 33 LE bytes,
 * reversing to BE, and stripping the leading padding yields exactly the minimal
 * BE magnitude DER expects — handles all s widths (1..33) with no MSB branch.
 */
export function buildDerEncodeMagicSigScript(): Script {
  const out = new Script()

  out.writeOpCode(OP.OP_SIZE) // [s, orig_size]
  out.writeOpCode(OP.OP_TOALTSTACK) // [s]; alt:[orig_size]

  out.writeBin([33])
  out.writeOpCode(OP.OP_NUM2BIN) // [s_le_33b]

  const rev = buildBytesReverseScript(33)
  for (const c of rev.chunks) out.chunks.push(c) // [s_be_33b]

  out.writeOpCode(OP.OP_FROMALTSTACK) // [s_be_33b, orig_size]
  out.writeBin([33])
  out.writeOpCode(OP.OP_SWAP) // [s_be_33b, 33, orig_size]
  out.writeOpCode(OP.OP_SUB) // [s_be_33b, leading]
  out.writeOpCode(OP.OP_SPLIT) // [leading_bytes, minimal_be]
  out.writeOpCode(OP.OP_NIP) // [minimal_be]

  // 0x02 <len> <bytes>. OP_N used for small pushes (BIP-62 minimal-push standardness).
  out.writeOpCode(OP.OP_SIZE) // [minimal_be, len]
  out.writeOpCode(OP.OP_1)
  out.writeOpCode(OP.OP_NUM2BIN) // [minimal_be, len_1B]
  out.writeOpCode(OP.OP_2)
  out.writeOpCode(OP.OP_SWAP)
  out.writeOpCode(OP.OP_CAT) // [minimal_be, 0x02||len_1B]
  out.writeOpCode(OP.OP_SWAP)
  out.writeOpCode(OP.OP_CAT) // [0x02||len_1B||minimal_be] = s_section

  const rBE = MAGIC_R.toArray('be') as number[]
  const rSection = [0x02, rBE.length, ...rBE] // 34 bytes
  out.writeBin(rSection)
  out.writeOpCode(OP.OP_SWAP)
  out.writeOpCode(OP.OP_CAT) // [r_section || s_section]

  out.writeOpCode(OP.OP_SIZE) // [body, size]
  out.writeOpCode(OP.OP_1)
  out.writeOpCode(OP.OP_NUM2BIN) // [body, size_1B]
  out.writeBin([0x30])
  out.writeOpCode(OP.OP_SWAP)
  out.writeOpCode(OP.OP_CAT) // [body, 0x30||size]
  out.writeOpCode(OP.OP_SWAP)
  out.writeOpCode(OP.OP_CAT) // [DER]

  return out
}

/**
 * Emit the modular-add: [preimage] → [preimage, s] where s = (sighash + MAGIC_R)
 * mod CURVE_N, low-s normalized. Leaves the preimage intact beneath s so
 * downstream covenant logic can parse it.
 */
export function buildPushTxModularAddScript(): Script {
  const s = new Script()
  s.writeOpCode(OP.OP_DUP)
  s.writeOpCode(OP.OP_HASH256)

  const rev = buildBytesReverseScript(32)
  for (const chunk of rev.chunks) s.chunks.push(chunk)

  s.writeBin([0x00]) // keep LE-signed interpretation positive
  s.writeOpCode(OP.OP_CAT)
  s.writeOpCode(OP.OP_BIN2NUM)

  s.writeBin(encodeScriptBigNum(MAGIC_R))
  s.writeOpCode(OP.OP_ADD)

  s.writeBin(encodeScriptBigNum(CURVE_N))
  s.writeOpCode(OP.OP_MOD)

  // Low-s (BIP-62): if s > N/2, replace with N - s.
  s.writeOpCode(OP.OP_DUP) // [preimage, s, s]
  s.writeBin(encodeScriptBigNum(HALF_CURVE_N)) // [preimage, s, s, halfN]
  s.writeOpCode(OP.OP_GREATERTHAN) // [preimage, s, s>halfN]
  s.writeOpCode(OP.OP_IF)
  s.writeBin(encodeScriptBigNum(CURVE_N)) // [preimage, s, N]
  s.writeOpCode(OP.OP_SWAP) // [preimage, N, s]
  s.writeOpCode(OP.OP_SUB) // [preimage, N-s]
  s.writeOpCode(OP.OP_ENDIF)

  return s
}

/**
 * Emit the complete BLOCK-1 preimage-authentication sequence.
 *
 *   Stack in:  [preimage]
 *   Stack out: [preimage]   (unchanged on success; OP_CHECKSIGVERIFY aborts otherwise)
 *
 * Chains modular-add (derive s) → DER encode → append sighashType byte → push
 * MAGIC_PUBKEY → OP_CHECKSIGVERIFY. On success the preimage remains on the stack,
 * now proven to equal the real spend preimage for `sighashType`.
 *
 * The caller's locking script body starts with this; the unlocking script pushes
 * `<preimage>`. `sighashType` must match the scope the spender's preimage is
 * computed under (default SIGHASH_SINGLE|FORKID → commits output[inputIndex]).
 */
export function buildPushTxVerifyScript(
  sighashType: number = DEFAULT_COVENANT_SIGHASH,
): Script {
  const out = new Script()

  const modAdd = buildPushTxModularAddScript()
  for (const c of modAdd.chunks) out.chunks.push(c) // [preimage, s]

  const der = buildDerEncodeMagicSigScript()
  for (const c of der.chunks) out.chunks.push(c) // [preimage, DER]

  out.writeBin([sighashType & 0xff])
  out.writeOpCode(OP.OP_CAT) // [preimage, DER||sighashType]

  const pubKeyHex = MAGIC_PUBKEY.toString()
  const pubKeyBytes: number[] = []
  for (let i = 0; i < pubKeyHex.length; i += 2) {
    pubKeyBytes.push(parseInt(pubKeyHex.substr(i, 2), 16))
  }
  out.writeBin(pubKeyBytes) // [preimage, sig, pubkey]

  out.writeOpCode(OP.OP_CHECKSIGVERIFY) // asserts; on success stack back to [preimage]

  return out
}
