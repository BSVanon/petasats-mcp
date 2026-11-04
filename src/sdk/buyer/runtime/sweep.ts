import { Beef, P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction, Utils, type ChainTracker } from '@bsv/sdk'
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

export interface BuildEarlySweepTxOptions {
  claim: Transaction
  claimTxid: string
  toAddress: string
  key: PrivateKey
  feeRate: number
  chainTracker: ChainTracker
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

/** Build a child of the persisted claim, retaining its merkle-proven lock ancestor in Atomic BEEF. */
export async function buildEarlySweepTx(opts: BuildEarlySweepTxOptions): Promise<BuiltBuyerSweep> {
  if (opts.claim.id('hex').toLowerCase() !== opts.claimTxid.toLowerCase()) throw new Error('buyer early sweep: claim transaction mismatch')
  if (!Number.isFinite(opts.feeRate) || opts.feeRate <= 0) throw new Error('buyer early sweep: feeRate must be positive')
  try { assertBuyerMainnetP2pkhAddress(opts.toAddress, 'buyer early sweep: toAddress') } catch {
    throw new Error('buyer early sweep: toAddress is not a valid BSV P2PKH mainnet Base58Check address')
  }
  const lock = opts.claim.inputs[0]?.sourceTransaction
  if (!lock?.merklePath) throw new Error('buyer early sweep: claim lock has no merkle proof')
  let lockProven = false
  try { lockProven = await lock.merklePath.verify(lock.id('hex'), opts.chainTracker) } catch { /* fail closed below */ }
  if (!lockProven) throw new Error('buyer early sweep: claim lock merkle proof failed')
  const kitLockHex = new P2PKH().lock(opts.key.toPublicKey().toAddress()).toHex()
  const coins = opts.claim.outputs.flatMap((output, index) => output.lockingScript.toHex() === kitLockHex ? [{ output, index }] : [])
  if (!coins.length) throw new Error('buyer early sweep: claim has no kit P2PKH outputs')
  const tx = new Transaction()
  let total = 0
  for (const { output, index } of coins) {
    const satoshis = output.satoshis
    if (typeof satoshis !== 'number' || !Number.isSafeInteger(satoshis) || satoshis < 0) throw new Error(`buyer early sweep: source output ${index} has invalid satoshis`)
    tx.addInput({ sourceTransaction: opts.claim, sourceOutputIndex: index, unlockingScriptTemplate: new P2PKH().unlock(opts.key, 'all', false) })
    total += satoshis
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(opts.toAddress), change: true })
  await tx.fee(new SatoshisPerKilobyte(opts.feeRate))
  await tx.sign()
  const outputSatoshis = tx.outputs[0]?.satoshis ?? 0
  const fee = total - outputSatoshis
  if (outputSatoshis <= BUYER_SWEEP_DUST_SATS) throw new Error(`buyer early sweep: output ${outputSatoshis} sat is at or below dust (${BUYER_SWEEP_DUST_SATS})`)
  if (tx.inputs.length !== coins.length || tx.outputs.length !== 1 || fee <= 0) throw new Error('buyer early sweep: invalid exact-input single-output transaction')
  const txid = tx.id('hex') as string
  const beef = Beef.fromBinary(tx.toBEEF())
  return { rawTx: tx.toHex(), atomicBeefHex: Utils.toHex(beef.toBinaryAtomic(txid)), tx, fee, outputSatoshis }
}
