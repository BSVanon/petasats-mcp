import { decodeEventLog, decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from 'viem'
import { hashlockOf } from '../../settlement/htlc'
/** Pinned Boltz ERC20Swap identity. */
export const ERC20_SWAP = {
  source: 'BoltzExchange/boltz-core:contracts/ERC20Swap.sol',
  version: 6,
  solidity: '^0.8.33',
  /** Exact deployed-runtime hashes. The constructor patches its EIP-712 DOMAIN_SEPARATOR immutable into four
   * locations, so the unpatched artifact tail is NOT a deployable-code identity. These hashes are derived from the
   * pinned boltz-core@5.0.0 creation artifact after applying the constructor's chainId/address-specific immutable. */
  deployments: {
    baseMainnet: {
      chainId: 8453,
      address: '0xb8a2ce7dec5e4e8a59f5145e2f9254ee4a887605',
      runtimeCodeHash: '0x1e1c02b4c9fe57c949046329efcd45745c77fe1897a370bb5d1c8b09ed6cbe6d',
    },
    baseSepolia: {
      chainId: 84532,
      address: '0x1d6226c6343f6c920653028f6bcb59c3e104dc24',
      runtimeCodeHash: '0x1c535ce7468b3c8ea69f4ddbb048ff53f54d21afd6504f74d32f54fe88e1c491',
    },
  },
} as const

/** The subset of the ERC20Swap + ERC20 ABI we use (standard mode). */
export const ERC20_SWAP_ABI = parseAbi([
  'function VERSION() view returns (uint8)',
  'function lock(bytes32 preimageHash, uint256 amount, address tokenAddress, address claimAddress, address refundAddress, uint256 timelock)',
  'function claim(bytes32 preimage, uint256 amount, address tokenAddress, address claimAddress, address refundAddress, uint256 timelock)',
  'function refund(bytes32 preimageHash, uint256 amount, address tokenAddress, address claimAddress, address refundAddress, uint256 timelock)',
  'function hashValues(bytes32 preimageHash, uint256 amount, address tokenAddress, address claimAddress, address refundAddress, uint256 timelock) view returns (bytes32)',
  // Boltz stores each LOCKED swap as swaps[hashValues(...)] = true, and DELETES it on claim/refund → this getter is
  // the canonical CURRENT-unspent signal (unlike the permanent Lockup event). Used to refuse locking BSV against an
  // already-claimed/refunded/replayed Base lock (review 23adfcda HIGH).
  'function swaps(bytes32) view returns (bool)',
  'event Lockup(bytes32 indexed preimageHash, uint256 amount, address tokenAddress, address indexed claimAddress, address indexed refundAddress, uint256 timelock)',
  'event Claim(bytes32 indexed preimageHash, bytes32 preimage)',
  'event Refund(bytes32 indexed preimageHash)',
])

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
])

/** The swap tuple (all six args identify a swap in the contract). */
export interface Erc20SwapParams {
  /** `H = sha256(secret)` as bytes32 hex. */
  preimageHash: Hex
  amount: bigint // USDC base units
  tokenAddress: Hex // USDC
  claimAddress: Hex 
  refundAddress: Hex // machine (refund)
  timelock: bigint // T_base (Unix ts)
}

// ─── the cross-chain hash binding ────────────────────────────────────

/** `preimageHash = sha256(secret)` — byte-identical to the BSV `OP_SHA256` leg. */
export function preimageHashOf(secret: number[]): Hex {
  return `0x${hashlockOf(secret)}`
}

// ─── calldata encoders (what a wallet signs + sends) ─────────────────

/** Machine: approve the ERC20Swap contract to pull `amount` USDC (before lock). */
export function encodeApprove(spender: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] })
}

/** Machine (initiator): lock USDC under the hashlock + `T_base` timelock. */
export function encodeLock(p: Erc20SwapParams): Hex {
  return encodeFunctionData({
    abi: ERC20_SWAP_ABI,
    functionName: 'lock',
    args: [p.preimageHash, p.amount, p.tokenAddress, p.claimAddress, p.refundAddress, p.timelock],
  })
}

export function encodeClaim(p: Erc20SwapParams, secret: number[]): Hex {
  const preimage = `0x${Buffer.from(secret).toString('hex')}` as Hex
  return encodeFunctionData({
    abi: ERC20_SWAP_ABI,
    functionName: 'claim',
    args: [preimage, p.amount, p.tokenAddress, p.claimAddress, p.refundAddress, p.timelock],
  })
}

/** Machine (initiator): refund USDC after `T_base` if the swap didn't complete. */
export function encodeRefund(p: Erc20SwapParams): Hex {
  return encodeFunctionData({
    abi: ERC20_SWAP_ABI,
    functionName: 'refund',
    args: [p.preimageHash, p.amount, p.tokenAddress, p.claimAddress, p.refundAddress, p.timelock],
  })
}

// ─── decoders (for the watcher) ──────────────────────────────────────

export interface LockupEvent {
  preimageHash: Hex
  amount: bigint
  tokenAddress: Hex
  claimAddress: Hex
  refundAddress: Hex
  timelock: bigint
}

/** Decode a `Lockup` log — the watcher detects the machine's USDC lock. Null if not one. */
export function decodeLockupLog(log: { topics: Hex[]; data: Hex }): LockupEvent | null {
  try {
    const d = decodeEventLog({ abi: ERC20_SWAP_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data })
    if (d.eventName !== 'Lockup') return null
    const a = d.args as unknown as LockupEvent
    return a
  } catch {
    return null
  }
}

/** Decode a `Claim` log → the revealed 32-byte preimage (secret), or null. */
export function decodeClaimSecret(log: { topics: Hex[]; data: Hex }): number[] | null {
  try {
    const d = decodeEventLog({ abi: ERC20_SWAP_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data })
    if (d.eventName !== 'Claim') return null
    const preimage = (d.args as { preimage: Hex }).preimage
    return Array.from(Buffer.from(preimage.slice(2), 'hex'))
  } catch {
    return null
  }
}

/** Decode any of our calldata back to {functionName, args} — used in tests + audits. */
export function decodeSwapCalldata(data: Hex): { functionName: string; args: readonly unknown[] } {
  const d = decodeFunctionData({ abi: ERC20_SWAP_ABI, data })
  return { functionName: d.functionName, args: d.args as readonly unknown[] }
}
