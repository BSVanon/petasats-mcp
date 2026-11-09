/**
 * Agent-wallet loader — the seam between the O1 keystore and wallet construction.
 *
 * `loadAgentKey(keystore, passphrase) → PrivateKey` replaces the harvested
 * Operator wallet's plaintext `cfg.operatorWif` with a decrypted keystore key;
 * everything downstream (Setup.createWallet + StorageKnex) is the proven Operator
 * bootstrap, unchanged. This is what Phase 2.5 uses to build the mainnet
 * broadcast wallet — so once the keystore is sealed with a micro-funded key and
 * the Anvil node endpoint is set, the on-chain proof is a small final step.
 *
 * Ported byte-faithfully from `SendBSV-Wallet-Operator/src/operator-wallet.ts`
 * (harvest map "Agent wallet"), verified against toolbox 2.1.21 (`Setup`,
 * `createSQLiteKnex`, `SetupEnv`, `randomBytesHex` all present & identical). The
 * one non-negotiable it carries: the **110 sat/kb** feeModel — the toolbox
 * default (1 sat/kb) is rejected by every public broadcaster (ARC error 465).
 */

import { PrivateKey } from '@bsv/sdk'
import { Setup, StorageKnex, randomBytesHex, type SetupWalletKnex, type SetupEnv, type Chain, type sdk } from '@bsv/wallet-toolbox'
import { KeystoreFile, openWif } from './keystore'
import { makeWocChaintracks } from './woc-chaintracks'
import { makeAnvilChaintracks } from './anvil-chaintracks'
import { anchorMerklePathService } from './anchored-merkle-path'
import { makeLadderPostBeefService } from './ladder-broadcaster'
import { setAnvilNode } from './broadcast'

/** BSV P2PKH address version byte: mainnet 0x00, every test chain 0x6f. `PrivateKey.toAddress` defaults to mainnet. */
function addressPrefix(chain: Chain): number[] {
  return chain === 'main' ? [0x00] : [0x6f]
}

export class AgentWalletError extends Error {
  constructor(message: string) {
    super(`agent-wallet: ${message}`)
    this.name = 'AgentWalletError'
  }
}

/** GorillaPool ARC policy floor (100 sat/kb) + rounding headroom; 4 mainnet broadcasts verified at 110. */
export const DEFAULT_FEE_SAT_PER_KB = 110

/** Broadcaster policy floor (ARC rejects below 100 sat/kb with error 465 "Fee too low"). */
export const MIN_FEE_SAT_PER_KB = 100

/**
 * `Services` applies its postBeef soft timeout to one provider adapter. LadderBeef is one adapter that runs five
 * sequential 30-second tiers, so its wrapper budget must cover the whole ladder.
 */
export const LADDER_POST_BEEF_SOFT_TIMEOUT_MS = 180_000

/**
 * Resolve and validate the fee rate: always a positive integer; on mainnet it
 * must also clear the broadcaster floor (below it, every public ARC rejects the
 * tx). Prevents an operator-facing config from silently producing unbroadcastable
 * transactions (review d844d42a LOW).
 */
export function resolveFeeSatPerKb(cfg: AgentWalletConfig): number {
  const fee = cfg.feeSatPerKb ?? DEFAULT_FEE_SAT_PER_KB
  if (!Number.isInteger(fee) || fee <= 0) throw new AgentWalletError(`feeSatPerKb must be a positive integer, got ${fee}`)
  if (cfg.chain === 'main' && fee < MIN_FEE_SAT_PER_KB) {
    throw new AgentWalletError(`feeSatPerKb ${fee} is below the mainnet broadcaster floor (${MIN_FEE_SAT_PER_KB} sat/kb) — the tx would be rejected (ARC 465)`)
  }
  return fee
}

export interface KeySource {
  keystore: KeystoreFile
  passphrase: string
  /** TEST ONLY — threads the keystore's insecure-params override (weak scrypt in tests). */
  allowInsecureParams?: boolean
}

export interface AgentWalletConfig {
  chain: Chain // 'main' | 'test'
  walletDb: string // SQLite path (on-disk for a real agent)
  taalApiKey?: string
  feeSatPerKb?: number // default 110 (ARC-compatible)
  /** Optional WhatsOnChain API key — used by the testnet chaintracker adapter to raise the free-tier rate limit. */
  whatsOnChainApiKey?: string
  /** MAINNET only: the Anvil node base URL (each agent's own node) — its chaintracker backs the wallet's SPV. */
  chaintracksUrl?: string
  /** MAINNET only: Anvil Bearer token (needed for broadcast; chaintracks reads are open). */
  anvilAuthToken?: string
}

/** THE seam: decrypt the agent key from its keystore. Everything else builds on this. */
export function loadAgentKey(src: KeySource): PrivateKey {
  return PrivateKey.fromWif(openWif(src.keystore, src.passphrase, { allowInsecureParams: src.allowInsecureParams }))
}

/** The agent's identity public key (hex), without building a wallet. */
export function agentIdentityKey(src: KeySource): string {
  return loadAgentKey(src).toPublicKey().toString()
}

/** The agent's P2PKH address, without building a wallet. Network-aware (F-B): `toAddress()` defaults to the
 *  MAINNET encoding, which is wrong for a testnet agent — pass `chain` to get the right version byte. */
export function agentAddress(src: KeySource, chain: Chain = 'main'): string {
  return loadAgentKey(src).toAddress(addressPrefix(chain))
}

/** Assemble the toolbox `SetupEnv` from the keystore-decrypted key (pure; unit-testable). */
export function buildAgentSetupEnv(src: KeySource, cfg: AgentWalletConfig): SetupEnv {
  const rootKey = loadAgentKey(src)
  const identityKey = rootKey.toPublicKey().toString()
  return {
    chain: cfg.chain,
    identityKey,
    identityKey2: identityKey,
    filePath: undefined,
    taalApiKey: cfg.taalApiKey ?? '',
    devKeys: { [identityKey]: rootKey.toHex() },
    mySQLConnection: '{}'
  }
}

/** The mutable surface of the toolbox `Services` the mainnet swap touches — kept structural so it is unit-testable
 *  with a fake (the concrete `Services` satisfies it: the listed slots are its public mutable surface). */
export interface AnvilServiceSlots {
  options: { chaintracks?: unknown }
  whatsonchain: { getBlockHeaderByHash(hash: string): Promise<{ height: number } | undefined> }
  getMerklePathServices: { services: { name: string; service: sdk.GetMerklePathService }[]; reset(): void }
  postBeefServices: { services: { name: string; service: unknown }[]; reset(): void }
  postBeefUntilSuccessSoftTimeoutMs: number
  postBeefUntilSuccessSoftTimeoutPerKbMs: number
  postBeefUntilSuccessSoftTimeoutMaxMs: number
}

/**
 * MAINNET Services swap (canonical-P1 noSend-lifecycle): point BOTH of the wallet's chain rails at THIS agent's own
 * Anvil node —
 *   • CHAINTRACKER (SPV header reads): PoW-validated headers, no third-party trust (doc 20 §B).
 *   • PROOFS: header-by-hash lookup is anchored to this agent's Anvil chain and every fetched proof must hash to
 *     Anvil's merkle root at its height.
 *   • BROADCASTER (`postBeef`): the proven `/broadcast?arc=true` route (STAGE-2 spend). The WALLET owns the HTLC-lock
 *     broadcast (via `sendWith`) so it advances its own state — a broadcast 0-conf change output becomes spendable,
 *     which is what makes swap-to-swap chaining work. REPLACES the toolbox default public-ARC set
 *     (TAAL/GorillaPool/WoC) with ONE own-node service, NO third-party fallback (mandate: own-node broadcast,
 *     fail-closed; a relay can't forge a signed tx, but the mandate is own-node + a predictable failure surface).
 * Mutates the LIVE Services the wallet holds (same instance) — the `getChainTracker`/`postBeef` paths re-read these,
 * so the swap sticks. Only invoked on mainnet-with-Anvil; testnet/mockchain keep the defaults untouched.
 */
export function applyMainnetAnvilServices(services: AnvilServiceSlots, chaintracksUrl: string, authToken?: string): void {
  const anvil = makeAnvilChaintracks(chaintracksUrl, {
    authToken,
    locateBlockHeight: async (hash) => (await services.whatsonchain.getBlockHeaderByHash(hash))?.height,
  })
  services.options.chaintracks = anvil
  services.getMerklePathServices.services = services.getMerklePathServices.services.map(({ name, service }) => ({
    name,
    service: anchorMerklePathService(service, anvil),
  }))
  services.getMerklePathServices.reset()
  // The wallet's postBeef broadcaster is the 5-tier LADDER (Anvil own-node FIRST, then GorillaPool/TAAL/WoC/Bitails on
  // Anvil's ambiguous verdict) so the wallet-owned sendWith advances state AND survives a single own-node hiccup
  // (2026-09-08 stall; review-directed — the fallback must live INSIDE the wallet lifecycle, not bolted outside it).
  setAnvilNode(chaintracksUrl, authToken) // point the ladder's Anvil tier at THIS agent's node (module-global; one node/process)
  const ladderBeef = makeLadderPostBeefService()
  services.postBeefServices.services = [{ name: 'LadderBeef', service: ladderBeef }]
  services.postBeefServices.reset()
  // The toolbox soft-timeout is per-single-provider-adapter; our LadderBeef is ONE adapter wrapping five sequential
  // 30s tiers, so the wrapper budget MUST cover the full ladder or it truncates the cascade, discards the real
  // verdict, and strands the lock 'sending'.
  services.postBeefUntilSuccessSoftTimeoutMs = LADDER_POST_BEEF_SOFT_TIMEOUT_MS
  services.postBeefUntilSuccessSoftTimeoutMaxMs = LADDER_POST_BEEF_SOFT_TIMEOUT_MS
  services.postBeefUntilSuccessSoftTimeoutPerKbMs = 0
}

/**
 * Build a headless agent wallet from its keystore — the MAINNET path (Phase 2.5).
 * Mirrors the harvested Operator bootstrap: `Setup.createWallet` for the wallet
 * shell, then a `StorageKnex` built directly with a broadcaster-compatible
 * feeModel (skipping the toolbox helper's 1 sat/kb hardcode). Uses REAL Services
 * — this is exercised on-chain in Phase 2.5, not in the headless test suite (the
 * key-seam and a functioning-wallet proof are covered against the mockchain).
 */
export async function buildAgentWallet(src: KeySource, cfg: AgentWalletConfig): Promise<SetupWalletKnex> {
  const feeSatPerKb = resolveFeeSatPerKb(cfg) // validate before any wallet/network work
  // MANDATE (review 27131773 MED): a real-funds MAINNET wallet MUST run on THIS agent's own Anvil node — own-node
  // chaintracker (SPV) AND own-node broadcaster (postBeef), no third-party trust. Without chaintracksUrl the wallet
  // would SILENTLY keep the toolbox default public-ARC broadcaster + Babbage chaintracker; refuse to build it. (Every
  // real mainnet caller passes chaintracksUrl; this closes the accidental-default hole before real funds move.)
  if (cfg.chain === 'main' && (typeof cfg.chaintracksUrl !== 'string' || cfg.chaintracksUrl.trim() === '')) {
    throw new AgentWalletError("mainnet wallet requires chaintracksUrl (this agent's own Anvil node) — refusing to build a real-funds wallet on public/default rails")
  }
  const env = buildAgentSetupEnv(src, cfg)
  const wo = await Setup.createWallet({ env })

  // Chain Services (doc 20): for TESTNET the toolbox default chaintracker (`testnet-chaintracks.babbage.systems`)
  // is DOWN, so point it at a WhatsOnChain-backed adapter. Both `Services.getHeight` and `getChainTracker` re-read
  // `options.chaintracks`, and the wallet SPV path calls only `getPresentHeight` + `findHeaderForHeight`. MAINNET
  // keeps the default here (Babbage mainnet is up); each agent's local Anvil client is wired at deploy (doc 20 §B).
  if (cfg.chain === 'test') {
    wo.services.options.chaintracks = makeWocChaintracks('test', { apiKey: cfg.whatsOnChainApiKey }) as typeof wo.services.options.chaintracks
  } else if (cfg.chaintracksUrl) {
    // MAINNET: point BOTH the chaintracker and the broadcaster at THIS agent's own Anvil node (extracted so the
    // Services swap is unit-testable; see applyMainnetAnvilServices).
    applyMainnetAnvilServices(wo.services, cfg.chaintracksUrl, cfg.anvilAuthToken)
  }
  const knex = Setup.createSQLiteKnex(cfg.walletDb)
  const activeStorage = new StorageKnex({
    chain: wo.chain,
    knex,
    commissionSatoshis: 0,
    commissionPubKeyHex: undefined,
    feeModel: { model: 'sat/kb', value: feeSatPerKb }
  })
  await activeStorage.migrate('agent', randomBytesHex(33))
  await activeStorage.makeAvailable()
  await wo.storage.addWalletStorageProvider(activeStorage)
  const { user } = await activeStorage.findOrInsertUser(wo.identityKey)
  return { ...wo, activeStorage, userId: user.userId } as SetupWalletKnex
}
