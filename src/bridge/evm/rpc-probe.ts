type RpcReply = { result?: unknown; error?: { code?: number; message?: string } }
type RpcBlock = { number?: string; hash?: string; transactions?: Array<string | { hash?: string }> }
type RpcLog = {
  address?: string
  topics?: unknown
  transactionHash?: string
  logIndex?: string
  blockNumber?: string
  blockHash?: string
}
export type BaseRpcProbeResult = {
  url: string
  ok: boolean
  /** Whether this otherwise-safe endpoint accepts eth_getLogs searches. */
  logs: boolean
  /** Largest inclusive numeric block span accepted by the log-search probe ladder. */
  maxLogSpan?: bigint
  logsReason?: string
  deepReceipts: boolean
  finalizedNumber?: bigint
  finalizedHash?: string
  latestNumber?: bigint
  failure?: 'safety' | 'transient'
  reason?: string
}

/** A hung endpoint must fail its probe, not stall a boot or stack periodic probes. */
const BASE_RPC_PROBE_CALL_TIMEOUT_MS = 15_000
/**
 * One budget for a whole endpoint probe.  Every call of the probe shares it, so a slow or throttling endpoint fails
 * (transient, fail-closed) within it instead of keeping the pool's previous verdict for the sum of per-call timeouts
 * (at most 110 calls of 15 s each).  A healthy probe takes a few seconds.
 */
export const BASE_RPC_PROBE_DEADLINE_MS = 120_000

/** Largest-first: publicnode accepts 2,000 blocks (~6m40s); dRPC accepts 100 blocks (~20s) at the supported floor. */
export const BASE_RPC_LOG_SPAN_LADDER = [2_000n, 100n] as const
/** Bound one caller request to 4,000 blocks (~13m20s) on a 100-block-only endpoint. */
export const BASE_RPC_MAX_LOG_CHUNKS = 40
/**
 * Base blocks begin with deposit transactions (type 0x7e): the L1 attributes deposit and, on every block measured since
 * 2026-11-13, a second one.  Both leading positions are skipped, and a later receipt is evidence only when it states an
 * ordinary transaction type, so a deposit's logs, or a receipt with no or an unknown type, never prove log history.
 */
const BASE_RPC_LOG_ANCHOR_SKIPPED_LEADING_TXS = 2
/** Receipts sampled per anchor block after the skipped positions. */
export const BASE_RPC_LOG_ANCHOR_TX_LIMIT = 24
const BASE_ORDINARY_TX_TYPES = new Set([0, 1, 2, 4])
const isOrdinaryTxType = (type: unknown): boolean =>
  typeof type === 'string' && /^0x[0-9a-f]{1,2}$/i.test(type) && BASE_ORDINARY_TX_TYPES.has(Number.parseInt(type.slice(2), 16))

export async function rpcProbeCall(
  url: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
  opts: { signal?: AbortSignal; timeoutMs?: number; strict?: boolean } = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? BASE_RPC_PROBE_CALL_TIMEOUT_MS)
  const response = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const reply = await response.json() as RpcReply
  if (reply.error) throw new Error(`RPC ${reply.error.code ?? ''} ${reply.error.message ?? ''}`.trim())
  // Opt-in: a reply must be a JSON-RPC 2.0 answer to this request (id 1) that carries a result.
  if (opts.strict && (typeof reply !== 'object' || reply === null || (reply as { jsonrpc?: unknown }).jsonrpc !== '2.0'
    || (reply as { id?: unknown }).id !== 1 || !Object.prototype.hasOwnProperty.call(reply, 'result'))) {
    throw new Error('malformed JSON-RPC reply')
  }
  return reply.result
}

const sameRpcField = (left: unknown, right: unknown): boolean =>
  typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()

function isSameRpcLog(candidate: unknown, expected: RpcLog): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false
  const log = candidate as RpcLog
  return sameRpcField(log.transactionHash, expected.transactionHash) &&
    sameRpcField(log.logIndex, expected.logIndex) &&
    sameRpcField(log.blockNumber, expected.blockNumber) &&
    sameRpcField(log.blockHash, expected.blockHash)
}

async function proveLogAnchor(args: {
  url: string
  anchorBlock: bigint
  fromBlock: bigint
  toBlock: bigint
  fetchImpl: typeof fetch
  signal: AbortSignal
}): Promise<void> {
  const anchorHex = `0x${args.anchorBlock.toString(16)}`
  const call = (method: string, params: unknown[]) => rpcProbeCall(args.url, method, params, args.fetchImpl, { signal: args.signal })
  const block = await call('eth_getBlockByNumber', [anchorHex, false]) as RpcBlock | null
  if (!sameRpcField(block?.number, anchorHex)) throw new Error(`log anchor block ${anchorHex} returned the wrong block number`)
  if (typeof block?.hash !== 'string') throw new Error(`log anchor block ${anchorHex} is missing its hash`)
  const transactions = block?.transactions
  if (!Array.isArray(transactions)) throw new Error(`log anchor block ${anchorHex} is missing transactions`)

  let expected: RpcLog | undefined
  // Deposit receipts are not representative of ordinary application-log history (see the constants above).
  const sample = transactions.slice(BASE_RPC_LOG_ANCHOR_SKIPPED_LEADING_TXS, BASE_RPC_LOG_ANCHOR_SKIPPED_LEADING_TXS + BASE_RPC_LOG_ANCHOR_TX_LIMIT)
  for (const transaction of sample) {
    const hash = typeof transaction === 'string' ? transaction : transaction?.hash
    if (typeof hash !== 'string') continue
    const receipt = await call('eth_getTransactionReceipt', [hash]) as {
      transactionHash?: string
      blockNumber?: string
      blockHash?: string
      type?: unknown
      logs?: unknown
    } | null
    if (receipt && (!sameRpcField(receipt.transactionHash, hash) ||
        !sameRpcField(receipt.blockNumber, anchorHex) || !sameRpcField(receipt.blockHash, block.hash))) {
      throw new Error(`log anchor block ${anchorHex} returned a receipt outside the requested transaction and block`)
    }
    if (!isOrdinaryTxType(receipt?.type)) continue
    if (!Array.isArray(receipt?.logs) || receipt.logs.length === 0) continue
    const candidate = receipt.logs.find((log): log is RpcLog => {
      if (typeof log !== 'object' || log === null) return false
      const value = log as RpcLog
      return typeof value.address === 'string' && Array.isArray(value.topics) &&
        value.topics.every((topic) => typeof topic === 'string') &&
        typeof value.transactionHash === 'string' && typeof value.logIndex === 'string' &&
        typeof value.blockNumber === 'string' && typeof value.blockHash === 'string'
    })
    if (candidate) {
      if (!sameRpcField(candidate.transactionHash, hash) ||
          !sameRpcField(candidate.blockNumber, anchorHex) || !sameRpcField(candidate.blockHash, block.hash)) {
        throw new Error(`log anchor block ${anchorHex} returned a log outside the requested transaction and block`)
      }
      expected = candidate
      break
    }
  }
  if (!expected) throw new Error(`log anchor block ${anchorHex} has no log-bearing transaction in the bounded sample`)

  const result = await call('eth_getLogs', [{
    address: expected.address,
    topics: expected.topics,
    fromBlock: `0x${args.fromBlock.toString(16)}`,
    toBlock: `0x${args.toBlock.toString(16)}`,
  }])
  if (!Array.isArray(result)) throw new Error('malformed log result')
  if (!result.some((log) => isSameRpcLog(log, expected!))) {
    throw new Error(`log anchor block ${anchorHex} was not returned by the full-window query`)
  }
}

async function proveLogSpan(args: {
  url: string
  fromBlock: bigint
  toBlock: bigint
  fetchImpl: typeof fetch
  signal: AbortSignal
}): Promise<void> {
  const offset = args.toBlock - args.fromBlock >= 18n ? 9n : 0n
  await proveLogAnchor({ ...args, anchorBlock: args.fromBlock + offset })
  await proveLogAnchor({ ...args, anchorBlock: args.toBlock - offset })
}

/**
 * Probe log history with two receipt-backed anchors; an empty/clipped success is never capability evidence.
 * Worst case 110 calls, all inside one BASE_RPC_PROBE_DEADLINE_MS budget: 4 head reads, then per ladder rung two
 * anchors of (1 block + BASE_RPC_LOG_ANCHOR_TX_LIMIT receipts + 1 full-window search), then the old block and receipt.
 */
export async function probeBaseRpcEndpoint(args: { url: string; swapAddress: string; fetchImpl?: typeof fetch; deadlineMs?: number }): Promise<BaseRpcProbeResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const signal = AbortSignal.timeout(args.deadlineMs ?? BASE_RPC_PROBE_DEADLINE_MS)
  const call = (method: string, params: unknown[]) => rpcProbeCall(args.url, method, params, fetchImpl, { signal })
  try {
    if (await call('eth_chainId', []) !== '0x2105') {
      return { url: args.url, ok: false, logs: false, deepReceipts: false, failure: 'safety', reason: 'wrong chain id' }
    }
    const safe = await call('eth_getBlockByNumber', ['safe', false])
    const finalized = await call('eth_getBlockByNumber', ['finalized', false]) as { number?: string; hash?: string } | null
    if (!safe || !finalized?.number || !finalized.hash) throw new Error('safe or finalized block missing')
    const latest = await call('eth_blockNumber', [])
    if (typeof latest !== 'string') throw new Error('latest block missing')
    const finalizedNumber = BigInt(finalized.number)
    const latestNumber = BigInt(latest)
    let maxLogSpan: bigint | undefined
    let logsReason: string | undefined
    for (const candidateSpan of BASE_RPC_LOG_SPAN_LADDER) {
      const fromBlock = finalizedNumber >= candidateSpan - 1n ? finalizedNumber - candidateSpan + 1n : 0n
      try {
        await proveLogSpan({ url: args.url, fromBlock, toBlock: finalizedNumber, fetchImpl, signal })
        maxLogSpan = finalizedNumber - fromBlock + 1n
        break
      } catch (error) {
        if (signal.aborted) throw error
        logsReason = error instanceof Error ? error.message : String(error)
      }
    }
    // Hashes only: the full-transaction form of a busy Base block can take over 10 s on a free endpoint and time the probe out.
    const oldBlock = await call('eth_getBlockByNumber', [`0x${(finalizedNumber > 200n ? finalizedNumber - 200n : 0n).toString(16)}`, false]) as { transactions?: Array<string | { hash?: string }> } | null
    const tx = oldBlock?.transactions?.[0]
    const hash = typeof tx === 'string' ? tx : tx?.hash
    // An empty old block gives no evidence of historical receipt support. Treat
    // it conservatively as shallow-only rather than calling the endpoint deep.
    const deepReceipts = Boolean(hash)
    if (hash) await call('eth_getTransactionReceipt', [hash])
    return {
      url: args.url, ok: true, logs: maxLogSpan !== undefined,
      ...(maxLogSpan !== undefined ? { maxLogSpan } : {}),
      ...(logsReason && maxLogSpan === undefined ? { logsReason } : {}),
      deepReceipts, finalizedNumber, finalizedHash: finalized.hash, latestNumber,
    }
  } catch (error) {
    const reason = signal.aborted ? 'probe deadline exceeded' : error instanceof Error ? error.message : String(error)
    return { url: args.url, ok: false, logs: false, deepReceipts: false, failure: 'transient', reason }
  }
}
