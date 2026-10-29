import { existsSync } from 'fs'
import { PrivateKey } from '@bsv/sdk'
import { ERC20_SWAP } from '../../../bridge/evm/erc20swap'
import { BASE_USDC } from '../../../bridge/evm/base-tokens'
import { makeAnvilMessageBoxComms } from '../../../transport/anvil-messagebox-comms'
import { DEFAULT_BSV_FEE_RATE_SAT_PER_KB } from '../../../settlement/htlc/bridge-covenant'
import { createBuyerKit } from '../buyer-kit'
import { makeMessageBoxDoorClient } from '../door-client'
import { DOOR_IDENTITY_PLACEHOLDER, RELEASED_DOOR_IDENTITY, assertSecureBuyerHome, buyerAddresses, buyerHome, makeFileBuyerStore, readBuyerConfig, readBuyerKeys, type BuyerDiskConfig, type BuyerHome } from '../local-state'
import { makeBuyerEngine } from '../engine'
import type { BuyerKit } from '../types'
import { assertBuyerMainnetP2pkhAddress } from './address'
import { makeBuyerBsvRails } from './bsv-rails'
import { guardBuyerEvmWrites, makeBuyerEvmRails } from './evm-rails'
import { makeIdentityOnlyWallet } from './identity-wallet'
import { buildSweepTx } from './sweep'
import { acquireBuyerHomeLock } from './home-lock'

export interface BuyerRuntime {
  kit: BuyerKit
  paths: BuyerHome
  config: BuyerDiskConfig
}

/** Test seams keep runtime-assembly tests entirely local; production uses all defaults. */
export interface BuyerRuntimeFactories {
  makeIdentityOnlyWallet: typeof makeIdentityOnlyWallet
  makeAnvilMessageBoxComms: typeof makeAnvilMessageBoxComms
  makeMessageBoxDoorClient: typeof makeMessageBoxDoorClient
  makeBuyerEvmRails: typeof makeBuyerEvmRails
  makeBuyerBsvRails: typeof makeBuyerBsvRails
  makeBuyerEngine: typeof makeBuyerEngine
  buildSweepTx: typeof buildSweepTx
}

export interface CreateBuyerRuntimeOptions {
  home?: string
  log?: (message: string) => void
  newWallet?: boolean
  /** Internal test injection point. Never required by callers. */
  factories?: Partial<BuyerRuntimeFactories>
}

const standardFactories: BuyerRuntimeFactories = {
  makeIdentityOnlyWallet, makeAnvilMessageBoxComms, makeMessageBoxDoorClient,
  makeBuyerEvmRails, makeBuyerBsvRails, makeBuyerEngine, buildSweepTx,
}

function assertReady(paths: BuyerHome): void {
  if (!existsSync(paths.home) || !existsSync(paths.keysPath) || !existsSync(paths.configPath)) {
    throw new Error('buyer home is not initialised; run `petasats-mcp init` first')
  }
}

function assertConfig(config: BuyerDiskConfig): asserts config is BuyerDiskConfig & { doorIdentity: string } {
  if (RELEASED_DOOR_IDENTITY === DOOR_IDENTITY_PLACEHOLDER &&
      (typeof config.doorIdentity !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(config.doorIdentity))) {
    throw new Error('buyer home has the placeholder door identity; set config.json doorIdentity before using money tools')
  }
  if (!Array.isArray(config.baseRpcUrls) || config.baseRpcUrls.length === 0) throw new Error('buyer config has no Base RPC URLs')
  if (!Number.isFinite(config.capUsdPerSwap) || config.capUsdPerSwap <= 0) throw new Error('buyer config has an invalid per-swap cap')
  if (typeof config.anvilHost !== 'string' || config.anvilHost.length === 0) throw new Error('buyer config has no Anvil MessageBox host')
}

/** Assemble the on-disk buyer kit.  It never reads an environment file or contacts a rail until configuration is ready. */
export async function createBuyerRuntime(options: CreateBuyerRuntimeOptions = {}): Promise<BuyerRuntime> {
  const paths = buyerHome(options.home)
  assertReady(paths)
  assertSecureBuyerHome(paths)
  acquireBuyerHomeLock(paths.home)
  const config = readBuyerConfig(paths)
  // A released build's identity is a build-time trust root.  Do not inspect an
  // old home's identity-shaped keys: only the current development key is read.
  if (RELEASED_DOOR_IDENTITY !== DOOR_IDENTITY_PLACEHOLDER) config.doorIdentity = RELEASED_DOOR_IDENTITY
  assertConfig(config)
  const keys = readBuyerKeys(paths)
  const f = { ...standardFactories, ...options.factories }
  const log = options.log ?? ((message: string) => console.error(`buyer-runtime: ${message}`))
  const identity = f.makeIdentityOnlyWallet(PrivateKey.fromWif(keys.identityWif))
  const comms = f.makeAnvilMessageBoxComms({ wallet: identity, host: config.anvilHost })
  const door = f.makeMessageBoxDoorClient({ comms, doorIdentity: config.doorIdentity })
  const evmRails = await f.makeBuyerEvmRails({
    privateKey: keys.evmPrivateKey,
    swapAddress: ERC20_SWAP.deployments.baseMainnet.address,
    usdcTokenAddress: BASE_USDC,
    rpcUrls: config.baseRpcUrls,
    log,
  })
  const bsv = f.makeBuyerBsvRails()
  const bsvKey = PrivateKey.fromWif(keys.bsvWif)
  const addresses = buyerAddresses(keys)
  const engine = f.makeBuyerEngine({
    comms, doorIdentity: config.doorIdentity, evm: guardBuyerEvmWrites(evmRails.client, () => evmRails.assertSafeForNewLock()), bsv: bsv as any,
    chainTracker: bsv.chainTracker, bsvReservePub: bsvKey.toPublicKey(), settlementDir: paths.settlementDir,
    usdcTokenAddress: BASE_USDC, capUsdPerSwap: config.capUsdPerSwap, now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log,
  })
  const wallet = {
    baseAddress: addresses.baseAddress,
    bsvAddress: addresses.bsvAddress,
    balances: async () => {
      const base = await evmRails.balances()
      const coins = await bsv.unspentFor(addresses.bsvAddress)
      return { ...base, claimedBsvSats: coins.filter((coin) => coin.confirmations >= 1).reduce((total, coin) => total + BigInt(coin.value), 0n) }
    },
    // `onlyTxid` limits a swap's deliver_to sweep to that swap's own claimed coin; withdraw_bsv sweeps everything.
    withdrawBsv: async (address: string, opts?: { onlyTxid?: string }) => {
      assertBuyerMainnetP2pkhAddress(address, 'address')
      const unspent = (await bsv.unspentFor(addresses.bsvAddress)).filter((coin) => coin.confirmations >= 1 && (opts?.onlyTxid === undefined || coin.tx_hash === opts.onlyTxid))
      if (!unspent.length) return { sats: 0n, reason: opts?.onlyTxid ? 'this swap\'s claimed BSV is not confirmed yet' : 'no confirmed BSV is available to sweep' }
      const coins = await Promise.all(unspent.map(async (coin) => {
        const sourceTx = await bsv.fetchBeef!(coin.tx_hash)
        if (!sourceTx?.merklePath) throw new Error(`buyer sweep: missing merkle proof for ${coin.tx_hash}`)
        return { ...coin, sourceTx }
      }))
      const built = await f.buildSweepTx({ coins, toAddress: address, key: bsvKey, feeRate: DEFAULT_BSV_FEE_RATE_SAT_PER_KB })
      const txid = await bsv.broadcast(built.rawTx, built.atomicBeefHex)
      return { txid, sats: BigInt(built.outputSatoshis) }
    },
    buildSweep: async (address: string, opts: { onlyTxid: string }) => {
      assertBuyerMainnetP2pkhAddress(address, 'address')
      const unspent = (await bsv.unspentFor(addresses.bsvAddress)).filter((coin) => coin.confirmations >= 1 && coin.tx_hash === opts.onlyTxid)
      if (!unspent.length) throw new Error('this swap\'s claimed BSV is not confirmed yet')
      const coins = await Promise.all(unspent.map(async (coin) => {
        const sourceTx = await bsv.fetchBeef!(coin.tx_hash)
        if (!sourceTx?.merklePath) throw new Error(`buyer sweep: missing merkle proof for ${coin.tx_hash}`)
        return { ...coin, sourceTx }
      }))
      const built = await f.buildSweepTx({ coins, toAddress: address, key: bsvKey, feeRate: DEFAULT_BSV_FEE_RATE_SAT_PER_KB })
      return { rawTx: built.rawTx, atomicBeefHex: built.atomicBeefHex, txid: built.tx.id('hex') as string, sats: BigInt(built.outputSatoshis) }
    },
    broadcastSweep: async (outbox: { rawTx: string; atomicBeefHex?: string; txid: string }) => {
      const accepted = await bsv.broadcast(outbox.rawTx, outbox.atomicBeefHex)
      if (accepted.toLowerCase() !== outbox.txid.toLowerCase()) throw new Error(`buyer sweep: relay returned mismatched txid ${accepted}`)
    },
    isSweepConfirmed: async (txid: string, _address: string) => {
      // The recipient can spend a confirmed output immediately.  Delivery is a fact
      // about the sweep transaction, not about whether its output remains unspent.
      const sweep = await bsv.fetchBeef!(txid)
      if (!sweep?.merklePath) return false
      try { return await sweep.merklePath.verify(txid, bsv.chainTracker) } catch { return false }
    },
    transferUsdc: async (to: `0x${string}`, amount: bigint) => {
      const receipt = await evmRails.client.transferErc20(BASE_USDC, to, amount)
      return { hash: receipt.hash, status: receipt.status }
    },
    transferEth: async (to: `0x${string}`, amount: bigint) => {
      const receipt = await evmRails.client.transferNative(to, amount)
      return { hash: receipt.hash, status: receipt.status }
    },
    estimateEthTransferFee: async (to: `0x${string}`) => evmRails.client.estimateNativeTransferFee(to),
  }
  const kit = createBuyerKit({ capUsdPerSwap: config.capUsdPerSwap, baseWithdrawalForbidden: [ERC20_SWAP.deployments.baseMainnet.address, BASE_USDC], newWallet: options.newWallet, keysPath: paths.keysPath }, {
    door, executor: engine, store: makeFileBuyerStore(paths), wallet,
    beforeNewSwap: () => evmRails.assertSafeForNewLock(), log,
  })
  return { kit, paths, config }
}
