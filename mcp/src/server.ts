/** Local, non-custodial USDC on Base to BSV buyer-kit adapter. */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { assertBuyerMainnetP2pkhAddress, buyerStatusView, type Quote, type Route, type BuyerKit, type BuyerQuote } from 'petasats/sdk'
import { requireString, optionalString, optionalObject, requireAmount, success, toolError, toolErrorData, ToolInputError } from './validate.js'
import { parseAsset, formatAsset, supportedPairs } from './assets.js'
import { VERSION } from './version.js'

const ASSET_HELP = 'USDC or BSV (phase 1 supports USDC → BSV only)'
const MAX_BSV_SATS = 2_100_000_000_000_000n
export const INSTRUCTIONS = `PetaSats buyer kit. It buys BSV with USDC on Base through a cross-chain atomic swap with the PetaSats market maker. It runs on this computer and keeps its keys here; no service ever holds the user's funds.

SCOPE: USDC on Base -> BSV only. About $5 to $100 per swap. Each buyer: at most 3 swaps and $200 per day. A shared daily total can make the service busy; a declined request can be retried later.

UNITS: amounts are decimal strings in the smallest unit. USDC has 6 decimals ("25000000" = 25 USDC). BSV is in satoshis ("100000000" = 1 BSV). ETH is in wei.

STEPS
1. wallet_info. The kit needs USDC and a little ETH (for gas) on Base at its own base_address. If it has none, tell the user that address and what to send. Never move the user's funds from another wallet unless they ask.
2. get_quote. It shows the exact BSV for an exact USDC amount, the rate and the costs. A quote lasts about 60 seconds.
3. If a person is directing you, show them the quote and get a clear yes. This is the only time to ask. If they already gave you an amount and a limit, that is the yes.
4. swap_asset_to_bsv with quote_id (or min_bsv_out). If the quote has expired, the kit gets a new one and goes ahead only if it pays at least min_bsv_out, or 99% of the old quote.
5. wait_for_swap until done is true (each call waits up to about 50 seconds). A swap usually takes 15 to 25 minutes, mostly waiting for one BSV block.
6. Results: delivered or settled = BSV received; refunded = the USDC came back to the kit; failed = nothing was locked.

REPORTING
- A person is watching: give one short line only when the stage changes, then a final summary with the amounts, the txids and their links.
- Called by a program or another agent: return only the final result or the error.
- Never pause, slow down or ask anything once a swap has started. Reporting never holds up the swap.

SAFETY
- Keep this MCP server running until the swap is done. If it stops, the swap resumes safely when it starts again. If it stays stopped for more than about 3 hours after the USDC lock, the swap cannot finish; the kit then refunds the USDC the next time it runs after the Base timelock ends (about 16 hours after the lock).
- The kit refuses a new swap or a withdrawal while a swap is in progress.
- stop_spending stops new swaps and withdrawals until the user runs \`npx petasats-mcp resume\` in a terminal. Limits in limits.json can also refuse destinations and daily spending.
- withdraw_bsv and withdraw_base send funds out of the kit. Use only an address the user gave you, and confirm it with them.
- Never open, print or send the kit's keys file. Tell the user to keep a backup of it: it holds the only copy of the kit's keys.`

const TOOLS = [
  {
    name: 'get_quote',
    title: 'Get USDC to BSV quote', description: 'Read-only live USDC on Base to BSV quote. Amount is USDC atomic units; returns price and costs.', annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_asset: { type: 'string', description: `Asset to convert FROM: ${ASSET_HELP}` },
        to_asset: { type: 'string', description: `Asset to convert TO: ${ASSET_HELP}` },
        amount_in: { type: 'string', description: 'Amount of from_asset in atomic units, as a decimal string (e.g. USDC 6dp: "1000000" = 1 USDC; BSV in sats).' },
      },
      required: ['from_asset', 'to_asset', 'amount_in'],
    },
  },
  {
    name: 'swap_asset_to_bsv',
    title: 'Start USDC to BSV swap', description: 'Starts a funds-moving USDC on Base to BSV swap. Amounts are atomic strings; returns the local swap id.', annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_asset: { type: 'string', description: `Asset to convert into BSV: ${ASSET_HELP} (not BSV itself)` },
        amount_in: { type: 'string', description: 'Amount of from_asset in atomic units (decimal string).' },
        deliver_to: { type: 'string', description: 'Optional destination BSV address. Confirmed BSV is swept there automatically.' },
        min_bsv_out: { type: 'string', description: 'Optional minimum BSV output in sats.' },
        quote_id: { type: 'string', description: 'Quote id returned by get_quote.' },
        quote: { type: 'object', description: 'Optional: a quote object returned by get_quote, to lock its terms (bound to route + pair + amount_in).' },
      },
      required: ['from_asset', 'amount_in'],
    },
  },
  { name: 'wait_for_swap', title: 'Wait for swap update', description: 'Read-only wait for a local swap stage change, for up to 55 seconds.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' as const, properties: { swap_id: { type: 'string' }, max_wait_seconds: { type: 'number' } }, required: ['swap_id'] } },
  { name: 'swap_status', title: 'Swap status', description: 'Read-only structured local swap status and transaction links.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' as const, properties: { swap_id: { type: 'string' } }, required: [] } },
  { name: 'wallet_info', title: 'Wallet information', description: 'Read-only local Base and BSV addresses and balances; no key material.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' as const, properties: {}, required: [] } },
  { name: 'stop_spending', title: 'Stop spending', description: 'Stops new swaps and withdrawals until the user resumes spending from a terminal.', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, inputSchema: { type: 'object' as const, properties: { reason: { type: 'string', maxLength: 200 } }, required: [] } },
  { name: 'withdraw_bsv', title: 'Withdraw all confirmed BSV', description: 'Moves all confirmed BSV from this kit to the supplied BSV address.', annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, inputSchema: { type: 'object' as const, properties: { address: { type: 'string' } }, required: ['address'] } },
  { name: 'withdraw_base', title: 'Withdraw Base funds', description: 'Moves USDC or ETH from the local Base wallet. Amount is atomic or all.', annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, inputSchema: { type: 'object' as const, properties: { asset: { type: 'string' }, to: { type: 'string' }, amount: { type: 'string' } }, required: ['asset', 'to', 'amount'] } },
  {
    name: 'fund_wallet',
    title: 'Plan wallet funding', description: 'Read-only USDC on Base to BSV funding plan and quote; does not move funds.', annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        bsv_address: { type: 'string', description: 'The BSV address to fund.' },
        from_asset: { type: 'string', description: `Source asset to spend (default USDC): ${ASSET_HELP}` },
        amount_in: { type: 'string', description: 'Amount of from_asset to spend, atomic units (decimal string).' },
      },
      required: ['bsv_address', 'amount_in'],
    },
  },
  {
    name: 'list_liquidity',
    title: 'List liquidity', description: 'Read-only supported USDC on Base to BSV service information.', annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: { asset: { type: 'string', description: `Optional filter: only pairs involving this asset (${ASSET_HELP}).` } },
      required: [],
    },
  },
]

const ABOUT = `# PetaSats buyer kit

The local buyer kit buys BSV with the operator’s own USDC on Base through the market maker:

- **USDC → BSV only** — a cross-chain covenant atomic swap. One secret settles both legs; neither side can take one leg without the other.

## Non-custodial by construction
PetaSats never holds your keys or funds. Identity, Base, and BSV keys are generated and retained locally. Swaps run in the background and recovery resumes durable records after restart.

## Tools
- get_quote, swap_asset_to_bsv, wait_for_swap, swap_status, wallet_info, stop_spending, withdraw_bsv, withdraw_base, fund_wallet, list_liquidity.
`

/** The get_quote wire shape (bigints as strings; assets as agent-facing strings). */
function toQuoteWire(q: Quote): Record<string, unknown> {
  const buyerQuote = q as Partial<BuyerQuote>
  const bsv = buyerQuote.bsvSats ?? q.amountOut
  const claimFee = BigInt(buyerQuote.claimFeeBudgetSats ?? 0)
  const usdcDisplay = `${(Number(q.amountIn) / 1e6).toFixed(2)} USDC`
  const bsvDisplay = `${(Number(bsv) / 1e8).toFixed(8)} BSV`
  const rate = Number(q.amountIn) / 1e6 / (Number(bsv) / 1e8)
  const mid = buyerQuote.midUsdPerBsv
  return {
    quote_id: q.quoteId, expires_at: new Date(q.expiry * 1000).toISOString(), expires_in_seconds: Math.max(0, q.expiry - Math.floor(Date.now() / 1000)),
    usdc_in: { atomic: q.amountIn.toString(), display: usdcDisplay }, bsv_out: { sats: bsv.toString(), display: bsvDisplay }, est_bsv_claim_fee_sats: claimFee.toString(), est_bsv_received_sats: (bsv - claimFee).toString(), rate_usd_per_bsv: rate, market_mid_usd_per_bsv: mid ?? null, price_vs_mid_percent: mid ? Number((((rate - mid) / mid) * 100).toFixed(2)) : null,
    costs: { base_gas: 'approve and lock on Base, paid in ETH by this kit', bsv_claim_fee_sats: claimFee.toString(), bsv_delivery_fee_note: 'with deliver_to, one more small BSV fee (about 400 sats)' }, fee_note: "PetaSats adds no separate fee; the market maker's price is the rate above", limits: { min_usd_note: 'about $5; smaller swaps are declined', max_usd_per_swap: 100, per_buyer_per_day: '3 swaps and $200', shared_daily_total_note: 'shared daily total may make the service busy' }, next: 'swap_asset_to_bsv with this quote_id; quotes last about 60 seconds',
    from: formatAsset(q.from), to: formatAsset(q.to), route: q.route, amount_in: q.amountIn.toString(), amount_out: q.amountOut.toString(), expiry: q.expiry,
    ...(buyerQuote.doorQuoteId ? { door_quote_id: buyerQuote.doorQuoteId, usdc_base_units: buyerQuote.usdcBaseUnits?.toString(), bsv_sats: buyerQuote.bsvSats?.toString() } : {}),
  }
}

function atomicDisplay(amount: bigint, decimals: number, asset: 'USDC' | 'ETH'): string {
  const digits = amount.toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, -decimals)
  const fraction = digits.slice(-decimals).replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''} ${asset}`
}

/** Reconstruct an SDK Quote from a wire object an agent passes back (fail-closed on shape). */
function fromQuoteWire(o: Record<string, unknown>): Quote {
  const from = parseAsset(requireString(o, 'from'))
  const to = parseAsset(requireString(o, 'to'))
  const route = requireString(o, 'route')
  if (route !== 'bridge' && route !== 'dex') throw new ToolInputError(`quote.route must be 'bridge' or 'dex'`)
  const amountIn = requireAmount(o, 'amount_in')
  const amountOut = requireAmount(o, 'amount_out')
  const expiry = Number(o.expiry)
  if (!Number.isFinite(expiry)) throw new ToolInputError('quote.expiry must be a number')
  const quote: Quote = { from, to, route: route as Route, amountIn, amountOut, expiry, quoteId: String(o.quote_id ?? '') }
  if (typeof o.door_quote_id === 'string' && typeof o.usdc_base_units === 'string' && typeof o.bsv_sats === 'string' && /^\d+$/.test(o.usdc_base_units) && /^\d+$/.test(o.bsv_sats)) {
    return { ...quote, doorQuoteId: o.door_quote_id, usdcBaseUnits: BigInt(o.usdc_base_units), bsvSats: BigInt(o.bsv_sats) } as BuyerQuote
  }
  return quote
}

/** MCP tool-result shape (text content + optional isError). */
export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

const redact = (message: string): string => message
  .replace(/[5KLc][1-9A-HJ-NP-Za-km-z]{50,51}/g, '[redacted credential]')
  .replace(/0x[0-9a-fA-F]{64}/g, '[redacted secret]')
  .replace(/keys\.json/gi, '[redacted credential source]')
  .replace(/\b(?:private\s+key|wif|keys?\s+file)\b/gi, '[redacted credential]')

/**
 * Pure tool dispatch over an injected PetaSats — the server handler and the tests both call this, so the
 * money-facing logic is exercised without transport plumbing. Every branch fails closed to a tool error.
 */
export async function handleToolCall(petasats: BuyerKit, name: string, a: Record<string, unknown> | undefined, details: { doorIdentity?: string; signal?: AbortSignal; progress?: (step: number | null, total: number, message: string) => void | Promise<void> } = {}): Promise<ToolResult> {
  try {
    switch (name) {
      case 'get_quote': {
        const from = parseAsset(requireString(a, 'from_asset'))
        const to = parseAsset(requireString(a, 'to_asset'))
        if (from !== 'USDC' || to !== 'BSV') throw new ToolInputError('not available: only USDC → BSV through the market maker door')
        const amountIn = requireAmount(a, 'amount_in')
        const q = await petasats.quote({ from, to, amountIn, deliverTo: '' })
        return success(toQuoteWire(q))
      }

      case 'swap_asset_to_bsv': {
        const from = parseAsset(requireString(a, 'from_asset'))
        if (from !== 'USDC') throw new ToolInputError('not available: only USDC → BSV through the market maker door')
        const amountIn = requireAmount(a, 'amount_in')
        const deliverTo = optionalString(a, 'deliver_to')
        const quoteObj = optionalObject(a, 'quote')
        const quote = quoteObj ? fromQuoteWire(quoteObj) : undefined
        const quoteId = optionalString(a, 'quote_id')
        const min = optionalString(a, 'min_bsv_out')
        if (min !== undefined && !/^\d{1,16}$/.test(min)) throw new ToolInputError('min_bsv_out must be a positive bounded sats integer string')
        const minBsvOut = min === undefined ? undefined : BigInt(min)
        if (minBsvOut !== undefined && (minBsvOut < 1n || minBsvOut > MAX_BSV_SATS)) throw new ToolInputError('min_bsv_out must be a positive bounded sats integer string')
        if (!quoteId && !quote && minBsvOut === undefined) throw new ToolInputError('pass quote_id or min_bsv_out')
        const started = await petasats.startSwap({ amountIn, deliverTo, minBsvOut, quote: (quote ?? (quoteId ? { quoteId } : undefined)) as BuyerQuote | undefined })
        return success({ swap_id: started.swapId, stage: started.stage, expected_minutes: started.expectedMinutes })
      }

      case 'swap_status': {
        const id = optionalString(a, 'swap_id')
        const rows = await petasats.status(id)
        return success({ swaps: rows.map(buyerStatusView) })
      }
      case 'wait_for_swap': {
        const id = requireString(a, 'swap_id'); const seconds = Number(a?.max_wait_seconds ?? 50)
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 55) throw new ToolInputError('max_wait_seconds must be an integer from 1 to 55')
        const initial = (await petasats.status(id))[0]; if (!initial) throw new ToolInputError('swap_id is not found')
        const until = Date.now() + seconds * 1000; let current = initial; let lastProgressStep: number | undefined
        const notify = async (): Promise<void> => {
          const view = buyerStatusView(current) as { step: number | null; steps_total: number; stage_label: string }
          if (view.step !== null && (lastProgressStep === undefined || view.step > lastProgressStep)) {
            lastProgressStep = view.step
            await details.progress?.(view.step, view.steps_total, view.stage_label)
          }
        }
        await notify()
        while (Date.now() < until && !['settled', 'delivered', 'refunded', 'failed'].includes(current.stage)) {
          if (details.signal?.aborted) throw new ToolInputError('wait_for_swap was cancelled')
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => { clearTimeout(timer); reject(new ToolInputError('wait_for_swap was cancelled')) }
            const timer = setTimeout(() => { details.signal?.removeEventListener('abort', onAbort); resolve() }, 2000)
            details.signal?.addEventListener('abort', onAbort, { once: true })
          })
          current = (await petasats.status(id))[0] ?? current
          await notify()
          if (current.stage !== initial.stage) break
        }
        return success({ changed: current.stage !== initial.stage, waited_seconds: Math.ceil((seconds * 1000 - Math.max(0, until - Date.now())) / 1000), swap: buyerStatusView(current) })
      }
      case 'wallet_info': return success({ ...await petasats.walletInfo(), door_identity: details.doorIdentity ?? 'not configured' })
      case 'stop_spending': {
        const reason = optionalString(a, 'reason')
        if (reason !== undefined && reason.length > 200) throw new ToolInputError('reason must be 200 characters or fewer')
        if (!petasats.stopSpending) throw new Error('spending stop is not configured')
        const result = await petasats.stopSpending(reason)
        return success(result.alreadyStopped ? { stopped: true, already_stopped: true, at: result.at, reason: result.reason } : { stopped: true, at: result.at, reason: result.reason })
      }
      case 'withdraw_bsv': return success(await petasats.withdrawBsv(requireString(a, 'address')))
      case 'withdraw_base': {
        const asset = requireString(a, 'asset'); if (asset !== 'USDC' && asset !== 'ETH') throw new ToolInputError('asset must be USDC or ETH')
        const result = await petasats.withdrawBase({ asset, to: requireString(a, 'to'), amount: requireString(a, 'amount') })
        return success({ ...result, amount: { atomic: result.amount.toString(), display: atomicDisplay(result.amount, asset === 'USDC' ? 6 : 18, asset) }, url: `https://basescan.org/tx/${result.txid}` })
      }

      case 'fund_wallet': {
        const bsvAddress = requireString(a, 'bsv_address')
        assertBuyerMainnetP2pkhAddress(bsvAddress, 'bsv_address')
        const from = parseAsset(optionalString(a, 'from_asset') ?? 'USDC')
        if (from !== 'USDC') throw new ToolInputError('not available in phase 1: fund_wallet supports USDC → BSV only')
        const amountIn = requireAmount(a, 'amount_in')
        await petasats.assertCanPlanSwap?.(bsvAddress, amountIn)
        const q = await petasats.quote({ from, to: 'BSV', amountIn, deliverTo: bsvAddress })
        return success({
          plan: 'To fund this BSV address non-custodially, call swap_asset_to_bsv with the params below (optionally passing this quote to lock terms).',
          quote: toQuoteWire(q),
          swap_call: { tool: 'swap_asset_to_bsv', from_asset: formatAsset(from), amount_in: amountIn.toString(), deliver_to: bsvAddress },
          non_custodial: 'Your keys/funds never touch PetaSats; settlement is a trustless on-chain atomic swap.',
        })
      }

      case 'list_liquidity': {
        const filter = optionalString(a, 'asset')
        let pairs = supportedPairs()
        if (filter) {
          const f = filter.trim()
          pairs = pairs.filter((p) => (f.startsWith('bsv21') ? p.route === 'dex' : p.pair.includes(f)))
        }
        return success({ non_custodial: true, settlement: 'on-chain atomic USDC on Base to BSV; PetaSats never custodies', pairs, count: pairs.length })
      }

      default:
        return toolError(`unknown tool: ${name}`)
    }
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'decline' in err) return toolErrorData((err as { decline: unknown }).decline)
    return toolError(redact(err instanceof Error ? err.message : String(err)))
  }
}

export interface PetaSatsMcpDeps {
  petasats: BuyerKit
  doorIdentity?: string
  name?: string
  version?: string
}

/** Build the MCP Server exposing the PetaSats convert() capability over an injected SDK instance. */
export function createPetaSatsMcpServer(deps: PetaSatsMcpDeps): Server {
  const { petasats } = deps
  const server = new Server(
    { name: deps.name ?? 'petasats-mcp', version: deps.version ?? VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const token = request.params._meta?.progressToken
    const progress = token === undefined ? undefined : (step: number | null, total: number, message: string) =>
      server.notification({ method: 'notifications/progress', params: { progressToken: token, progress: step ?? 0, total, message } })
    return handleToolCall(petasats, request.params.name, request.params.arguments as Record<string, unknown> | undefined, { doorIdentity: deps.doorIdentity, signal: extra.signal, progress })
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'petasats://about', name: 'About PetaSats', description: 'The non-custodial model + supported pair', mimeType: 'text/markdown' }, { uri: 'petasats://instructions', name: 'Instructions', description: 'Buyer kit operating instructions', mimeType: 'text/plain' }],
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === 'petasats://about') {
      return { contents: [{ uri: 'petasats://about', mimeType: 'text/markdown', text: ABOUT }] }
    }
    if (request.params.uri === 'petasats://instructions') return { contents: [{ uri: 'petasats://instructions', mimeType: 'text/plain', text: INSTRUCTIONS }] }
    throw new Error(`unknown resource: ${request.params.uri}`)
  })

  return server
}

export { TOOLS }
