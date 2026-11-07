/** Fastest Base block cadence this build models. A smaller override adds block-count headroom everywhere. */
export const DEFAULT_BASE_BLOCK_SECS_FLOOR = 0.2
export const MIN_BASE_BLOCK_SECS_FLOOR = 0.01

/** Fail at module load so an invalid process setting cannot reach a swap. */
export function resolveBaseBlockSecsFloor(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.BASE_BLOCK_SECS_FLOOR
  if (raw === undefined) return DEFAULT_BASE_BLOCK_SECS_FLOOR
  const value = Number(raw)
  if (!Number.isFinite(value) || value < MIN_BASE_BLOCK_SECS_FLOOR || value > DEFAULT_BASE_BLOCK_SECS_FLOOR) {
    throw new Error(
      `BASE_BLOCK_SECS_FLOOR must be a finite number in [${MIN_BASE_BLOCK_SECS_FLOOR}, ${DEFAULT_BASE_BLOCK_SECS_FLOOR}] (got '${raw}')`,
    )
  }
  return value
}

export const BASE_BLOCK_SECS_FLOOR = resolveBaseBlockSecsFloor()

export function baseBlocksForSecs(secs: number, floorSecs = BASE_BLOCK_SECS_FLOOR): number {
  if (!Number.isFinite(secs) || secs < 0) throw new Error(`baseBlocksForSecs: secs must be finite and non-negative (got ${String(secs)})`)
  return Math.ceil(secs / floorSecs)
}

export function baseSecsForBlocks(blocks: number, floorSecs = BASE_BLOCK_SECS_FLOOR): number {
  if (!Number.isFinite(blocks) || blocks < 0) throw new Error(`baseSecsForBlocks: blocks must be finite and non-negative (got ${String(blocks)})`)
  return blocks * floorSecs
}

/** Normalize binary noise at an exact whole-second boundary before applying a conservative integer rounding rule. */
export function snapBaseSecondsNearInteger(seconds: number): number {
  const nearest = Math.round(seconds)
  const tolerance = Math.max(1, Math.abs(seconds), Math.abs(nearest)) * Number.EPSILON * 8
  return Math.abs(seconds - nearest) <= tolerance ? nearest : seconds
}

/** Whole seconds that are actually available before a Base-block deadline. Never overstates the runway. */
export function baseAvailableSecsForBlocks(blocks: number, floorSecs = BASE_BLOCK_SECS_FLOOR): number {
  return Math.floor(snapBaseSecondsNearInteger(baseSecsForBlocks(blocks, floorSecs)))
}

/** Whole seconds that must fit inside a Base-block window. Never understates the required budget. */
export function baseRequiredSecsForBlocks(blocks: number, floorSecs = BASE_BLOCK_SECS_FLOOR): number {
  return Math.ceil(snapBaseSecondsNearInteger(baseSecsForBlocks(blocks, floorSecs)))
}

export const BASE_BLOCK_TIME_SAMPLE_BLOCKS = 1_000n
export const BASE_BLOCK_TIME_PASS_CACHE_MS = 60_000
export const BASE_BLOCK_TIME_TOLERANCE = 0.95
export const BASE_BLOCK_TIME_CHECK_ATTEMPTS = 3
export const BASE_BLOCK_TIME_RETRY_DELAY_MS = 5_000
/** Maximum sleep time added by a full read-failure recovery. */
export const BASE_BLOCK_TIME_RETRY_BUDGET_MS = (BASE_BLOCK_TIME_CHECK_ATTEMPTS - 1) * BASE_BLOCK_TIME_RETRY_DELAY_MS

/** Existing Base clients satisfy this without another RPC implementation. */
export interface BaseBlockTimeReader {
  currentBlockNumber(): Promise<bigint>
  blockTimestamp(blockNumber: bigint): Promise<number>
}

export type BaseBlockTimeCheckResult =
  | { ok: true; secondsPerBlock: number; head: bigint; sampledFrom: bigint }
  | { ok: false; reason: string; retryable: true }

export type BaseBlockTimeCheck = () => Promise<BaseBlockTimeCheckResult>

export interface BaseBlockTimeRetryOptions {
  sleep?: (ms: number) => Promise<void>
}

function safeReadError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/https?:\/\/[^\s)]+/gi, '<Base RPC>')
}

function isReadFailure(result: BaseBlockTimeCheckResult): result is Extract<BaseBlockTimeCheckResult, { ok: false }> {
  return !result.ok && result.reason.startsWith('Base block-time check read failed (fail-closed):')
}

/**
 * Retry only checker results that explicitly report an unavailable read. A thrown checker, measured unsupported
 * cadence, or malformed measurement refuses on the first attempt. The returned result and any final thrown error
 * retain the checker's existing shape and wording.
 */
export async function checkBaseBlockTimeWithRetry(
  check: BaseBlockTimeCheck,
  opts: BaseBlockTimeRetryOptions = {},
): Promise<BaseBlockTimeCheckResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 1; attempt <= BASE_BLOCK_TIME_CHECK_ATTEMPTS; attempt += 1) {
    const result = await check()
    if (!isReadFailure(result) || attempt === BASE_BLOCK_TIME_CHECK_ATTEMPTS) return result
    await sleep(BASE_BLOCK_TIME_RETRY_DELAY_MS)
  }
  throw new Error('Base block-time retry loop exhausted unexpectedly')
}

/**
 * Check the average cadence over the latest 1,000 Base blocks. Only a pass is cached, and never for 60 seconds or
 * longer; every failure is retried on the next request. The 5% tolerance absorbs whole-second timestamp granularity.
 */
export function makeBaseBlockTimeChecker(
  reader: BaseBlockTimeReader,
  opts: { now?: () => number; floorSecs?: number; passCacheMs?: number } = {},
): BaseBlockTimeCheck {
  const now = opts.now ?? Date.now
  const floorSecs = opts.floorSecs ?? BASE_BLOCK_SECS_FLOOR
  const passCacheMs = opts.passCacheMs ?? BASE_BLOCK_TIME_PASS_CACHE_MS
  if (!Number.isFinite(floorSecs) || floorSecs < MIN_BASE_BLOCK_SECS_FLOOR || floorSecs > DEFAULT_BASE_BLOCK_SECS_FLOOR) {
    throw new Error(`Base block-time checker floorSecs must be in [${MIN_BASE_BLOCK_SECS_FLOOR}, ${DEFAULT_BASE_BLOCK_SECS_FLOOR}]`)
  }
  if (!Number.isSafeInteger(passCacheMs) || passCacheMs < 0 || passCacheMs > BASE_BLOCK_TIME_PASS_CACHE_MS) {
    throw new Error(`Base block-time checker passCacheMs must be a safe integer in [0, ${BASE_BLOCK_TIME_PASS_CACHE_MS}]`)
  }

  let cachedPass: { checkedAtMs: number; result: Extract<BaseBlockTimeCheckResult, { ok: true }> } | undefined
  let inFlight: Promise<BaseBlockTimeCheckResult> | undefined
  return (): Promise<BaseBlockTimeCheckResult> => {
    const checkedAtMs = now()
    if (!Number.isSafeInteger(checkedAtMs) || checkedAtMs < 0) {
      return Promise.resolve({ ok: false, retryable: true, reason: `Base block-time check clock is invalid (${String(checkedAtMs)})` })
    }
    if (cachedPass && checkedAtMs >= cachedPass.checkedAtMs && checkedAtMs - cachedPass.checkedAtMs < passCacheMs) {
      return Promise.resolve(cachedPass.result)
    }
    if (inFlight) return inFlight

    const current = (async (): Promise<BaseBlockTimeCheckResult> => {
      try {
        const head = await reader.currentBlockNumber()
        if (typeof head !== 'bigint' || head < BASE_BLOCK_TIME_SAMPLE_BLOCKS) {
          return { ok: false, retryable: true, reason: `Base block-time check needs a head of at least ${BASE_BLOCK_TIME_SAMPLE_BLOCKS} (got ${String(head)})` }
        }
        const sampledFrom = head - BASE_BLOCK_TIME_SAMPLE_BLOCKS
        const [headTimestamp, oldTimestamp] = await Promise.all([
          reader.blockTimestamp(head),
          reader.blockTimestamp(sampledFrom),
        ])
        if (!Number.isSafeInteger(headTimestamp) || headTimestamp < 0 ||
            !Number.isSafeInteger(oldTimestamp) || oldTimestamp < 0) {
          return { ok: false, retryable: true, reason: `Base block-time check received invalid timestamps head=${String(headTimestamp)} old=${String(oldTimestamp)}` }
        }
        const elapsedSecs = headTimestamp - oldTimestamp
        if (elapsedSecs <= 0) {
          return { ok: false, retryable: true, reason: `Base block-time check timestamps are not increasing (head=${headTimestamp}, head-1000=${oldTimestamp})` }
        }
        const secondsPerBlock = elapsedSecs / Number(BASE_BLOCK_TIME_SAMPLE_BLOCKS)
        const minimum = floorSecs * BASE_BLOCK_TIME_TOLERANCE
        if (secondsPerBlock < minimum) {
          return {
            ok: false,
            retryable: true,
            reason: `Base is producing blocks too quickly for this build: ${secondsPerBlock.toFixed(3)}s/block over the latest ${BASE_BLOCK_TIME_SAMPLE_BLOCKS} blocks; minimum supported is ${minimum.toFixed(3)}s/block (${floorSecs}s floor with 5% tolerance)`,
          }
        }
        const result = { ok: true as const, secondsPerBlock, head, sampledFrom }
        cachedPass = { checkedAtMs, result }
        return result
      } catch (error) {
        return { ok: false, retryable: true, reason: `Base block-time check read failed (fail-closed): ${safeReadError(error)}` }
      }
    })()
    const shared = current.finally(() => {
      if (inFlight === shared) inFlight = undefined
    })
    inFlight = shared
    return shared
  }
}
