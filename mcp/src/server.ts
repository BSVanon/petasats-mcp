/** Local, non-custodial USDC on Base to BSV buyer-kit adapter. */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  assertBuyerMainnetP2pkhAddress, buyerStatusView,
  BUYER_BASE_CLAIM_BUDGET_HOURS, BUYER_BASE_REFUND_HOURS,
  type Quote, type Route, type BuyerKit, type BuyerQuote, type CloseKitRequest, type CloseKitStep,
} from 'petasats/sdk'
import { requireString, optionalString, optionalObject, requireAmount, success, toolError, toolErrorData, ToolInputError } from './validate.js'
import { parseAsset, formatAsset, supportedPairs } from './assets.js'
import { addHostedQuoteOnlyNote, HOSTED_ALLOWED_TOOLS, hostedToolRefusal, isHostedCopy } from './hosted.js'
import { assertStopReason, CLOSE_KIT_TOOL, closeKitToolResult, parseCloseKitArgs } from './close-tool.js'
import { BUY_GAS_TOOL, buyGasToolResult, closeStepWithGasHint, rethrowWithGasHint } from './gas-tool.js'
import { VERSION } from './version.js'

const MAX_BSV_SATS = 2_100_000_000_000_000n
export const INSTRUCTIONS = `PetaSats buyer kit. It buys BSV with USDC on Base through a cross-chain atomic swap with the counterparty. It runs on this computer and keeps its keys here; no service ever holds the user's funds.

SCOPE: USDC on Base -> BSV only. About $5 to $100 per swap. Each buyer: at most 3 swaps and $200 per day. A shared daily total can make the service busy; a declined request can be retried later.

UNITS: amounts are decimal strings in the smallest unit. USDC has 6 decimals ("25000000" = 25 USDC). BSV is in satoshis ("100000000" = 1 BSV). ETH is in wei. A dollar amount the user names is the USDC to spend: "$10 of BSV" means amount_in "10000000".

STEPS
1. wallet_info. The kit needs USDC on Base at its own Base address (baseAddress in wallet_info); ETH for gas is optional. If it has no USDC, tell the user that address and what to send. If it has USDC but no ETH, ask the user whether the kit may use 0.50 USDC of its balance to buy ETH for gas, and say the 0.50 USDC comes out of their balance; otherwise tell them to send a little ETH to that address. Each yes covers one purchase. After a yes, call buy_gas, and call it again only while its result asks you to. Once state is 'filled' or 'expired', or 'rejected' with sold 'nothing', that purchase is over: ask again before another. Never move the user's funds from another wallet unless they ask.
2. get_quote. It shows the exact BSV for an exact USDC amount, the rate and the costs. A quote lasts about 60 seconds.
3. If a person is directing you, show them the quote and get a clear yes. This is the only time to ask about the swap. If they already gave you an amount and a limit, that is the yes.
4. swap_asset_to_bsv with quote_id (or min_bsv_out). If the quote has expired, the kit gets a new one and goes ahead only if it pays at least min_bsv_out, or 99% of the old quote.
5. wait_for_swap until done is true (each call waits up to about 50 seconds). A swap usually finishes within about an hour: the counterparty's BSV lock and the kit's claim each wait for a BSV block, and a delivery to another address goes out together with the claim.
6. Results: delivered or settled = BSV received; refunded = the USDC came back to the kit; failed = nothing was locked.

REPORTING
- A person is watching: give one short line only when the stage changes, then a final summary with the amounts, the txids and their links.
- Called by a program or another agent: return only the final result or the error.
- Never pause, slow down or ask anything once a swap has started. Reporting never holds up the swap.

SAFETY
- Standard speed is the default. Fast mode is the buyer's explicit choice and both sides must agree; otherwise the swap waits for one BSV confirmation. Fast mode makes the kit reveal its secret against an unconfirmed BSV lock. If the counterparty double-spends that lock, you can lose the swap amount. It is available only when both sides agree and the amount is at most $25; otherwise the swap waits for one BSV confirmation.
- Keep this MCP server running until the swap is done. If it stops, the swap resumes safely when it starts again. If it stays stopped for more than about ${BUYER_BASE_CLAIM_BUDGET_HOURS} hours after the USDC lock, the swap cannot finish; the kit then refunds the USDC the next time it runs after the Base timelock ends (about ${BUYER_BASE_REFUND_HOURS} hours after the lock).
- The kit refuses a new swap or a withdrawal while a swap is in progress.
- stop_spending stops new swaps and withdrawals until the user runs \`npx petasats-mcp resume\` in a terminal. Limits in limits.json can also refuse destinations and daily spending.
- withdraw_bsv and withdraw_base send funds out of the kit. Use only an address the user gave you, and confirm it with them.
- When the user asks to close, shut down or empty the kit, call close_kit with the Base and BSV addresses they gave and confirmed, and call it again until state is closed.
- Never open, print or send the kit's keys file. Tell the user to keep a backup of it: it holds the only copy of the kit's keys.`

const TOOLS = [
  {
    name: 'get_quote',
    title: 'Get USDC to BSV quote',
    description: 'Get a live quote for buying BSV with USDC on Base. Read-only: nothing is locked or spent. Call it before swap_asset_to_bsv and show the quote to the person directing you; it lasts about 60 seconds, and passing its quote_id to swap_asset_to_bsv uses these terms. Returns quote_id, expires_at, usdc_in, bsv_out, est_bsv_received_sats (after the BSV claim fee), rate_usd_per_bsv, market_mid_usd_per_bsv, price_vs_mid_percent, costs and limits. If the counterparty declines (busy or over a limit), the error carries code, retry_after_s and retry_hint. To send the BSV to another wallet, use fund_wallet: the same quote plus the exact swap call.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_asset: { type: 'string', description: 'Asset you pay with. Must be "USDC" (USDC on Base).' },
        to_asset: { type: 'string', description: 'Asset you receive. Must be "BSV".' },
        amount_in: { type: 'string', description: 'USDC to spend, in atomic units as a decimal string. USDC has 6 decimals: "25000000" = 25 USDC. The quote\'s limits field gives the current per-swap and daily limits.' },
      },
      required: ['from_asset', 'to_asset', 'amount_in'],
    },
  },
  {
    name: 'swap_asset_to_bsv',
    title: 'Start USDC to BSV swap',
    description: 'Buy BSV with this kit\'s USDC on Base through a non-custodial atomic swap with the counterparty. This moves funds: it locks USDC on Base, so get a quote with get_quote first and confirm it with the person directing you. Pass quote_id (or the quote object) to use that quote\'s terms, or min_bsv_out as a floor; if the quote has expired, the kit gets a new one and goes ahead only if it pays at least min_bsv_out, or 99% of the old quote. Returns at once with swap_id, stage, expected_minutes and the settlement mode; then call wait_for_swap until done is true. Refused while another swap is in progress or spending is stopped. If a swap cannot finish, the USDC comes back to the kit. speed is the buyer’s explicit choice; standard is the default. Fast mode makes the kit reveal its secret against an unconfirmed BSV lock. If the counterparty double-spends that lock, you can lose the swap amount. It is available only when both sides agree and the amount is at most $25; otherwise the swap waits for one BSV confirmation.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_asset: { type: 'string', description: 'Asset you pay with. Must be "USDC" (USDC on Base).' },
        amount_in: { type: 'string', description: 'USDC to spend, in atomic units as a decimal string ("25000000" = 25 USDC). Must equal the amount_in of the quote you pass.' },
        deliver_to: { type: 'string', description: 'Optional BSV mainnet address (P2PKH, starting with 1) to receive the BSV. Without it the BSV stays in this kit (see wallet_info; withdraw_bsv moves it later). With it, the kit sends the claimed BSV there automatically, for one more small fee (about 400 sats).' },
        min_bsv_out: { type: 'string', description: 'Optional floor for the BSV received, in satoshis as a decimal string ("100000000" = 1 BSV). Required when neither quote_id nor quote is given.' },
        quote_id: { type: 'string', description: 'Optional quote_id from get_quote. Uses that quote\'s terms while it is valid.' },
        quote: { type: 'object', description: 'Optional: the whole quote object from get_quote, instead of quote_id. Its route, pair and amount_in must match this request.' },
        speed: { type: 'string', enum: ['standard', 'fast'], description: 'Optional buyer choice. standard (default) waits for one BSV confirmation. fast reveals the secret against an unconfirmed BSV lock, and applies only when both sides agree and the amount is at most $25.' },
      },
      required: ['from_asset', 'amount_in'],
    },
  },
  {
    name: 'wait_for_swap',
    title: 'Wait for swap update',
    description: 'Wait until a swap\'s stage changes or it finishes, then return its status. Read-only: it watches this kit\'s local swap record while the swap runs in the background. After swap_asset_to_bsv, call it repeatedly until swap.done is true; a swap usually finishes within about an hour. Returns changed (false when the wait ended with no change, which is normal: call again), waited_seconds, and swap, the same view swap_status gives: stage, stage_label, step and steps_total, done, outcome (delivered, settled, refunded or failed), eta_minutes and txids with explorer links. Sends progress notifications when the client supplies a progress token. Use swap_status for an instant read.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object' as const,
      properties: {
        swap_id: { type: 'string', description: 'The swap_id returned by swap_asset_to_bsv or listed by swap_status.' },
        max_wait_seconds: { type: 'integer', minimum: 1, maximum: 55, description: 'Optional longest wait in whole seconds, from 1 to 55. Default 50.' },
      },
      required: ['swap_id'],
    },
  },
  {
    name: 'swap_status',
    title: 'Swap status',
    description: 'Show the status of one swap, or of every swap this kit has made. Read-only and instant: it reads the kit\'s local swap records and changes nothing. Returns swaps, a list (empty when swap_id is unknown). Each entry has swap_id, stage and stage_label, step and steps_total, done, outcome (delivered, settled, refunded or failed), usdc_in, bsv_quoted, bsv_received once settled, deliver_to, eta_minutes, deadlines, txids with explorer links, needs_attention and what_to_do. To wait for the next change, use wait_for_swap rather than calling this in a loop.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object' as const,
      properties: { swap_id: { type: 'string', description: 'Optional swap_id from swap_asset_to_bsv. Omit it to list every swap this kit has made.' } },
      required: [],
    },
  },
  {
    name: 'wallet_info',
    title: 'Wallet information',
    description: 'Show this kit\'s own wallets: the Base address that pays for swaps, the BSV address that receives them, their balances, and whether spending is stopped. Read-only; never returns key material. Call it first: if the kit has no USDC, tell the user to send it to baseAddress. ETH for Base gas is optional: the user can send a little, or, after their yes, buy_gas buys it with 0.50 USDC. Returns baseAddress, bsvAddress, usdc and eth balances in atomic units, claimedBsvSats, unconfirmedBsvSats (BSV received but not confirmed yet), capUsdPerSwap, spending_stopped (with stopped_at and stop_reason), the limits from limits.json, door_identity, a backup_note when the wallet is new, and gas_topup (status, uid and open (true while the order could still fill; USDC withdrawals, swaps and close_kit wait until it is false)) when the kit has a gas purchase.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'stop_spending',
    title: 'Stop spending',
    description: 'Emergency stop: block new swaps and withdrawals from this kit until the user runs `npx petasats-mcp resume` in a terminal; no tool can resume it. Use it when the user asks, or when something looks wrong. A swap already started still completes or refunds. Idempotent: calling it again keeps the first stop. Returns stopped: true, at (milliseconds since 1970) and reason, plus already_stopped: true when a stop was already in place.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object' as const,
      properties: { reason: { type: 'string', maxLength: 200, description: 'Optional note stored with the stop, up to 200 characters; wallet_info shows it as stop_reason.' } },
      required: [],
    },
  },
  {
    name: 'withdraw_bsv',
    title: 'Withdraw all confirmed BSV',
    description: 'Send all of this kit\'s confirmed BSV to one BSV address. This moves funds and cannot be undone: use only an address the user gave you, and confirm it with them first. It always sends the whole confirmed balance, and the network fee comes out of it; there is no partial amount. Refused while a swap or a BSV delivery is in progress, while spending is stopped, or when limits.json does not allow the address. Returns txid and sats sent, or sats 0 with a reason when there is no confirmed BSV. Use withdraw_base for USDC or ETH; to send a new swap\'s BSV straight to an address, pass deliver_to to swap_asset_to_bsv.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: { address: { type: 'string', description: 'Destination BSV mainnet address (P2PKH, starting with 1), supplied and confirmed by the user.' } },
      required: ['address'],
    },
  },
  {
    name: 'withdraw_base',
    title: 'Withdraw Base funds',
    description: 'Send USDC or ETH from this kit\'s Base wallet to another Base address. This moves funds and cannot be undone: use only an address the user gave you, and confirm it with them first. The kit pays the gas in ETH, so withdraw USDC before ETH. Refused while a swap is in progress, while spending is stopped, or when limits.json does not allow the address. Returns asset, amount (atomic and display), to, txid, status and a BaseScan url. Use withdraw_bsv for BSV.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        asset: { type: 'string', enum: ['USDC', 'ETH'], description: 'Which asset to send: "USDC" or "ETH".' },
        to: { type: 'string', description: 'Destination Base address in checksummed 0x form (EIP-55), supplied and confirmed by the user. Not this kit\'s own address, and not a swap or token contract.' },
        amount: { type: 'string', description: 'Atomic units as a decimal string (USDC has 6 decimals, "1000000" = 1 USDC; ETH is in wei), or "all". For ETH, "all" keeps back the gas and needs the USDC withdrawn first.' },
      },
      required: ['asset', 'to', 'amount'],
    },
  },
  {
    name: 'fund_wallet',
    title: 'Plan wallet funding',
    description: 'Plan sending BSV to a specific BSV address, paid with this kit\'s USDC on Base. Read-only: it returns a live quote and the exact swap_asset_to_bsv call (with deliver_to set), but moves nothing. Use it when the BSV should land in another wallet; use get_quote when it can stay in this kit. Fails if the kit could not start that swap now (spending stopped, address refused by limits.json, or over the daily limit). Returns plan, quote (the get_quote fields; valid about 60 seconds), swap_call and non_custodial.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        bsv_address: { type: 'string', description: 'BSV mainnet address (P2PKH, starting with 1) that should receive the BSV.' },
        from_asset: { type: 'string', description: 'Optional asset to pay with; only "USDC" (USDC on Base, the default) is available.' },
        amount_in: { type: 'string', description: 'USDC to spend, in atomic units as a decimal string ("25000000" = 25 USDC).' },
      },
      required: ['bsv_address', 'amount_in'],
    },
  },
  {
    name: 'list_liquidity',
    title: 'List liquidity',
    description: 'List the trading pairs this kit supports and how each one settles. Read-only and offline: a fixed list with no prices or balances; use get_quote for a live price and wallet_info for balances. Today there is one pair, USDC on Base to BSV, settled by an on-chain atomic swap with the counterparty; PetaSats never holds funds. Returns pairs (each with pair, route and note), count, non_custodial and settlement.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object' as const,
      properties: { asset: { type: 'string', description: 'Optional exact symbol, such as "USDC" or "BSV"; returns only the pairs that include it.' } },
      required: [],
    },
  },
  CLOSE_KIT_TOOL,
  BUY_GAS_TOOL,
]

const ABOUT = `# PetaSats buyer kit

The local buyer kit buys BSV with the operator’s own USDC on Base through the counterparty:

- **USDC → BSV only** — a cross-chain covenant atomic swap. One secret settles both legs; neither side can take one leg without the other.

## Non-custodial by construction
PetaSats never holds your keys or funds. Identity, Base, and BSV keys are generated and retained locally. Swaps run in the background and recovery resumes durable records after restart.

## Tools
- get_quote, swap_asset_to_bsv, wait_for_swap, swap_status, wallet_info, stop_spending, withdraw_bsv, withdraw_base, fund_wallet, list_liquidity, close_kit, buy_gas.
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
    costs: { base_gas: 'approve and lock on Base, paid in ETH by this kit', bsv_claim_fee_sats: claimFee.toString(), bsv_delivery_fee_note: 'with deliver_to, one more small BSV fee (about 400 sats)' }, fee_note: "PetaSats adds no separate fee; the counterparty's price is the rate above", limits: { min_usd_note: 'about $5; smaller swaps are declined', max_usd_per_swap: 100, per_buyer_per_day: '3 swaps and $200', shared_daily_total_note: 'shared daily total may make the service busy' }, next: 'swap_asset_to_bsv with this quote_id; quotes last about 60 seconds',
    from: formatAsset(q.from), to: formatAsset(q.to), route: q.route, amount_in: q.amountIn.toString(), amount_out: q.amountOut.toString(), expiry: q.expiry,
    ...(buyerQuote.doorQuoteId ? { door_quote_id: buyerQuote.doorQuoteId, usdc_base_units: buyerQuote.usdcBaseUnits?.toString(), bsv_sats: buyerQuote.bsvSats?.toString(), door_protocol_version: buyerQuote.doorProtocolVersion ?? 1, fast_offered: buyerQuote.fastOffered ?? false, fast_cap_usdc_base_units: (buyerQuote.fastCapUsdcBaseUnits ?? 0n).toString() } : {}),
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
    const version = o.door_protocol_version === 2 ? 2 : 1
    const fastOffered = o.fast_offered === true
    const cap = typeof o.fast_cap_usdc_base_units === 'string' && /^(?:0|[1-9]\d*)$/.test(o.fast_cap_usdc_base_units) ? BigInt(o.fast_cap_usdc_base_units) : 0n
    if ((version !== 2 || !fastOffered) && cap !== 0n) throw new ToolInputError('quote fast metadata is contradictory')
    return { ...quote, doorQuoteId: o.door_quote_id, usdcBaseUnits: BigInt(o.usdc_base_units), bsvSats: BigInt(o.bsv_sats), doorProtocolVersion: version, fastOffered, fastCapUsdcBaseUnits: cap } as BuyerQuote
  }
  return quote
}

/** MCP tool-result shape (text content + optional isError). */
export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

const redact = (message: string): string => message
  .replace(/[5KLc][1-9A-HJ-NP-Za-km-z]{50,51}/g, '[redacted credential]')
  .replace(/0x[0-9a-fA-F]{65,}/g, '[redacted signed data]')
  .replace(/0x[0-9a-fA-F]{64}/g, '[redacted secret]')
  .replace(/keys\.json/gi, '[redacted credential source]')
  .replace(/\b(?:private\s+key|wif|keys?\s+file)\b/gi, '[redacted credential]')

/**
 * Pure tool dispatch over an injected PetaSats — the server handler and the tests both call this, so the
 * money-facing logic is exercised without transport plumbing. Every branch fails closed to a tool error.
 */
export async function handleToolCall(petasats: BuyerKit, name: string, a: Record<string, unknown> | undefined, details: { doorIdentity?: string; signal?: AbortSignal; progress?: (step: number | null, total: number, message: string) => void | Promise<void>; closeKit?: (request: CloseKitRequest) => Promise<CloseKitStep> } = {}): Promise<ToolResult> {
  try {
    switch (name) {
      case 'get_quote': {
        const from = parseAsset(requireString(a, 'from_asset'))
        const to = parseAsset(requireString(a, 'to_asset'))
        if (from !== 'USDC' || to !== 'BSV') throw new ToolInputError('not available: only USDC → BSV through the counterparty door')
        const amountIn = requireAmount(a, 'amount_in')
        const q = await petasats.quote({ from, to, amountIn, deliverTo: '' })
        return success(toQuoteWire(q))
      }

      case 'swap_asset_to_bsv': {
        const from = parseAsset(requireString(a, 'from_asset'))
        if (from !== 'USDC') throw new ToolInputError('not available: only USDC → BSV through the counterparty door')
        const amountIn = requireAmount(a, 'amount_in')
        const deliverTo = optionalString(a, 'deliver_to')
        const quoteObj = optionalObject(a, 'quote')
        const quote = quoteObj ? fromQuoteWire(quoteObj) : undefined
        const quoteId = optionalString(a, 'quote_id')
        const min = optionalString(a, 'min_bsv_out')
        const speed = optionalString(a, 'speed') ?? 'standard'
        if (speed !== 'standard' && speed !== 'fast') throw new ToolInputError('speed must be standard or fast')
        if (min !== undefined && !/^\d{1,16}$/.test(min)) throw new ToolInputError('min_bsv_out must be a positive bounded sats integer string')
        const minBsvOut = min === undefined ? undefined : BigInt(min)
        if (minBsvOut !== undefined && (minBsvOut < 1n || minBsvOut > MAX_BSV_SATS)) throw new ToolInputError('min_bsv_out must be a positive bounded sats integer string')
        if (!quoteId && !quote && minBsvOut === undefined) throw new ToolInputError('pass quote_id or min_bsv_out')
        const started = await petasats.startSwap({ amountIn, deliverTo, minBsvOut, quote: (quote ?? (quoteId ? { quoteId } : undefined)) as BuyerQuote | undefined, speed })
        return success({ swap_id: started.swapId, stage: started.stage, expected_minutes: started.expectedMinutes, requested_speed: started.requestedSpeed, agreed_settlement_mode: started.agreedSettlementMode, settlement_mode_used: started.settlementModeUsed })
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
        assertStopReason(reason)
        if (!petasats.stopSpending) throw new Error('spending stop is not configured')
        const result = await petasats.stopSpending(reason)
        return success(result.alreadyStopped ? { stopped: true, already_stopped: true, at: result.at, reason: result.reason } : { stopped: true, at: result.at, reason: result.reason })
      }
      case 'withdraw_bsv': return success(await petasats.withdrawBsv(requireString(a, 'address')))
      case 'withdraw_base': {
        const asset = requireString(a, 'asset'); if (asset !== 'USDC' && asset !== 'ETH') throw new ToolInputError('asset must be USDC or ETH')
        const result = await petasats.withdrawBase({ asset, to: requireString(a, 'to'), amount: requireString(a, 'amount') }).catch(rethrowWithGasHint)
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

      case 'close_kit':
        if (!details.closeKit) throw new Error('close_kit is not available until the kit is set up')
        return closeKitToolResult(closeStepWithGasHint(await details.closeKit(parseCloseKitArgs(a))))
      case 'buy_gas':
        if (!petasats.buyGas) throw new Error('buy_gas is not available until the kit is set up')
        return buyGasToolResult(await petasats.buyGas())

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
  hosted?: boolean
  doorIdentity?: string
  name?: string
  version?: string
  closeKit?: (request: CloseKitRequest) => Promise<CloseKitStep>
}

/** Build the MCP Server exposing the PetaSats convert() capability over an injected SDK instance. */
export function createPetaSatsMcpServer(deps: PetaSatsMcpDeps): Server {
  const { petasats, hosted = isHostedCopy(), closeKit } = deps
  const server = new Server(
    { name: deps.name ?? 'petasats-mcp', version: deps.version ?? VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (hosted && !HOSTED_ALLOWED_TOOLS.has(request.params.name)) return hostedToolRefusal()
    const token = request.params._meta?.progressToken
    const progress = token === undefined ? undefined : (step: number | null, total: number, message: string) =>
      server.notification({ method: 'notifications/progress', params: { progressToken: token, progress: step ?? 0, total, message } })
    const result = await handleToolCall(petasats, request.params.name, request.params.arguments as Record<string, unknown> | undefined, { doorIdentity: deps.doorIdentity, signal: extra.signal, progress, closeKit })
    return hosted ? addHostedQuoteOnlyNote(result) : result
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'petasats://about', name: 'About PetaSats', description: 'The non-custodial model + supported pair', mimeType: 'text/markdown' }, { uri: 'petasats://instructions', name: 'Instructions', description: 'Buyer kit operating instructions', mimeType: 'text/plain' }],
  }))

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }))

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
