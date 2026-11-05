import { http, RpcRequestError, type HttpTransport } from 'viem'
import { describeBaseSendRpc } from './rpc-config'

export type BaseRpcSendAttemptSummary = {
  endpoint: string
  outcome: 'definite' | 'unknown'
  detail: string
}

/** A non-2xx raw-send response is ambiguous even when its body contains a valid JSON-RPC error. */
class BaseRpcSendHttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`raw-send HTTP status ${status}`)
    this.name = 'BaseRpcSendHttpStatusError'
  }
}

/**
 * At least one raw-submit endpoint may have accepted the bytes without returning a JSON-RPC result. Keep the
 * message deliberately classification-neutral: detailed endpoint outcomes live on `attempts`, where a later
 * definite error cannot be mistaken for the aggregate outcome by the send-engine matchers.
 */
export class BaseRpcUnknownSendError extends Error {
  constructor(readonly attempts: readonly BaseRpcSendAttemptSummary[]) {
    super(`Base RPC raw transaction outcome is ambiguous across ${attempts.length} endpoint attempt(s); retain the durable send record`)
    this.name = 'BaseRpcUnknownSendError'
  }
}

function statusAwareSendFetch(inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init)
    if (response.ok) return response
    const status = response.status
    await response.body?.cancel().catch(() => {})
    throw new BaseRpcSendHttpStatusError(status)
  }
}

/** Raw sends get exactly one HTTP attempt. The pool's explicit URL loop is the sole owner of byte-identical resends. */
export function baseSendTransport(url: string, fetchImpl?: typeof fetch): HttpTransport {
  return http(url, { fetchFn: statusAwareSendFetch(fetchImpl), retryCount: 0 })
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let candidate = error
  for (let depth = 0; depth < 8 && typeof candidate === 'object' && candidate !== null; depth += 1) {
    chain.push(candidate)
    candidate = (candidate as { cause?: unknown }).cause
  }
  return chain
}

/** Preserve FIX1 B4 ordering: hash, already-known, any unknown, then the last definite RPC outcome. */
export async function requestRawTransactionSnapshot(
  urls: readonly string[],
  send: (url: string) => Promise<unknown>,
): Promise<{ url: string; result: unknown }> {
  const attempts: BaseRpcSendAttemptSummary[] = []
  let lastDefinite: unknown
  let alreadyKnown: unknown
  let sawUnknown = false
  for (const url of urls) {
    try {
      const result = await send(url)
      if (typeof result === 'string' && /^0x[0-9a-f]{64}$/i.test(result)) return { url, result }
      sawUnknown = true
      attempts.push({ endpoint: describeBaseSendRpc(url), outcome: 'unknown', detail: `malformed success result (${result === null ? 'null' : typeof result})` })
    } catch (error) {
      const chain = errorChain(error)
      const httpStatus = chain.find((candidate): candidate is BaseRpcSendHttpStatusError => candidate instanceof BaseRpcSendHttpStatusError)
      const rpcError = chain.find((candidate): candidate is RpcRequestError => candidate instanceof RpcRequestError)
      if (!httpStatus && rpcError) {
        lastDefinite = rpcError
        attempts.push({ endpoint: describeBaseSendRpc(url), outcome: 'definite', detail: `RPC ${rpcError.code}: ${rpcError.details}` })
        if (/already known|\bknown transaction|alreadyknown|transaction already imported/i.test(rpcError.details)) alreadyKnown ??= rpcError
      } else {
        sawUnknown = true
        attempts.push({
          endpoint: describeBaseSendRpc(url), outcome: 'unknown',
          detail: httpStatus ? `HTTP ${httpStatus.status}` : error instanceof Error ? error.name : typeof error,
        })
      }
    }
  }
  if (alreadyKnown) throw alreadyKnown
  if (sawUnknown) throw new BaseRpcUnknownSendError(attempts)
  throw lastDefinite ?? new Error('Base RPC request has no active endpoint')
}
