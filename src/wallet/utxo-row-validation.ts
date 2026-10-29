/**
 * Strict field validators for provider UTXO rows (doc-26 slice-1b hardening, review HIGH e751b72f).
 *
 * A malformed provider row must NEVER be silently coerced (a missing/garbage `value` or height → `0`) into a coin the
 * reserve sweep then drops as dust/unconfirmed — because the sweep would report `total:0, failed:0`, stamp the
 * reconcile COMPLETE, and let `readInventory` serve a STALE-LOW reserve balance. So each source leaf validates every
 * row and rejects the WHOLE response (fail-closed → failover / HOLD) on any invalid field, rather than coercing.
 */

/** A 64-hex transaction id. */
export const is64HexTxid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s)

/** A non-negative safe integer (vout; or a height where 0 legitimately means "unconfirmed"). */
export const isNonNegSafeInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** A strictly-positive safe integer (a UTXO value in sats; or a confirmed block height). */
export const isPosSafeInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0

/** A non-null object — a provider row must be one BEFORE we read its fields, so a `null`/primitive array element
 *  fails closed cleanly instead of throwing on property access (review LOW aa3332b7). */
export const isObjectRow = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
