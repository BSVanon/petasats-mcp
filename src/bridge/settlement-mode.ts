export const PUBLIC_FAST_CAP_USDC_BASE_UNITS = 25_000_000n

export type PublicSettlementMode = 'confirmed' | 'fast'

export function isPublicDoorQuoteId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value)
}

export function isPublicSettlementMode(value: unknown): value is PublicSettlementMode {
  return value === 'confirmed' || value === 'fast'
}

export function isCanonicalFastCap(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= PUBLIC_FAST_CAP_USDC_BASE_UNITS
}

export function publicSettlementModeAndCapAreConsistent(mode: unknown, cap: unknown): mode is PublicSettlementMode {
  return isPublicSettlementMode(mode) && isCanonicalFastCap(cap) && (mode === 'fast') === (BigInt(cap) > 0n)
}

/** Public-door fast eligibility uses canonical USDC atomic units and is inclusive at the cap. */
export function fastAtomicEligible(amountUsdcBaseUnits: string | bigint, fastCapUsdcBaseUnits: string | bigint): boolean {
  try {
    const amountText = typeof amountUsdcBaseUnits === 'bigint' ? amountUsdcBaseUnits.toString() : amountUsdcBaseUnits
    const capText = typeof fastCapUsdcBaseUnits === 'bigint' ? fastCapUsdcBaseUnits.toString() : fastCapUsdcBaseUnits
    if (!/^[1-9][0-9]*$/.test(amountText) || !/^[1-9][0-9]*$/.test(capText)) return false
    const cap = BigInt(capText)
    return cap <= PUBLIC_FAST_CAP_USDC_BASE_UNITS && BigInt(amountText) <= cap
  } catch { return false }
}
