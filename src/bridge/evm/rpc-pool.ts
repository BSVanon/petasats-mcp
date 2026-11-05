import { type Transport } from 'viem'
import { BASE_MAINNET_CHAIN_ID, BASE_RPC_UNVERIFIED_CRITICAL_AFTER_MS, DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS, DEFAULT_BASE_RPC_MAX_HEAD_LAG_BLOCKS, baseRpcTransport, describeBaseSendRpc, resolveBaseRpcDegradedProbeIntervalMs, resolveBaseRpcMaxHeadLagBlocks, resolveBaseRpcProbeIntervalMs, resolveBaseRpcUrlsForChain } from './rpc-config'
import { BASE_RPC_MAX_LOG_CHUNKS, type BaseRpcProbeResult, probeBaseRpcEndpoint, rpcProbeCall } from './rpc-probe'
import { guardLookup } from './lookup-refusal'
import { baseSendTransport, requestRawTransactionSnapshot } from './rpc-send'
/**
 * The live endpoint set for a Base-mainnet process.  A request takes a snapshot of
 * the current list before it starts; a completed probe replaces that snapshot in
 * one assignment, so no request is ever routed through a half-updated list.
 *
 * This deliberately owns only provider availability.  Callers still own their
 * business-level startup gates (contract identity, nonce state, etc.).
 */
export class BaseRpcFailoverPool {
  private active: readonly string[]
  /** Safe active endpoints and the numeric spans at which the latest completed probe admitted their log searches. */
  private activeLogEndpoints: readonly { url: string; maxSpan: bigint }[] = []
  /** True while log searches use an endpoint retained after a transient probe failure. */
  private logRetentionActive = false
  private timer?: ReturnType<typeof setTimeout>
  private probing?: Promise<void>
  private started = false
  private completedProbe = false
  private split = false
  private safetyExclusion = false
  private unverified = false
  private unverifiedSince?: number
  private logUnverifiedSince?: number
  private nextDelayMs: number
  private readonly transports = new Map<string, Transport>()
  private readonly sendTransports = new Map<string, Transport>()

  constructor(private readonly opts: {
    urls: readonly string[]
    swapAddress: string
    probeIntervalMs: number
    alert: (message: string) => void
    log?: (message: string) => void
    fetchImpl?: typeof fetch
    /** Test seam: production uses the normal bounded read retry schedule. */
    retryDelayMs?: number
    maxHeadLagBlocks?: number
    degradedProbeIntervalMs?: number
    now?: () => number
  }) {
    if (!opts.urls.length) throw new Error('BaseRpcFailoverPool requires at least one RPC URL')
    if (!Number.isSafeInteger(opts.maxHeadLagBlocks ?? DEFAULT_BASE_RPC_MAX_HEAD_LAG_BLOCKS) ||
        (opts.maxHeadLagBlocks ?? DEFAULT_BASE_RPC_MAX_HEAD_LAG_BLOCKS) < 0) {
      throw new Error('BaseRpcFailoverPool maxHeadLagBlocks must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(opts.degradedProbeIntervalMs ?? DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS) ||
        (opts.degradedProbeIntervalMs ?? DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS) < 10_000 ||
        (opts.degradedProbeIntervalMs ?? DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS) > 3_600_000) {
      throw new Error('BaseRpcFailoverPool degradedProbeIntervalMs must be a safe integer from 10000 through 3600000')
    }
    this.active = [...opts.urls]
    this.nextDelayMs = opts.probeIntervalMs
  }

  /** A viem transport whose individual requests use the endpoint-list snapshot current at request start. */
  readonly transport: Transport = (config) => {
    const initial = this.makeTransport(this.active)(config)
    const requestSnapshot = async (urls: readonly string[], args: Parameters<typeof initial.request>[0]): Promise<{ url: string, proofUrl?: string, result: unknown }> => {
      let failure: unknown
      for (const url of urls) {
        try {
          const result = await this.makeTransport([url])(config).request(args)
          return { url, result }
        } catch (error) { failure = error }
      }
      throw failure ?? new Error('Base RPC request has no active endpoint')
    }
    const requestSendSnapshot = async (urls: readonly string[], args: Parameters<typeof initial.request>[0]): Promise<{ url: string, proofUrl?: string, result: unknown }> => {
      return requestRawTransactionSnapshot(urls, (url) => this.makeSendTransport(url)(config).request(args))
    }
    const requestLogSnapshot = async (
      endpoints: readonly { url: string; maxSpan: bigint }[],
      ordinaryUrls: readonly string[],
      args: Parameters<typeof initial.request>[0],
    ): Promise<{ url: string, proofUrl?: string, result: unknown }> => {
      const params = (args as { params?: readonly unknown[] }).params
      const filter = params?.[0]
      const record = typeof filter === 'object' && filter !== null ? filter as Record<string, unknown> : undefined
      const parseBlock = (value: unknown): bigint | undefined => {
        if (typeof value === 'bigint' && value >= 0n) return value
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
        if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) return BigInt(value)
        return undefined
      }
      const fromBlock = record ? parseBlock(record.fromBlock) : undefined
      const toBlock = record ? parseBlock(record.toBlock) : undefined
      const numericRange = record !== undefined && !Object.prototype.hasOwnProperty.call(record, 'blockHash') &&
        fromBlock !== undefined && toBlock !== undefined && fromBlock <= toBlock
      const preferred = [...endpoints].sort((left, right) => left.maxSpan === right.maxSpan ? 0 : left.maxSpan > right.maxSpan ? -1 : 1)

      if (!numericRange) {
        // Tags, omitted bounds, blockHash filters, and malformed/reversed ranges retain one-call provider behaviour.
        // Prefer the most capable active endpoints because their unknown effective range is the least likely to refuse.
        return requestSnapshot(preferred.map((endpoint) => endpoint.url), args)
      }

      const span = toBlock - fromBlock + 1n
      const bestChunkCount = (span + preferred[0].maxSpan - 1n) / preferred[0].maxSpan
      if (bestChunkCount > BigInt(BASE_RPC_MAX_LOG_CHUNKS)) {
        throw new Error(`Base RPC log request needs ${bestChunkCount} chunks, exceeding the maximum ${BASE_RPC_MAX_LOG_CHUNKS}; no active endpoint can serve this range`)
      }

      const proofArgs = {
        method: 'eth_getBlockByNumber', params: [`0x${toBlock.toString(16)}`, false],
      } as Parameters<typeof initial.request>[0]
      let ordinary: { url: string; proofUrl?: string; result: unknown }
      try { ordinary = await requestSnapshot(ordinaryUrls, proofArgs) }
      catch { throw new Error('Base RPC has no active endpoint that serves log searches') }
      const ordinaryHash = typeof ordinary.result === 'object' && ordinary.result !== null
        ? (ordinary.result as { hash?: unknown }).hash : undefined
      if (typeof ordinaryHash !== 'string') throw new Error('Base RPC has no active endpoint that serves log searches')

      let requestFailure: unknown
      let proofPassed = false
      for (const endpoint of preferred) {
        let endpointBlock = ordinary.result
        if (endpoint.url !== ordinary.url) {
          try { endpointBlock = await this.makeTransport([endpoint.url])(config).request(proofArgs) }
          catch { continue }
        }
        const endpointHash = typeof endpointBlock === 'object' && endpointBlock !== null
          ? (endpointBlock as { hash?: unknown }).hash : undefined
        if (typeof endpointHash !== 'string' || endpointHash.toLowerCase() !== ordinaryHash.toLowerCase()) continue
        proofPassed = true

        if (endpoint.maxSpan >= span) {
          try {
            const result = await this.makeTransport([endpoint.url])(config).request(args)
            if (!Array.isArray(result)) throw new Error('Base RPC log request returned a malformed result')
            return { url: endpoint.url, proofUrl: ordinary.url, result }
          } catch (error) {
            requestFailure = error
            continue
          }
        }

        const chunkCount = (span + endpoint.maxSpan - 1n) / endpoint.maxSpan
        if (chunkCount > BigInt(BASE_RPC_MAX_LOG_CHUNKS)) continue
        const logs: unknown[] = []
        for (let chunkFrom = fromBlock; chunkFrom <= toBlock; chunkFrom += endpoint.maxSpan) {
          const chunkTo = chunkFrom + endpoint.maxSpan - 1n < toBlock ? chunkFrom + endpoint.maxSpan - 1n : toBlock
          const chunkArgs = {
            ...args,
            params: [
              { ...record, fromBlock: `0x${chunkFrom.toString(16)}`, toBlock: `0x${chunkTo.toString(16)}` },
              ...(params?.slice(1) ?? []),
            ],
          } as Parameters<typeof initial.request>[0]
          // Every chunk stays on this one endpoint. Any error (including malformed partial data) rejects the whole call.
          const result = await this.makeTransport([endpoint.url])(config).request(chunkArgs)
          if (!Array.isArray(result)) throw new Error('Base RPC log chunk returned a malformed result')
          logs.push(...result)
        }
        return { url: endpoint.url, proofUrl: ordinary.url, result: logs }
      }
      if (proofPassed && requestFailure) throw requestFailure
      throw new Error('Base RPC has no active endpoint that serves log searches')
    }
    return {
      ...initial,
      request: async (args) => guardLookup(args.method, async () => {
        const logRequest = args.method === 'eth_getLogs'
        const sendRequest = args.method === 'eth_sendRawTransaction'
        const ordinarySnapshot = this.active
        const snapshot = logRequest ? this.activeLogEndpoints : ordinarySnapshot
        if (snapshot.length === 0) {
          throw new Error(logRequest ? 'Base RPC has no active endpoint that serves log searches' : 'Base RPC request has no active endpoint')
        }
        const first = logRequest
          ? await requestLogSnapshot(snapshot as readonly { url: string; maxSpan: bigint }[], ordinarySnapshot, args)
          : sendRequest
            ? await requestSendSnapshot(snapshot as readonly string[], args)
            : await requestSnapshot(snapshot as readonly string[], args)
        // A valid raw-send hash is final evidence for these exact bytes; never let an active-set replay replace it
        // with a later definite rejection. The inflight layer verifies it against the locally computed hash.
        if (sendRequest) return first.result as never
        const currentUrls = logRequest ? this.activeLogEndpoints.map((endpoint) => endpoint.url) : this.active
        if (currentUrls.includes(first.url) && (!first.proofUrl || this.active.includes(first.proofUrl))) return first.result as never

        // The probe atomically replaced the snapshot while this read was in flight. Never return a response from an
        // endpoint now known unsafe; replay once through the current ordered set, and fail closed if it disappeared too.
        const current = logRequest ? this.activeLogEndpoints : this.active
        if (current.length === 0) throw new Error('Base RPC response came from an endpoint no longer active and no current endpoint is safe')
        const retried = logRequest
          ? await requestLogSnapshot(current as readonly { url: string; maxSpan: bigint }[], this.active, args)
          : await requestSnapshot(current as readonly string[], args)
        const finalUrls = logRequest ? this.activeLogEndpoints.map((endpoint) => endpoint.url) : this.active
        if (!finalUrls.includes(retried.url) || (retried.proofUrl && !this.active.includes(retried.proofUrl))) {
          throw new Error('Base RPC retry response came from an endpoint no longer active')
        }
        return retried.result as never
      }),
    }
  }

  get activeUrls(): readonly string[] { return this.active }
  /** True only while finalized-hash reports lack a strict majority. Reads continue; new value must not be committed. */
  isSplit(): boolean { return this.split }
  /** True when this probe excluded a configured endpoint for wrong-chain/finality disagreement or excessive head lag. */
  hasSafetyExclusion(): boolean { return this.safetyExclusion }
  /** True when recovery reads are using a retained set that this probe could not verify, no endpoint is active, or log detection cannot run. */
  isUnverified(): boolean { return this.unverified || this.logRetentionActive || this.active.length === 0 || this.activeLogEndpoints.length === 0 }
  /** Exposed for deterministic lifecycle tests and operational status. */
  get nextProbeDelayMs(): number { return this.nextDelayMs }

  private makeTransport(urls: readonly string[]): Transport {
    const key = urls.join('\u0000')
    let transport = this.transports.get(key)
    if (!transport) {
      transport = baseRpcTransport(urls, this.opts.fetchImpl, this.opts.retryDelayMs)
      this.transports.set(key, transport)
    }
    return transport
  }

  private makeSendTransport(url: string): Transport {
    let transport = this.sendTransports.get(url)
    if (!transport) {
      transport = baseSendTransport(url, this.opts.fetchImpl)
      this.sendTransports.set(url, transport)
    }
    return transport
  }

  /** Probe immediately; concurrent callers share one pass so endpoint snapshots cannot race. */
  async probeNow(): Promise<void> {
    if (this.probing) return this.probing
    this.probing = this.performProbe()
    try { await this.probing } finally { this.probing = undefined }
  }

  private async performProbe(): Promise<void> {
    const hadPreviousSet = this.completedProbe
    const results = await Promise.all(this.opts.urls.map((url) => probeBaseRpcEndpoint({
      url, swapAddress: this.opts.swapAddress, fetchImpl: this.opts.fetchImpl,
    })))
    const previous = new Set(this.active)
    const previousLogEndpoints = new Map(this.activeLogEndpoints.map((endpoint) => [endpoint.url, endpoint]))
    const transientlyFailedPrevious = new Map<string, string>()
    const transientFailures = new Set<string>()
    const safetyFailures = new Set<string>()
    const headLagFailures = new Set<string>()
    let degraded = false
    const retainTransient = (url: string, reason: string): void => {
      transientFailures.add(url)
      if (hadPreviousSet && previous.has(url)) {
        transientlyFailedPrevious.set(url, reason)
        degraded = true
      } else {
        degraded = true
        this.opts.alert(`[base-rpc] excluding ${describeBaseSendRpc(url)}: ${reason}`)
      }
    }
    for (const result of results.filter((result) => !result.ok)) {
      if (result.failure === 'safety') {
        safetyFailures.add(result.url)
        degraded = true
        this.opts.alert(`[base-rpc] excluding ${describeBaseSendRpc(result.url)}: ${result.reason ?? 'safety probe failure'}`)
      } else retainTransient(result.url, result.reason ?? 'transient probe failure')
    }
    const passing = results.filter((result) => result.ok)
    for (const result of passing.filter((result) => !result.logs)) {
      this.opts.log?.(`[base-rpc] ${describeBaseSendRpc(result.url)} does not serve log searches`)
    }
    const maxLag = BigInt(this.opts.maxHeadLagBlocks ?? DEFAULT_BASE_RPC_MAX_HEAD_LAG_BLOCKS)
    const highestHead = passing.length
      ? passing.reduce((height, result) => result.latestNumber! > height ? result.latestNumber! : height, passing[0].latestNumber!)
      : 0n
    const timely = passing.filter((result) => {
      const lag = highestHead - result.latestNumber!
      if (lag <= maxLag) return true
      headLagFailures.add(result.url)
      degraded = true
      this.opts.alert(`[base-rpc] excluding ${describeBaseSendRpc(result.url)}: latest block lags highest observed latest head by ${lag} blocks (maximum ${maxLag})`)
      return false
    })
    let hashes: Array<{ result: BaseRpcProbeResult; hash?: string }> = []
    let commonHeight: bigint | undefined
    if (timely.length) {
      // Finalized heads can differ by a block. Compare the hash at the lowest common
      // finalized height, rather than comparing two different heights.
      commonHeight = timely.reduce((height, result) => result.finalizedNumber! < height ? result.finalizedNumber! : height, timely[0].finalizedNumber!)
      hashes = await Promise.all(timely.map(async (result) => {
        try {
          const block = await rpcProbeCall(result.url, 'eth_getBlockByNumber', [`0x${commonHeight!.toString(16)}`, false], this.opts.fetchImpl ?? fetch) as { hash?: string } | null
          if (!block?.hash) throw new Error('finalized hash missing')
          return { result, hash: block.hash.toLowerCase() }
        } catch (error) {
          retainTransient(result.url, `finalized hash cross-check failed: ${error instanceof Error ? error.message : String(error)}`)
          return { result, hash: undefined }
        }
      }))
    }
    const byHash = new Map<string, typeof hashes>()
    for (const item of hashes) if (item.hash) byHash.set(item.hash, [...(byHash.get(item.hash) ?? []), item])
    const primary = hashes.find((item) => item.result.url === this.opts.urls[0])
    const groups = [...byHash.values()]
    const largest = Math.max(...groups.map((group) => group.length), 0)
    const leaders = groups.filter((group) => group.length === largest)
    const winner = leaders.find((group) => group.some((item) => item === primary)) ?? (leaders.length === 1 ? leaders[0] : undefined)
    const returnedHashes = hashes.filter((item) => item.hash)
    this.split = returnedHashes.length >= 2 && groups.length >= 2 && largest * 2 <= returnedHashes.length
    if (this.split) {
      degraded = true
      this.opts.alert(`[base-rpc] CRITICAL: finalized hash split at block ${commonHeight}; no hash group has a strict majority, retaining the primary group for recovery reads`)
    }
    const selected = winner?.map((item) => item.result.url) ?? []
    for (const item of returnedHashes) {
      if (!winner?.includes(item)) {
        safetyFailures.add(item.result.url)
        degraded = true
        this.opts.alert(`[base-rpc] excluding ${describeBaseSendRpc(item.result.url)}: finalized hash disagrees at block ${commonHeight}`)
      }
    }
    if (winner && !winner.some((item) => item.result.deepReceipts)) {
      this.opts.alert('[base-rpc] no passing endpoint serves deep receipts; fresh receipts remain usable but reconciliation will fail closed on unavailable receipts')
    }
    if (winner && !selected.includes(this.opts.urls[0])) this.opts.alert('[base-rpc] primary endpoint failed or disagreed; operating on vetted fallback endpoint(s)')
    // A winning group is the proof that makes these endpoints safe for NEW BSV risk.
    // Retention is recovery liveness only: use it exclusively when this entire probe
    // could not establish even one winner, never alongside a verified group.
    const retained = selected.length === 0 ? [...transientlyFailedPrevious.keys()] : []
    if (retained.length) {
      for (const url of retained) {
        this.opts.alert(`[base-rpc] retaining ${describeBaseSendRpc(url)} after transient probe failure: ${transientlyFailedPrevious.get(url)}; no endpoint passed every check in this probe, so it is recovery-only`)
      }
    } else if (selected.length) {
      for (const [url, reason] of transientlyFailedPrevious) {
        this.opts.alert(`[base-rpc] excluding ${describeBaseSendRpc(url)}: ${reason}`)
      }
    }
    const activeSet = new Set(selected.length ? selected : retained)
    const next = this.opts.urls.filter((url) => activeSet.has(url) && !safetyFailures.has(url))
    const winnerLogCapable = new Map((winner ?? []).filter((item) => item.result.logs && item.result.maxLogSpan !== undefined)
      .map((item) => [item.result.url, { url: item.result.url, maxSpan: item.result.maxLogSpan! }]))
    // A log-capable winner is the only fresh proof that an endpoint may accept new-risk log searches.
    const verifiedLog = this.opts.urls.flatMap((url) => next.includes(url) && winnerLogCapable.has(url) ? [winnerLogCapable.get(url)!] : [])
    const resultByUrl = new Map(results.map((result) => [result.url, result]))
    // If that proof is temporarily unavailable, recovery may continue its event scans through the last
    // log-capable endpoint, but only if this probe did not find a safety problem with it.  This set is
    // intentionally independent from `active`: a no-logs winner can serve ordinary reads by itself.
    const retainedLog = verifiedLog.length || !hadPreviousSet ? [] : this.opts.urls.flatMap((url) => {
      const result = resultByUrl.get(url)
      const previousEndpoint = previousLogEndpoints.get(url)
      const retainedEndpoint = result?.ok && result.logs && result.maxLogSpan !== undefined
        ? { url, maxSpan: result.maxLogSpan }
        : previousEndpoint
      return previousEndpoint && !safetyFailures.has(url) &&
        (Boolean(result?.ok && !result.logs) || transientFailures.has(url) ||
          Boolean(result?.ok && result.logs && headLagFailures.has(url))) ? [retainedEndpoint!] : []
    })
    const nextLogEndpoints = verifiedLog.length ? verifiedLog : retainedLog
    if (!verifiedLog.length) degraded = true
    const nextUnverified = selected.length === 0
    const now = (this.opts.now ?? Date.now)()
    if (nextUnverified) {
      if (this.unverifiedSince === undefined) this.unverifiedSince = now
    } else {
      this.unverifiedSince = undefined
    }
    if (!verifiedLog.length) {
      if (this.logUnverifiedSince === undefined) this.logUnverifiedSince = now
    } else {
      this.logUnverifiedSince = undefined
    }
    this.unverified = nextUnverified
    const alertLongUnverified = (): void => {
      if (this.unverifiedSince === undefined || now - this.unverifiedSince <= BASE_RPC_UNVERIFIED_CRITICAL_AFTER_MS) return
      const hosts = next.length ? next.map(describeBaseSendRpc).join(', ') : 'none'
      this.opts.alert(`[base-rpc] CRITICAL: Base RPC endpoints have remained unverified for over 10 minutes; retained hosts: ${hosts}`)
    }
    const alertLongLogUnverified = (): void => {
      if (this.logUnverifiedSince === undefined || now - this.logUnverifiedSince <= BASE_RPC_UNVERIFIED_CRITICAL_AFTER_MS) return
      this.opts.alert('[base-rpc] CRITICAL: no endpoint has passed a log search check for over 10 minutes; new risk paused')
    }
    this.safetyExclusion = safetyFailures.size > 0 || headLagFailures.size > 0
    if (!next.length) {
      this.active = [] // atomic endpoint-list swap; requests after this point fail closed.
      this.activeLogEndpoints = []
      this.logRetentionActive = false
      this.completedProbe = true
      this.nextDelayMs = this.opts.degradedProbeIntervalMs ?? DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS
      alertLongUnverified()
      alertLongLogUnverified()
      this.opts.alert('[base-rpc] no active endpoint serves log searches; new risk paused')
      throw new Error('Base RPC probe found no endpoint safe to serve or trade')
    }
    if (next.length !== this.opts.urls.length || retained.length || safetyFailures.size) degraded = true
    this.active = next // atomic endpoint-list swap; in-flight requests retain their prior snapshot.
    this.activeLogEndpoints = nextLogEndpoints
    this.logRetentionActive = retainedLog.length > 0
    this.completedProbe = true
    this.nextDelayMs = degraded ? (this.opts.degradedProbeIntervalMs ?? DEFAULT_BASE_RPC_DEGRADED_PROBE_INTERVAL_MS) : this.opts.probeIntervalMs
    alertLongUnverified()
    alertLongLogUnverified()
    if (retainedLog.length) {
      const retainedOnlyForHeadLag = retainedLog.every((endpoint) => headLagFailures.has(endpoint.url))
      this.opts.alert(`[base-rpc] keeping ${retainedLog.map((endpoint) => describeBaseSendRpc(endpoint.url)).join(', ')} for log searches only after ${retainedOnlyForHeadLag ? 'a head-lag exclusion' : 'a transient probe failure'}; new risk paused`)
    } else if (nextLogEndpoints.length === 0) {
      this.opts.alert('[base-rpc] no active endpoint serves log searches; new risk paused')
    }
    this.opts.log?.(`[base-rpc] active endpoints: ${next.map(describeBaseSendRpc).join(', ')}`)
  }

  async start(): Promise<void> {
    await this.probeNow()
    this.started = true
    this.scheduleNextProbe()
  }

  private scheduleNextProbe(): void {
    if (!this.started) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.probeNow()
        .catch((error) => this.opts.alert(`[base-rpc] periodic probe failed; active endpoints are fail-closed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.scheduleNextProbe())
    }, this.nextDelayMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

export function makeBaseRpcUnsafeForNewRisk(
  pool: Pick<BaseRpcFailoverPool, 'isSplit' | 'isUnverified' | 'hasSafetyExclusion'>,
): () => boolean {
  return () => pool.isSplit() || pool.isUnverified() || pool.hasSafetyExclusion()
}

/** Build the common mainnet probe/pool lifecycle from environment configuration. */
export function makeBaseRpcFailoverPool(args: {
  env?: Record<string, string | undefined>
  swapAddress: string
  alert: (message: string) => void
  log?: (message: string) => void
  override?: string
  fetchImpl?: typeof fetch
}): BaseRpcFailoverPool {
  const env = args.env ?? process.env
  return new BaseRpcFailoverPool({
    urls: resolveBaseRpcUrlsForChain(BASE_MAINNET_CHAIN_ID, env, args.override),
    swapAddress: args.swapAddress,
    probeIntervalMs: resolveBaseRpcProbeIntervalMs(env),
    alert: args.alert,
    log: args.log,
    fetchImpl: args.fetchImpl,
    maxHeadLagBlocks: resolveBaseRpcMaxHeadLagBlocks(env),
    degradedProbeIntervalMs: resolveBaseRpcDegradedProbeIntervalMs(env),
  })
}
