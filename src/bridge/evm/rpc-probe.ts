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

/** Largest-first: publicnode accepts 2,000 blocks (~6m40s); dRPC accepts 100 blocks (~20s) at the supported floor. */
export const BASE_RPC_LOG_SPAN_LADDER = [2_000n, 100n] as const
/** Bound one caller request to 4,000 blocks (~13m20s) on a 100-block-only endpoint. */
export const BASE_RPC_MAX_LOG_CHUNKS = 40
const BASE_RPC_LOG_ANCHOR_TX_LIMIT = 8

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
}): Promise<void> {
  const anchorHex = `0x${args.anchorBlock.toString(16)}`
  const block = await rpcProbeCall(args.url, 'eth_getBlockByNumber', [anchorHex, false], args.fetchImpl) as RpcBlock | null
  if (!sameRpcField(block?.number, anchorHex)) throw new Error(`log anchor block ${anchorHex} returned the wrong block number`)
  if (typeof block?.hash !== 'string') throw new Error(`log anchor block ${anchorHex} is missing its hash`)
  const transactions = block?.transactions
  if (!Array.isArray(transactions)) throw new Error(`log anchor block ${anchorHex} is missing transactions`)

  let expected: RpcLog | undefined
  // Transaction zero is the Base deposit transaction.  It is deliberately skipped because its special receipt is
  // not representative of ordinary application-log history.
  for (const transaction of transactions.slice(1, 1 + BASE_RPC_LOG_ANCHOR_TX_LIMIT)) {
    const hash = typeof transaction === 'string' ? transaction : transaction?.hash
    if (typeof hash !== 'string') continue
    const receipt = await rpcProbeCall(args.url, 'eth_getTransactionReceipt', [hash], args.fetchImpl) as {
      transactionHash?: string
      blockNumber?: string
      blockHash?: string
      logs?: unknown
    } | null
    if (receipt && (!sameRpcField(receipt.transactionHash, hash) ||
        !sameRpcField(receipt.blockNumber, anchorHex) || !sameRpcField(receipt.blockHash, block.hash))) {
      throw new Error(`log anchor block ${anchorHex} returned a receipt outside the requested transaction and block`)
    }
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

  const result = await rpcProbeCall(args.url, 'eth_getLogs', [{
    address: expected.address,
    topics: expected.topics,
    fromBlock: `0x${args.fromBlock.toString(16)}`,
    toBlock: `0x${args.toBlock.toString(16)}`,
  }], args.fetchImpl)
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
}): Promise<void> {
  const offset = args.toBlock - args.fromBlock >= 18n ? 9n : 0n
  await proveLogAnchor({ ...args, anchorBlock: args.fromBlock + offset })
  await proveLogAnchor({ ...args, anchorBlock: args.toBlock - offset })
}

/** Probe log history with two receipt-backed anchors; an empty/clipped success is never capability evidence. */
export async function probeBaseRpcEndpoint(args: { url: string; swapAddress: string; fetchImpl?: typeof fetch }): Promise<BaseRpcProbeResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  try {
    if (await rpcProbeCall(args.url, 'eth_chainId', [], fetchImpl) !== '0x2105') {
      return { url: args.url, ok: false, logs: false, deepReceipts: false, failure: 'safety', reason: 'wrong chain id' }
    }
    const safe = await rpcProbeCall(args.url, 'eth_getBlockByNumber', ['safe', false], fetchImpl)
    const finalized = await rpcProbeCall(args.url, 'eth_getBlockByNumber', ['finalized', false], fetchImpl) as { number?: string; hash?: string } | null
    if (!safe || !finalized?.number || !finalized.hash) throw new Error('safe or finalized block missing')
    const latest = await rpcProbeCall(args.url, 'eth_blockNumber', [], fetchImpl)
    if (typeof latest !== 'string') throw new Error('latest block missing')
    const finalizedNumber = BigInt(finalized.number)
    const latestNumber = BigInt(latest)
    let maxLogSpan: bigint | undefined
    let logsReason: string | undefined
    for (const candidateSpan of BASE_RPC_LOG_SPAN_LADDER) {
      const fromBlock = finalizedNumber >= candidateSpan - 1n ? finalizedNumber - candidateSpan + 1n : 0n
      try {
        await proveLogSpan({ url: args.url, fromBlock, toBlock: finalizedNumber, fetchImpl })
        maxLogSpan = finalizedNumber - fromBlock + 1n
        break
      } catch (error) {
        logsReason = error instanceof Error ? error.message : String(error)
      }
    }
    // Hashes only: the full-transaction form of a busy Base block can take over 10 s on a free endpoint and time the probe out.
    const oldBlock = await rpcProbeCall(args.url, 'eth_getBlockByNumber', [`0x${(finalizedNumber > 200n ? finalizedNumber - 200n : 0n).toString(16)}`, false], fetchImpl) as { transactions?: Array<string | { hash?: string }> } | null
    const tx = oldBlock?.transactions?.[0]
    const hash = typeof tx === 'string' ? tx : tx?.hash
    // An empty old block gives no evidence of historical receipt support. Treat
    // it conservatively as shallow-only rather than calling the endpoint deep.
    const deepReceipts = Boolean(hash)
    if (hash) await rpcProbeCall(args.url, 'eth_getTransactionReceipt', [hash], fetchImpl)
    return {
      url: args.url, ok: true, logs: maxLogSpan !== undefined,
      ...(maxLogSpan !== undefined ? { maxLogSpan } : {}),
      ...(logsReason && maxLogSpan === undefined ? { logsReason } : {}),
      deepReceipts, finalizedNumber, finalizedHash: finalized.hash, latestNumber,
    }
  } catch (error) {
    return { url: args.url, ok: false, logs: false, deepReceipts: false, failure: 'transient', reason: error instanceof Error ? error.message : String(error) }
  }
}
