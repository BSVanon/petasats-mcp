/** Pure ERC20Swap v6 cooperative-refund EIP-712 and calldata helpers. */
import {
  concatHex,
  decodeFunctionData,
  domainSeparator,
  encodeFunctionData,
  hashStruct,
  hashTypedData,
  keccak256,
  parseSignature,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import type { Erc20SwapParams } from './erc20swap'
import erc20SwapArtifact from './erc20swap-artifact.json'

export const ERC20_SWAP_EIP712_NAME = 'ERC20Swap'
export const ERC20_SWAP_EIP712_VERSION = '6'
export const REFUND_TYPE = 'Refund(bytes32 preimageHash,uint256 amount,address tokenAddress,address claimAddress,uint256 timelock)'
export const TYPEHASH_REFUND = '0xf06c1ed74d5a145979b4b0602a00298e700feb0c04a27a49be9b6f0e7a4349dd' as Hex
export const BASE_MAINNET_ERC20SWAP_DOMAIN_SEPARATOR = '0x475a50011ca91cbf12d2c949918793a19db2c4e08c5f66f47880bf8c560b871b' as Hex

export const REFUND_TYPES = {
  Refund: [
    { name: 'preimageHash', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'tokenAddress', type: 'address' },
    { name: 'claimAddress', type: 'address' },
    { name: 'timelock', type: 'uint256' },
  ],
} as const

const REFUND_COOPERATIVE_INPUT_TYPES = ['bytes32', 'uint256', 'address', 'address', 'address', 'uint256', 'uint8', 'bytes32', 'bytes32']
const refundCooperativeNine = erc20SwapArtifact.abi.find((entry) =>
  entry.type === 'function' && entry.name === 'refundCooperative' &&
  entry.inputs.map((input) => input.type).join(',') === REFUND_COOPERATIVE_INPUT_TYPES.join(','),
)
if (!refundCooperativeNine) throw new Error('ERC20Swap artifact is missing the verified nine-argument refundCooperative overload')
/** Selected from the pinned artifact, excluding its legacy eight-argument overload. */
export const REFUND_COOPERATIVE_ABI = [refundCooperativeNine] as Abi

export function cooperativeRefundTypedData(p: Erc20SwapParams, chainId: number, verifyingContract: Address) {
  return {
    domain: { name: ERC20_SWAP_EIP712_NAME, version: ERC20_SWAP_EIP712_VERSION, chainId, verifyingContract },
    types: REFUND_TYPES,
    primaryType: 'Refund' as const,
    message: {
      preimageHash: p.preimageHash,
      amount: p.amount,
      tokenAddress: p.tokenAddress as Address,
      claimAddress: p.claimAddress as Address,
      timelock: p.timelock,
    },
  }
}

/** Digest produced by viem's canonical EIP-712 implementation. */
export function cooperativeRefundDigest(p: Erc20SwapParams, chainId: number, verifyingContract: Address): Hex {
  return hashTypedData(cooperativeRefundTypedData(p, chainId, verifyingContract))
}

/** Independent manual `keccak256(0x1901 || domainSeparator || structHash)` construction for the I6 vector. */
export function cooperativeRefundManualDigest(p: Erc20SwapParams, domainSeparator: Hex): Hex {
  const structHash = hashStruct({
    data: cooperativeRefundTypedData(p, 1, '0x0000000000000000000000000000000000000001').message,
    primaryType: 'Refund',
    types: REFUND_TYPES,
  })
  return keccak256(concatHex(['0x1901', domainSeparator, structHash]))
}

export function computedRefundDomainSeparator(chainId: number, verifyingContract: Address): Hex {
  return domainSeparator({
    domain: { name: ERC20_SWAP_EIP712_NAME, version: ERC20_SWAP_EIP712_VERSION, chainId, verifyingContract },
  })
}

/** Runtime contract constants must agree with the local v6 construction before any signature exists. */
export function assertCooperativeRefundConstants(
  chainId: number,
  verifyingContract: Address,
  onChainDomainSeparator: Hex,
  onChainTypehash: Hex,
): void {
  const localTypehash = keccak256(stringToHex(REFUND_TYPE))
  if (localTypehash.toLowerCase() !== TYPEHASH_REFUND.toLowerCase()) {
    throw new Error(`cooperative refund refused: local Refund typehash ${localTypehash} disagrees with pinned ${TYPEHASH_REFUND}`)
  }
  if (onChainTypehash.toLowerCase() !== TYPEHASH_REFUND.toLowerCase()) {
    throw new Error(`cooperative refund refused: contract TYPEHASH_REFUND ${onChainTypehash} disagrees with pinned ${TYPEHASH_REFUND}`)
  }
  const localDomain = computedRefundDomainSeparator(chainId, verifyingContract)
  if (onChainDomainSeparator.toLowerCase() !== localDomain.toLowerCase()) {
    throw new Error(`cooperative refund refused: contract DOMAIN_SEPARATOR ${onChainDomainSeparator} disagrees with local ${localDomain}`)
  }
}

/** Encode only the verified nine-argument overload, including the on-chain refundAddress. */
export function encodeRefundCooperative(p: Erc20SwapParams, signature: Hex): Hex {
  const parsed = parseSignature(signature)
  const v = Number(parsed.v ?? BigInt(27 + parsed.yParity))
  if (v !== 27 && v !== 28) throw new Error(`cooperative refund refused: signature v must be 27 or 28 (got ${v})`)
  return encodeFunctionData({
    abi: REFUND_COOPERATIVE_ABI,
    functionName: 'refundCooperative',
    args: [p.preimageHash, p.amount, p.tokenAddress as Address, p.claimAddress as Address, p.refundAddress as Address, p.timelock, v, parsed.r, parsed.s],
  })
}

/**
 * Bind top-level calldata to the verified nine-argument overload and the exact six-field swap tuple. Signature
 * fields are deliberately not interpreted: any ABI-valid v/r/s may have authorized the same cooperative refund.
 */
export function cooperativeRefundCalldataMatches(data: Hex, p: Erc20SwapParams): boolean {
  try {
    const decoded = decodeFunctionData({ abi: REFUND_COOPERATIVE_ABI, data })
    if (decoded.functionName !== 'refundCooperative' || !decoded.args || decoded.args.length !== 9) return false
    const args = decoded.args as readonly [Hex, bigint, Address, Address, Address, bigint, number, Hex, Hex]
    // Reject trailing/non-canonical bytes even if an ABI decoder would otherwise ignore them.
    const canonical = encodeFunctionData({ abi: REFUND_COOPERATIVE_ABI, functionName: 'refundCooperative', args })
    if (canonical.toLowerCase() !== data.toLowerCase()) return false
    return args[0].toLowerCase() === p.preimageHash.toLowerCase() &&
      args[1] === p.amount &&
      args[2].toLowerCase() === p.tokenAddress.toLowerCase() &&
      args[3].toLowerCase() === p.claimAddress.toLowerCase() &&
      args[4].toLowerCase() === p.refundAddress.toLowerCase() &&
      args[5] === p.timelock
  } catch {
    return false
  }
}
