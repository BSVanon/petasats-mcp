/**
 * Live rails for buy_gas: Base reads through the kit's own RPC failover transport, all pinned to one block and each
 * behind the kit's Base safety gate, the kit's Base key as a viem local account for EIP-712 signing, and the CoW
 * Protocol order book over fetch.
 */
import { createPublicClient, parseAbi, type Hex, type PublicClient, type Transport } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { BASE_USDC } from '../../../bridge/evm/base-tokens'
import { buyerBaseChain } from '../../../bridge/evm/tip-floor'
import { makeCowOrderBook } from '../gas-topup-api'
import { COW_SETTLEMENT, COW_VAULT_RELAYER } from '../gas-topup-order'
import { makeBuyerGasTopUp, type GasTopUpChainView } from '../gas-topup'
import type { BuyerGasTopUp } from '../types'

const USDC_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function allowance(address owner, address spender) view returns (uint256)',
])
const SETTLEMENT_ABI = parseAbi(['function filledAmount(bytes orderUid) view returns (uint256)'])

export function makeBuyerGasTopUpRails(opts: {
  home: string; privateKey: Hex; baseAddress: string; transport: Transport; fetch?: typeof fetch
  /** The kit's one Base safety gate (evm-rails assertSafeForNewLock): it refuses a split or unverified RPC pool. */
  assertSafeForNewLock: () => Promise<unknown>
}): BuyerGasTopUp {
  const account = privateKeyToAccount(opts.privateKey)
  if (account.address.toLowerCase() !== opts.baseAddress.toLowerCase()) throw new Error("buy_gas signer does not match the kit's Base address")
  let client: PublicClient | undefined // built on first use, so assembling the kit never touches a rail
  const read = async (uid?: Hex): Promise<GasTopUpChainView> => {
    await opts.assertSafeForNewLock() // every read, so neither a new order nor an order's end rests on a pool it refuses
    client ??= createPublicClient({ chain: buyerBaseChain, transport: opts.transport }) as PublicClient
    const block = await client.getBlock({ blockTag: 'latest' })
    const blockNumber = block.number
    const owner = account.address
    const [eth, usdc, usdcNonce, usdcDomainSeparator, allowance, filledAmount] = await Promise.all([
      client.getBalance({ address: owner, blockNumber }),
      client.readContract({ address: BASE_USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [owner], blockNumber }),
      client.readContract({ address: BASE_USDC, abi: USDC_ABI, functionName: 'nonces', args: [owner], blockNumber }),
      client.readContract({ address: BASE_USDC, abi: USDC_ABI, functionName: 'DOMAIN_SEPARATOR', blockNumber }),
      client.readContract({ address: BASE_USDC, abi: USDC_ABI, functionName: 'allowance', args: [owner, COW_VAULT_RELAYER], blockNumber }),
      uid === undefined ? undefined : client.readContract({ address: COW_SETTLEMENT, abi: SETTLEMENT_ABI, functionName: 'filledAmount', args: [uid], blockNumber }),
    ])
    return { blockNumber, timestamp: block.timestamp, eth, usdc, usdcNonce, usdcDomainSeparator, allowance, ...(filledAmount === undefined ? {} : { filledAmount }) }
  }
  return makeBuyerGasTopUp({
    home: opts.home, owner: account.address, chain: { read },
    api: makeCowOrderBook({ fetch: opts.fetch ?? globalThis.fetch }), signTypedData: account.signTypedData,
  })
}
