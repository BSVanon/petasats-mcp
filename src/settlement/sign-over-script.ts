import { Hash, PrivateKey, Script, Transaction, TransactionSignature } from '@bsv/sdk'
import { calculatePreimage } from '@bsv/wallet-helper'

/** The canonical BSV half-signer over an arbitrary prevout script (SIGHASH_ALL|FORKID). */
export function signOverScript(pk: PrivateKey, tx: Transaction, inputIdx: number, htlcScript: Script, htlcSats: number): number[] {
  const { preimage, signatureScope } = calculatePreimage(tx, inputIdx, 'all', false, htlcSats, htlcScript)
  // Sign SINGLE sha256(preimage): PrivateKey.sign hashes once more internally, so
  // this is ECDSA over hash256(preimage) = the Bitcoin sighash (matches @bsv/sdk
  // P2PKH). NB: hash256(preimage) here would triple-hash — the latent bug in
  // ordlock/cancel.ts, which was never execution-tested.
  const rawSig = pk.sign(Hash.sha256(preimage))
  return new TransactionSignature(rawSig.r, rawSig.s, signatureScope).toChecksigFormat()
}
