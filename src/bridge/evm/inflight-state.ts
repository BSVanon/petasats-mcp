import { isAddress, isHex, keccak256, type Address, type Hex } from 'viem'

export const MAX_EVM_INFLIGHT_SENDS = 32
export const MAX_EVM_CONSUMED_SENDS = 64

export interface EvmInflightSend {
  nonce: number
  hash: Hex
  hashes: Hex[]
  signedTx: Hex
  /** Present only while the newest recorded replacement's submit outcome is unknown: the bytes the next replacement
   * is priced from (the last generation a node acknowledged or rejected as underpriced, else the original). Absent
   * means `signedTx` is the floor. Keeps undeliverable replacements from ratcheting the fee to the ceiling. */
  floorSignedTx?: Hex
  opKey: Hex
  /** Present only for caller-salted operations. Unsalted legacy entries remain byte-for-byte unchanged. */
  operationSalt?: Hex
  firstBroadcastAtMs: number
  broadcastAtMs: number
  retainConsumedAttribution: boolean
}

export interface EvmConsumedSend {
  opKey: Hex
  nonce: number
  hashes: Hex[]
  consumedAtMs: number
  /** This generation stayed unresolved past the resend threshold and permitted one new-nonce send. Its hashes are kept
   * so a late receipt for any of them is still recognized. Absent (never false) on disk. */
  superseded?: true
}

export interface EvmNonceState {
  chainId: number
  address: Address
  nextNonce: number
  lastBroadcastAtMs: number
  /** Monotone: the highest chain `latest` nonce ever observed (a mined receipt or a "nonce too low" rejection at N is
   * such an observation of N + 1). Selection never goes below it. Absent in older files, read as 0. */
  latestHighWater?: number
  inflight?: EvmInflightSend[]
  consumed?: EvmConsumedSend[]
}

const hashPattern = /^0x[0-9a-fA-F]{64}$/

function isSafeNonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function parseInflight(value: unknown, path: string): EvmInflightSend[] {
  if (!Array.isArray(value) || value.length > MAX_EVM_INFLIGHT_SENDS) {
    throw new Error(`EVM nonce counter ${path} has a malformed/over-cap inflight table (possible corruption/tamper; fail-closed)`)
  }
  const nonces = new Set<number>()
  const opKeys = new Set<string>()
  return value.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) throw new Error(`EVM nonce counter ${path} has a malformed inflight entry (fail-closed)`)
    const item = candidate as Record<string, unknown>
    const keys = Object.keys(item).sort()
    const expected = ['broadcastAtMs', 'firstBroadcastAtMs', ...('floorSignedTx' in item ? ['floorSignedTx'] : []),
      ...('operationSalt' in item ? ['operationSalt'] : []),
      'hash', 'hashes', 'nonce', 'opKey', 'retainConsumedAttribution', 'signedTx'].sort()
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i]) ||
        !isSafeNonNegative(item.nonce) || !isSafeNonNegative(item.firstBroadcastAtMs) ||
        !isSafeNonNegative(item.broadcastAtMs) || item.firstBroadcastAtMs > item.broadcastAtMs ||
        typeof item.retainConsumedAttribution !== 'boolean' ||
        typeof item.hash !== 'string' || !hashPattern.test(item.hash) ||
        typeof item.opKey !== 'string' || !hashPattern.test(item.opKey) ||
        ('operationSalt' in item && (typeof item.operationSalt !== 'string' || !hashPattern.test(item.operationSalt))) ||
        typeof item.signedTx !== 'string' || !isHex(item.signedTx, { strict: true }) || item.signedTx.length <= 2 ||
        !Array.isArray(item.hashes) || item.hashes.length === 0 ||
        item.hashes.some((hash) => typeof hash !== 'string' || !hashPattern.test(hash))) {
      throw new Error(`EVM nonce counter ${path} has a malformed inflight entry (possible corruption/tamper; fail-closed)`)
    }
    const hashes = item.hashes as string[]
    if (new Set(hashes.map((hash) => hash.toLowerCase())).size !== hashes.length ||
        hashes[hashes.length - 1].toLowerCase() !== item.hash.toLowerCase() ||
        nonces.has(item.nonce) || opKeys.has(item.opKey.toLowerCase())) {
      throw new Error(`EVM nonce counter ${path} has a duplicate/inconsistent inflight entry (fail-closed)`)
    }
    // The floor must be an earlier recorded generation of this same entry.
    const floor = item.floorSignedTx
    const floorHash = typeof floor === 'string' && isHex(floor, { strict: true }) && floor.length > 2
      ? keccak256(floor as Hex).toLowerCase()
      : undefined
    if ('floorSignedTx' in item && (floorHash === undefined || floorHash === item.hash.toLowerCase() ||
        !hashes.some((hash) => hash.toLowerCase() === floorHash))) {
      throw new Error(`EVM nonce counter ${path} has an inflight fee floor outside its recorded family (possible corruption/tamper; fail-closed)`)
    }
    nonces.add(item.nonce)
    opKeys.add(item.opKey.toLowerCase())
    return {
      nonce: item.nonce,
      hash: item.hash as Hex,
      hashes: hashes as Hex[],
      signedTx: item.signedTx as Hex,
      ...(floorHash !== undefined ? { floorSignedTx: floor as Hex } : {}),
      opKey: item.opKey as Hex,
      ...('operationSalt' in item ? { operationSalt: item.operationSalt as Hex } : {}),
      firstBroadcastAtMs: item.firstBroadcastAtMs,
      broadcastAtMs: item.broadcastAtMs,
      retainConsumedAttribution: item.retainConsumedAttribution,
    }
  }).sort((a, b) => a.nonce - b.nonce)
}

function parseConsumed(value: unknown, path: string): EvmConsumedSend[] {
  if (!Array.isArray(value) || value.length > MAX_EVM_CONSUMED_SENDS) {
    throw new Error(`EVM nonce counter ${path} has a malformed/over-cap consumed ring (possible corruption/tamper; fail-closed)`)
  }
  const identities = new Set<string>()
  return value.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error(`EVM nonce counter ${path} has a malformed consumed entry (fail-closed)`)
    }
    const item = candidate as Record<string, unknown>
    const keys = Object.keys(item).sort()
    const expected = ['consumedAtMs', 'hashes', 'nonce', 'opKey', ...('superseded' in item ? ['superseded'] : [])]
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i]) ||
        ('superseded' in item && item.superseded !== true) ||
        !isSafeNonNegative(item.nonce) || !isSafeNonNegative(item.consumedAtMs) ||
        typeof item.opKey !== 'string' || !hashPattern.test(item.opKey) ||
        !Array.isArray(item.hashes) || item.hashes.length === 0 ||
        item.hashes.some((hash) => typeof hash !== 'string' || !hashPattern.test(hash))) {
      throw new Error(`EVM nonce counter ${path} has a malformed consumed entry (possible corruption/tamper; fail-closed)`)
    }
    const hashes = item.hashes as string[]
    const identity = `${item.nonce}|${item.opKey.toLowerCase()}`
    if (new Set(hashes.map((hash) => hash.toLowerCase())).size !== hashes.length || identities.has(identity)) {
      throw new Error(`EVM nonce counter ${path} has a duplicate/inconsistent consumed entry (fail-closed)`)
    }
    identities.add(identity)
    return {
      opKey: item.opKey as Hex,
      nonce: item.nonce,
      hashes: hashes as Hex[],
      consumedAtMs: item.consumedAtMs,
      ...(item.superseded === true ? { superseded: true as const } : {}),
    }
  }).sort((a, b) => a.consumedAtMs - b.consumedAtMs || a.nonce - b.nonce)
}

/** Strictly parse legacy four-key state plus the additive high-water mark and durable attribution tables. */
export function parseEvmNonceState(raw: string, path: string): EvmNonceState {
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new Error(`EVM nonce counter ${path} is unparseable (possible corruption/tamper; fail-closed)`) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`EVM nonce counter ${path} is not a JSON object (possible corruption/tamper; fail-closed)`)
  }
  const state = value as Record<string, unknown>
  const keys = Object.keys(state).sort()
  const expected = ['address', 'chainId', ...('consumed' in state ? ['consumed'] : []),
    ...('inflight' in state ? ['inflight'] : []), 'lastBroadcastAtMs',
    ...('latestHighWater' in state ? ['latestHighWater'] : []), 'nextNonce'].sort()
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i]) ||
      !Number.isSafeInteger(state.chainId) || (state.chainId as number) < 1 ||
      typeof state.address !== 'string' || !isAddress(state.address) ||
      !isSafeNonNegative(state.nextNonce) || !isSafeNonNegative(state.lastBroadcastAtMs) ||
      ('latestHighWater' in state && !isSafeNonNegative(state.latestHighWater))) {
    throw new Error(`EVM nonce counter ${path} contains malformed state (possible corruption/tamper; fail-closed)`)
  }
  const inflight = 'inflight' in state ? parseInflight(state.inflight, path) : undefined
  const consumed = 'consumed' in state ? parseConsumed(state.consumed, path) : undefined
  const latestHighWater = 'latestHighWater' in state ? state.latestHighWater as number : 0
  return {
    chainId: state.chainId as number,
    address: state.address as Address,
    nextNonce: state.nextNonce,
    lastBroadcastAtMs: state.lastBroadcastAtMs,
    ...(latestHighWater > 0 ? { latestHighWater } : {}),
    ...(inflight?.length ? { inflight } : {}),
    ...(consumed?.length ? { consumed } : {}),
  }
}

/** Append/replace one attribution and evict the oldest entries. Ring fullness never blocks a money-path send. */
export function putConsumed(consumed: readonly EvmConsumedSend[], entry: EvmConsumedSend): EvmConsumedSend[] {
  const next = [...consumed.filter((candidate) =>
    candidate.nonce !== entry.nonce || candidate.opKey.toLowerCase() !== entry.opKey.toLowerCase()), entry]
    .sort((a, b) => a.consumedAtMs - b.consumedAtMs || a.nonce - b.nonce)
  return next.slice(Math.max(0, next.length - MAX_EVM_CONSUMED_SENDS))
}

export function pruneInflight(inflight: readonly EvmInflightSend[] | undefined, chainLatest: number): EvmInflightSend[] {
  return (inflight ?? []).filter((entry) => entry.nonce >= chainLatest)
}

export function putInflight(inflight: readonly EvmInflightSend[], entry: EvmInflightSend): EvmInflightSend[] {
  const prior = inflight.find((candidate) => candidate.nonce === entry.nonce)
  if (prior && prior.opKey.toLowerCase() !== entry.opKey.toLowerCase()) {
    throw new Error(`EVM nonce ${entry.nonce} is already reserved for a different operation (fail-closed)`)
  }
  const next = [...inflight.filter((candidate) => candidate.nonce !== entry.nonce), entry].sort((a, b) => a.nonce - b.nonce)
  if (next.length > MAX_EVM_INFLIGHT_SENDS) throw new Error(`EVM inflight table reached hard cap ${MAX_EVM_INFLIGHT_SENDS} (fail-closed)`)
  return next
}
