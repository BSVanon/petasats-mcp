import { hexToBigInt, type Hex } from 'viem'
import { base } from 'viem/chains'

export const BASE_TIP_HISTORY_BLOCKS = 10
export const BASE_TIP_REWARD_PERCENTILE = 50
export const BASE_TIP_CEILING_WEI = 100_000_000n
export const BASE_TIP_HISTORY_TIMEOUT_MS = 5_000

type RpcClient = {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

/** A canonical JSON-RPC QUANTITY (`0x0`, or `0x` + hex digits without a leading zero); anything else is not read. */
function quantity(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(value)) return undefined
  return BigInt(value)
}

/** The upper median of the recent blocks' 50th-percentile tips, or undefined when history is unreadable or slow. */
async function recentIncludedTip(client: RpcClient, timeoutMs: number): Promise<bigint | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      client.request({
        method: 'eth_feeHistory',
        params: [`0x${BASE_TIP_HISTORY_BLOCKS.toString(16)}`, 'latest', [BASE_TIP_REWARD_PERCENTILE]],
      }),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); timer.unref?.() }),
    ])
    const reward = typeof response === 'object' && response !== null && 'reward' in response
      ? (response as { reward?: unknown }).reward
      : undefined
    if (!Array.isArray(reward)) return undefined
    const values = reward
      .map((entry) => Array.isArray(entry) ? quantity(entry[0]) : undefined)
      .filter((value): value is bigint => value !== undefined)
      .sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    return values.length ? values[Math.floor(values.length / 2)] : undefined
  } catch {
    // Fee history is an advisory raise only; its absence must not block a buyer send.
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Raise a buyer send's tip to the median recent Base inclusion tip when the
 * provider's nominal suggestion is below it, capped at BASE_TIP_CEILING_WEI.
 * The suggestion is read and parsed exactly as viem does without a hook
 * (hexToBigInt of eth_maxPriorityFeePerGas). When that read fails this returns
 * null, so viem runs its own gasPrice - baseFee fallback and no history is read;
 * on the buyer's send and fee-estimate paths, which pass viem the block they
 * already read, that is the same requests and result as without the hook. The
 * result is never below the suggestion and never above max(suggestion, ceiling).
 */
export async function baseIncludedTip(client: RpcClient, historyTimeoutMs = BASE_TIP_HISTORY_TIMEOUT_MS): Promise<bigint | null> {
  let suggested: bigint
  try {
    suggested = hexToBigInt(await client.request({ method: 'eth_maxPriorityFeePerGas' }) as Hex)
  } catch {
    return null
  }
  const historyTip = await recentIncludedTip(client, historyTimeoutMs)
  if (historyTip === undefined) return suggested
  const raised = historyTip < BASE_TIP_CEILING_WEI ? historyTip : BASE_TIP_CEILING_WEI
  return raised > suggested ? raised : suggested
}

/** Base with a buyer-only included-tip floor; all other Base chain settings stay canonical. */
export const buyerBaseChain = {
  ...base,
  fees: {
    ...(base.fees ?? {}),
    maxPriorityFeePerGas: ({ client }: { client: RpcClient }) => baseIncludedTip(client),
  },
}
