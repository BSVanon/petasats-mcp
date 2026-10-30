/**
 * Base read fetch wrapper: retry a provider's refusal of a transaction or receipt lookup instead of failing on it.
 *
 * publicnode answers a lookup that the backend it routed to cannot serve with a JSON-RPC error (-32602 "Archive
 * requests require a personal token") instead of the standard null. It does this for a hash that is not mined yet and,
 * on some backends, for an old mined one. viem does not retry that error, so every receipt wait for a just-sent
 * transaction failed at once (2026-10-29: a buyer's USDC approve and a funding transfer, both mined fine).
 *
 * The refusal says nothing about whether the transaction exists, so it must never become "not found": a recovery read
 * of an old lock would then conclude the lock never happened. It is re-issued as a bare 503, which viem retries on the
 * read schedule. A mined transaction is then served, and a lookup that is still refused after the retries fails as an
 * error, never as a miss.
 *
 * A retry, or another endpoint, can still answer the standard null after a refusal. One logical lookup therefore runs in
 * one refusal scope (`guardLookup`): once any attempt in it was refused, on any endpoint, a null result is an error too.
 * Concurrent identical lookups are not merged into one request, so each caller's scope sees its own attempts.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Transport } from 'viem'

const LOOKUP_METHODS = new Set(['eth_getTransactionReceipt', 'eth_getTransactionByHash'])
const LOOKUP_REFUSAL = /archive requests require a personal token/i
const lookupScope = new AsyncLocalStorage<{ refused: boolean }>()

/** A lookup that a backend refused ended without any backend serving it: unknown, not absent. */
export class LookupRefusedError extends Error {
  constructor(method: string) {
    super(`${method}: a Base RPC backend refused this lookup and none served it; this does not show the transaction is absent`)
    this.name = 'LookupRefusedError'
  }
}

function isLookupRequest(body: unknown): boolean {
  if (typeof body !== 'string') return false
  try {
    const parsed = JSON.parse(body) as { method?: unknown } | null
    return !!parsed && !Array.isArray(parsed) && typeof parsed.method === 'string' && LOOKUP_METHODS.has(parsed.method)
  } catch { return false }
}

export function lookupRefusalRetryableFetch(inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init)
    if (!res.ok || !isLookupRequest(init?.body)) return res
    let message: unknown
    try { message = (JSON.parse(await res.clone().text()) as { error?: { message?: unknown } } | null)?.error?.message } catch { return res }
    if (typeof message !== 'string' || !LOOKUP_REFUSAL.test(message)) return res
    const scope = lookupScope.getStore()
    if (scope) scope.refused = true
    await res.body?.cancel().catch(() => {})
    return new Response('lookup refused by this backend', { status: 503, statusText: 'Service Unavailable' })
  }
}

/** Runs one logical lookup in a refusal scope. The outermost caller owns the scope and nested callers share it, so a
 *  refusal on one endpoint still counts when a later endpoint answers. Other methods run unchanged. */
export async function guardLookup<T>(method: string, run: () => Promise<T>): Promise<T> {
  if (!LOOKUP_METHODS.has(method)) return run()
  const outer = lookupScope.getStore()
  const scope = outer ?? { refused: false }
  let result: T
  try {
    result = outer ? await run() : await lookupScope.run(scope, run)
  } catch (error) {
    // Exhausting the retry/fallback set after any archive refusal is still an unknown lookup.  Do not leak the
    // transport's final 503 to a caller which might otherwise collapse it into an absent transaction.
    if (scope.refused) throw new LookupRefusedError(method)
    throw error
  }
  if (result == null && scope.refused) throw new LookupRefusedError(method)
  return result
}

/** viem merges identical in-flight lookups into one request (`dedupe`, which its transaction and receipt actions turn
 *  on). The merged request runs in the first caller's refusal scope, so a second caller would take its null without the
 *  refusal and read "not found". Lookups opt out of the merge, so each caller reads in its own scope. */
const unmerged = (method: string, options?: object): object | undefined => (LOOKUP_METHODS.has(method) ? { ...options, dedupe: false } : options)

/** A transport whose transaction and receipt lookups run through `guardLookup`. */
export function lookupRefusalGuard<T extends Transport>(inner: T): T {
  return ((config: Parameters<T>[0]) => {
    const transport = inner(config)
    const request = ((args: { method: string }, options?: object) =>
      guardLookup(args.method, () => (transport.request as (a: unknown, o?: object) => Promise<unknown>)(args, unmerged(args.method, options)))) as typeof transport.request
    return { ...transport, request }
  }) as T
}
