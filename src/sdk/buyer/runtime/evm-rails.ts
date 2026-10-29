import { base } from 'viem/chains'
import { createPublicClient, type Address, type Hex } from 'viem'
import { Erc20SwapEvmClient } from '../../../bridge/evm/client'
import { BaseRpcFailoverPool, DEFAULT_BASE_RPC_PROBE_INTERVAL_MS } from '../../../bridge/evm/rpc'

/** The public Base endpoint already used by the unattended boxes. */
export const DEFAULT_BUYER_BASE_RPC_URLS = ['https://base-rpc.publicnode.com'] as const

export interface BuyerEvmRailsOptions {
  privateKey: Hex
  swapAddress: Address
  usdcTokenAddress: Address
  rpcUrls?: readonly string[]
  fetchImpl?: typeof fetch
  probeIntervalMs?: number
  alert?: (message: string) => void
  log?: (message: string) => void
}

export interface BuyerEvmRails {
  client: Erc20SwapEvmClient
  pool: BaseRpcFailoverPool
  assertSafeForNewLock(): void
  balances(): Promise<{ usdc: bigint; eth: bigint }>
}

/**
 * Make the risk-writing methods self-guarding.  A quote/admission exchange can
 * take long enough for a previously healthy pool to become split, so the
 * safety decision belongs at each write boundary rather than at its caller.
 */
export function guardBuyerEvmWrites(client: Erc20SwapEvmClient, assertSafeForNewLock: () => void): Erc20SwapEvmClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'approve' && property !== 'lock' && property !== 'transferErc20' && property !== 'transferNative' && property !== 'consumeNonce') return value
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        assertSafeForNewLock()
        return value.apply(target, args)
      }
    },
  })
}

/**
 * Build a locally-signing but provider-keyless Base client.  Probe before
 * returning: a new lock is never permitted against an unverified/split pool.
 */
export async function makeBuyerEvmRails(opts: BuyerEvmRailsOptions): Promise<BuyerEvmRails> {
  const urls = opts.rpcUrls?.length ? [...opts.rpcUrls] : [...DEFAULT_BUYER_BASE_RPC_URLS]
  const pool = new BaseRpcFailoverPool({
    urls,
    swapAddress: opts.swapAddress,
    probeIntervalMs: opts.probeIntervalMs ?? DEFAULT_BASE_RPC_PROBE_INTERVAL_MS,
    alert: opts.alert ?? (() => {}),
    log: opts.log,
    fetchImpl: opts.fetchImpl,
  })
  await pool.probeNow()
  const rawClient = new Erc20SwapEvmClient({
    rpcUrl: urls[0], rpcUrls: urls, privateKey: opts.privateKey,
    swapAddress: opts.swapAddress, pinnedTokenAddresses: [opts.usdcTokenAddress],
    chain: base, transport: pool.transport,
  })
  const reader = createPublicClient({ chain: base, transport: pool.transport })
  await rawClient.assertChainId()
  const assertSafeForNewLock = (): void => {
    if (pool.isSplit() || pool.isUnverified()) {
      throw new Error('buyer EVM rail is split or unverified — refusing a new lock')
    }
  }
  return {
    client: guardBuyerEvmWrites(rawClient, assertSafeForNewLock),
    pool,
    assertSafeForNewLock,
    balances: async (): Promise<{ usdc: bigint; eth: bigint }> => ({
      usdc: await rawClient.usdcBalance(opts.usdcTokenAddress),
      eth: await reader.getBalance({ address: rawClient.address() }),
    }),
  }
}
