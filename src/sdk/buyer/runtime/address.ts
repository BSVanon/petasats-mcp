import { createHash } from 'crypto'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * Accept only a mainnet Base58Check P2PKH address.  In particular, this does
 * not accept P2SH, testnet, or cashaddr destinations for a buyer-kit sweep.
 */
export function isBuyerMainnetP2pkhAddress(address: string): boolean {
  if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{26,35}$/.test(address)) return false
  let value = 0n
  for (const char of address) {
    const digit = BASE58.indexOf(char)
    if (digit < 0) return false
    value = value * 58n + BigInt(digit)
  }
  const bytes: number[] = []
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn))
    value >>= 8n
  }
  for (const char of address) {
    if (char !== '1') break
    bytes.unshift(0)
  }
  if (bytes.length !== 25 || bytes[0] !== 0x00) return false
  const payload = Buffer.from(bytes.slice(0, 21))
  const checksum = Buffer.from(bytes.slice(21))
  const expected = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4)
  return checksum.equals(expected)
}

export function assertBuyerMainnetP2pkhAddress(address: string, label = 'deliver_to'): void {
  if (!isBuyerMainnetP2pkhAddress(address)) {
    throw new Error(`${label} must be a mainnet Base58Check P2PKH BSV address`)
  }
}
