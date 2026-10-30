import { lstatSync } from 'fs'
import { isAddress } from 'viem'
import { assertBuyerMainnetP2pkhAddress } from './runtime/address'
import { secureFileText, type BuyerHome } from './local-state'
import type { BuyerSwapRecord } from './types'

export interface BuyerLimits {
  format: 'petasats.limits/1'
  bsvDestinations?: string[]
  baseDestinations?: string[]
  maxSwapUsdPerDay?: number
}

const allowed = new Set(['format', 'bsvDestinations', 'baseDestinations', 'maxSwapUsdPerDay'])
export function readBuyerLimits(paths: BuyerHome): BuyerLimits | undefined {
  try {
    const stat = lstatSync(paths.limitsPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('limits.json must be a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw invalid(error instanceof Error ? error.message : 'limits.json is unreadable')
  }
  let value: unknown
  try { value = JSON.parse(secureFileText(paths.limitsPath)) } catch (error) {
    throw new Error(`refused by your limits file: ${error instanceof Error ? error.message : 'limits.json is unreadable'}; fix limits.json at the terminal; nothing was sent`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('limits.json must be an object')
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw invalid(`limits.json has an unknown key '${key}'`)
  if (source.format !== 'petasats.limits/1') throw invalid('limits.json format must be petasats.limits/1')
  const checkAddresses = (key: 'bsvDestinations' | 'baseDestinations'): string[] | undefined => {
    const input = source[key]
    if (input === undefined) return undefined
    if (!Array.isArray(input) || input.some((x) => typeof x !== 'string')) throw invalid(`${key} must be an array of addresses`)
    for (const address of input) {
      try {
        if (key === 'bsvDestinations') assertBuyerMainnetP2pkhAddress(address)
        else if (!isAddress(address, { strict: true })) throw new Error('not an address')
      } catch { throw invalid(`${key} contains an invalid address`) }
    }
    return input as string[]
  }
  const cap = source.maxSwapUsdPerDay
  if (cap !== undefined && (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0)) throw invalid('maxSwapUsdPerDay must be a finite number greater than zero')
  return { format: 'petasats.limits/1', ...(checkAddresses('bsvDestinations') !== undefined ? { bsvDestinations: checkAddresses('bsvDestinations') } : {}), ...(checkAddresses('baseDestinations') !== undefined ? { baseDestinations: checkAddresses('baseDestinations') } : {}), ...(cap !== undefined ? { maxSwapUsdPerDay: cap } : {}) }
}
function invalid(message: string): Error { return new Error(`refused by your limits file: ${message}; fix limits.json at the terminal; nothing was sent`) }

export function assertBsvDestination(limits: BuyerLimits | undefined, address: string): void {
  if (limits?.bsvDestinations && !limits.bsvDestinations.includes(address)) throw new Error('refused by your limits file: this BSV address is not in bsvDestinations; nothing was sent')
}
export function assertBaseDestination(limits: BuyerLimits | undefined, address: string): void {
  if (limits?.baseDestinations && !limits.baseDestinations.some((candidate) => candidate.toLowerCase() === address.toLowerCase())) throw new Error('refused by your limits file: this Base address is not in baseDestinations; nothing was sent')
}
export function assertDailySwapCap(limits: BuyerLimits | undefined, records: BuyerSwapRecord[], amount: bigint, at: number): void {
  if (limits?.maxSwapUsdPerDay === undefined) return
  const day = new Date(at).toISOString().slice(0, 10)
  const spent = records.filter((r) => r.stage !== 'failed' && new Date(r.createdAtMs).toISOString().slice(0, 10) === day).reduce((sum, r) => sum + BigInt(r.amountIn), 0n)
  if (Number(spent + amount) / 1e6 > limits.maxSwapUsdPerDay) throw new Error('refused by your limits file: this swap exceeds maxSwapUsdPerDay; nothing was sent')
}
