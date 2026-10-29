import { Beef, P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction, Utils } from '@bsv/sdk'
import type { WocUtxo } from '../../../wallet/reserve-basket-sweep'
import { assertBuyerMainnetP2pkhAddress } from './address'

/** The existing consolidation sweep's dust floor. */
export const BUYER_SWEEP_DUST_SATS = 546

export interface BuyerSweepCoin extends WocUtxo {
  /** Required parent transaction: it supplies the signing value and Atomic BEEF ancestry. */
  sourceTx: Transaction
  /** Confirmation count from the caller's corroborated height/read rails. */
  confirmations: number
}

export interface BuildSweepTxOptions {
  coins: BuyerSweepCoin[]
  toAddress: string
  key: PrivateKey
  /** satoshis per kilobyte */
  feeRate: number
}

export interface BuiltBuyerSweep {
  rawTx: string
  atomicBeefHex: string
  tx: Transaction
  fee: number
  outputSatoshis: number
}

/** Build one signed P2PKH output from exactly the caller-specified coins. */
export async function buildSweepTx(opts: BuildSweepTxOptions): Promise<BuiltBuyerSweep> {
  if (!opts.coins.length) throw new Error('buyer sweep: no coins')
  if (!Number.isFinite(opts.feeRate) || opts.feeRate <= 0) throw new Error('buyer sweep: feeRate must be positive')
  try { assertBuyerMainnetP2pkhAddress(opts.toAddress, 'buyer sweep: toAddress') } catch {
    throw new Error('buyer sweep: toAddress is not a valid BSV P2PKH mainnet Base58Check address')
  }
  const tx = new Transaction()
  const seen = new Set<string>()
  const kitLockHex = new P2PKH().lock(opts.key.toPublicKey().toAddress()).toHex()
  let total = 0
  for (const coin of opts.coins) {
    const id = `${coin.tx_hash}.${coin.tx_pos}`
    if (seen.has(id)) throw new Error(`buyer sweep: duplicate coin ${id}`)
    seen.add(id)
    if (!Number.isSafeInteger(coin.confirmations) || coin.confirmations < 1) {
      throw new Error(`buyer sweep: coin ${id} has fewer than 1 confirmation`)
    }
    if (coin.sourceTx.id('hex').toLowerCase() !== coin.tx_hash.toLowerCase()) throw new Error(`buyer sweep: source transaction mismatch for ${id}`)
    const output = coin.sourceTx.outputs[coin.tx_pos]
    if (!output || output.satoshis !== coin.value) throw new Error(`buyer sweep: source output mismatch for ${id}`)
    if (output.lockingScript.toHex() !== kitLockHex) throw new Error(`buyer sweep: source output is not a kit P2PKH coin for ${id}`)
    tx.addInput({ sourceTransaction: coin.sourceTx, sourceOutputIndex: coin.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(opts.key, 'all', false) })
    total += coin.value
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(opts.toAddress), change: true })
  await tx.fee(new SatoshisPerKilobyte(opts.feeRate))
  await tx.sign()
  const outputSatoshis = tx.outputs[0]?.satoshis ?? 0
  const fee = total - outputSatoshis
  if (outputSatoshis <= BUYER_SWEEP_DUST_SATS) throw new Error(`buyer sweep: output ${outputSatoshis} sat is at or below dust (${BUYER_SWEEP_DUST_SATS})`)
  if (tx.inputs.length !== opts.coins.length || tx.outputs.length !== 1 || fee <= 0) throw new Error('buyer sweep: invalid exact-input single-output transaction')
  const txid = tx.id('hex') as string
  const beef = Beef.fromBinary(tx.toBEEF())
  return { rawTx: tx.toHex(), atomicBeefHex: Utils.toHex(beef.toBinaryAtomic(txid)), tx, fee, outputSatoshis }
}
