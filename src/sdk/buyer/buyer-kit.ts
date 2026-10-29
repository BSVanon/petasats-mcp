import { randomBytes } from 'crypto'
import { isAddress } from 'viem'
import { isBsv, isErc20, type ConvertRequest, type Quote, type SwapResult } from '../convert'
import type { BuyerBaseWallet, BuyerKit, BuyerKitConfig, BuyerQuote, BuyerSwapRecord, BuyerSwapStage, BuyerStore, BuyerWallet, DoorClient, BuyerExecutor, StartSwapRequest } from './types'
import { buyerClaimFeeBudgetSats, buyerStageForSettlement } from './engine'
import { assertBuyerMainnetP2pkhAddress } from './runtime/address'

const HARD_CAP_USD = 1000
const DEFAULT_CAP_USD = 100
const active = new Set<BuyerSwapStage>(['quoted', 'admitted', 'usdc_locked', 'waiting_bsv_lock', 'bsv_lock_confirming', 'claiming', 'sweeping', 'refund_waiting', 'needs_attention'])
const terminal = new Set<BuyerSwapStage>(['settled', 'delivered', 'refunded', 'failed'])
const known = new Set<BuyerSwapStage>([...active, ...terminal, 'claimed'])
const knownStage = (stage: string): stage is BuyerSwapStage => known.has(stage as BuyerSwapStage)
const requestId = (): string => randomBytes(18).toString('base64url')
const swapId = (): string => randomBytes(16).toString('hex')

function assertAddress(address: string): void {
  assertBuyerMainnetP2pkhAddress(address)
}
function asUsd(amount: bigint): number {
  if (amount < 1n || amount > 1_000_000_000n) throw new Error('amount_in is outside the phase-1 USDC cap')
  return Number(amount) / 1_000_000
}
function nextEvent(stage: BuyerSwapStage | string): string {
  if (!knownStage(stage)) return 'An older or unknown record needs recovery before funds can move.'
  const words: Record<BuyerSwapStage, string> = {
    quoted: 'Waiting for the market maker to admit the bound quote.', admitted: 'Sending the atomic-swap intent.', usdc_locked: 'Waiting for the BSV lock.',
    waiting_bsv_lock: 'Waiting for the BSV lock.', bsv_lock_confirming: 'Waiting for an independently verified BSV confirmation.',
    claiming: 'Claiming BSV; recovery will keep this claim alive.', claimed: 'Waiting for the BSV claim to bury.', settled: 'BSV is in the local kit wallet.',
    sweeping: 'Sweeping confirmed BSV to the requested address.', delivered: 'BSV was delivered.', refund_waiting: 'Waiting for the Base timelock before refunding USDC.', refunded: 'USDC was refunded.', failed: 'No money-moving step was accepted.', needs_attention: 'Recovery needs attention; settlement evidence could not be read.',
  }
  return words[stage]
}

/**
 * Stateful USDC→BSV buyer façade.  It owns no transport and no RPC: those are injected by the local runtime, which
 * makes the same lifecycle safe to test on in-memory chains and to resume after process restart.
 */
export function createBuyerKit(config: BuyerKitConfig, deps: { door: DoorClient; executor: BuyerExecutor; store: BuyerStore; wallet: BuyerWallet & BuyerBaseWallet; /** Checked immediately before the first door call for every new swap. */ beforeNewSwap?: () => void | Promise<void>; log?: (message: string) => void }): BuyerKit {
  const capUsdPerSwap = config.capUsdPerSwap ?? DEFAULT_CAP_USD
  if (!Number.isFinite(capUsdPerSwap) || capUsdPerSwap <= 0 || capUsdPerSwap > HARD_CAP_USD) throw new Error(`capUsdPerSwap must be > 0 and ≤ ${HARD_CAP_USD}`)
  const maxActive = config.maxActiveSwaps ?? 1
  if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error('maxActiveSwaps must be a positive integer')
  const now = config.now ?? Date.now
  const log = deps.log ?? ((message: string) => console.error(`buyer-kit: ${message}`))
  const hasDurableSweep = (): boolean => !!deps.wallet.buildSweep && !!deps.wallet.broadcastSweep && !!deps.wallet.isSweepConfirmed
  let reportNewWallet = !!config.newWallet
  // Keep every balance observation and durable admission of a new swap ordered with withdrawals.  The lifecycle that
  // follows the durable row is intentionally not held here: it has its own recovery protocol and may take minutes.
  let moneyOperation: Promise<void> = Promise.resolve()
  const serializeMoney = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = moneyOperation
    let release!: () => void
    moneyOperation = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  const write = async (record: BuyerSwapRecord, stage: BuyerSwapStage, extra: Partial<BuyerSwapRecord> = {}): Promise<BuyerSwapRecord> => {
    const next = { ...record, ...extra, stage, updatedAtMs: now() }
    await deps.store.put(next)
    return next
  }
  const issuedQuotes = new Map<string, BuyerQuote>()
  const quote = async (amountIn: bigint): Promise<BuyerQuote> => {
    const amountUsd = asUsd(amountIn)
    if (amountIn > BigInt(Math.floor(capUsdPerSwap * 1e6))) throw new Error(`amount exceeds this kit’s $${capUsdPerSwap} per-swap cap`)
    const reply = await deps.door.quote(amountIn, requestId())
    const units = BigInt(reply.usdcBaseUnits)
    if (units !== amountIn) throw new Error('market maker quote does not bind the exact USDC atomic amount requested')
    if (!Number.isSafeInteger(reply.bsvSats) || reply.bsvSats < 1 || reply.expiresAtMs <= now()) throw new Error('market maker returned an invalid or expired quote')
    const value = { from: 'USDC' as const, to: 'BSV' as const, route: 'bridge' as const, amountIn, amountOut: BigInt(reply.bsvSats), expiry: Math.floor(reply.expiresAtMs / 1000), quoteId: reply.quoteId, doorQuoteId: reply.quoteId, usdcBaseUnits: units, bsvSats: BigInt(reply.bsvSats), midUsdPerBsv: reply.midUsdPerBsv, claimFeeBudgetSats: buyerClaimFeeBudgetSats() }
    issuedQuotes.set(value.quoteId, value)
    for (const [id, saved] of issuedQuotes) if (saved.expiry * 1000 + 300_000 < now()) issuedQuotes.delete(id)
    return value
  }
  const run = async (record: BuyerSwapRecord): Promise<void> => {
    let settlementAttached = !!record.settlementHashHex
    const attachSettlement = (settlement: { hashHex: string; state: import('../../bridge/settlement-session').SettlementState }): void => {
      settlementAttached = true
      // The initiator invokes this immediately after its durable write-ahead record and before `evm.lock`.  Do not
      // await here: its callback is synchronous by design, and a cosmetic kit-store error must never reject the
      // money path.  The settlement record remains the crash-recovery source of truth.
      record = { ...record, settlementHashHex: settlement.hashHex, settlementState: settlement.state, settlementRecordCreated: true }
      void write(record, buyerStageForSettlement(settlement.state), { settlementHashHex: settlement.hashHex, settlementState: settlement.state, settlementRecordCreated: true })
        .then((saved) => { record = saved })
        .catch((error) => log(`could not persist settlement link for ${record.swapId}; recovery remains in the settlement store: ${error instanceof Error ? error.message : String(error)}`))
    }
    try {
      // The admission request is intentionally persisted before the executor can lock USDC. Retrying uses this requestId.
      const admission = await deps.door.admit(record.quote.doorQuoteId, BigInt(record.amountIn), record.requestId)
      if (admission.handshakeDeadlineMs <= now()) throw new Error('market maker admission expired before the handshake began')
      record = await write(record, 'admitted', { swapNamespace: admission.swapNamespace, handshakeDeadlineMs: admission.handshakeDeadlineMs })
      const result = await deps.executor.execute({
        swapId: record.swapId, quote: record.quote, swapNamespace: admission.swapNamespace, handshakeDeadlineMs: admission.handshakeDeadlineMs,
        // This is deliberately awaited by the initiator before it creates its settlement record.  A restart can now
        // distinguish a linked-but-not-created checkpoint from an unlinked pre-admission row.
        onSettlementLink: async (hashHex) => { record = await write(record, 'admitted', { settlementHashHex: hashHex, settlementRecordCreated: false }) },
        onSettlement: attachSettlement,
      })
      if (!result.ok) {
        // A settlement record, not a returned txid, is the at-risk boundary.  `evm.lock` can throw before returning a
        // txid, while its write-ahead record still makes a later Base refund necessary.
        // Legacy injected executors may only be able to report a landed lock txid.  The real engine always supplies
        // the stronger settlement-record signal, but a reported lock is still at-risk and must retain the old safe
        // refund behavior for embedders.
        await write(record, result.nothingLocked ? 'failed' : result.revealed ? 'claiming' : settlementAttached || !!result.baseLockTxid ? 'refund_waiting' : 'failed', { baseLockTxid: result.baseLockTxid, bsvClaimTxid: result.bsvClaimTxid, bsvClaimPayoutSats: result.bsvClaimPayoutSats, reason: result.reason ?? 'swap did not complete' })
        return
      }
      record = await write(record, 'claimed', { baseLockTxid: result.baseLockTxid, bsvClaimTxid: result.bsvClaimTxid, bsvClaimPayoutSats: result.bsvClaimPayoutSats, settlementState: 'settled' })
      // The engine may now compare-and-clear its terminal tombstone: this exact buyer row is durable.
      await deps.executor.acknowledgeTerminal?.(record)
      // Delivery is recovery-only: it waits for the claimed kit coin to have a
      // confirmation rather than sweeping immediately after a zero-conf claim.
      if (!record.deliverTo) await write(record, 'settled', { settlementState: 'settled' })
    } catch (error) {
      // Never decide that USDC was not locked from `baseLockTxid`: the executor intentionally writes an actionable
      // placeholder record before calling `evm.lock`, and that call can throw without a txid.
      try {
        const reason = error instanceof Error ? error.message : String(error)
        // The engine only emits this after the reverted receipt's exact tuple has been proven absent and its pre-lock
        // checkpoint cleared.  It is the one exception to the normal "a checkpoint means refund" rule.
        await write(record, reason === 'the USDC lock reverted; nothing was locked' ? 'failed' : record.settlementState === 'revealed' ? 'claiming' : settlementAttached || record.settlementHashHex ? 'refund_waiting' : 'failed', { reason })
      } catch (writeError) {
        log(`could not persist swap failure for ${record.swapId}; settlement recovery remains armed: ${writeError instanceof Error ? writeError.message : String(writeError)}`)
      }
    }
  }

  const startSwap = async (input: StartSwapRequest): Promise<{ swapId: string; stage: BuyerSwapStage; expectedMinutes: number }> => {
    // An explicitly undefined floor counts as absent (the MCP server always passes the key).
    if (input.minBsvOut !== undefined && (typeof input.minBsvOut !== 'bigint' || input.minBsvOut <= 0n)) {
      throw new Error('min_bsv_out must be a positive number of satoshis; nothing was locked')
    }
    const record = await serializeMoney(async () => {
      if (!input.quote && input.minBsvOut === undefined) throw new Error('a quote or min_bsv_out is required; nothing was locked')
      if (input.deliverTo) assertAddress(input.deliverTo)
      if (input.deliverTo && !hasDurableSweep()) throw new Error('deliver_to requires the durable sweep interface (buildSweep, broadcastSweep, and isSweepConfirmed)')
      if (input.amountIn < 1n || input.amountIn > 1_000_000_000n || input.amountIn > BigInt(Math.floor(capUsdPerSwap * 1e6))) throw new Error(`amount exceeds this kit’s $${capUsdPerSwap} per-swap cap`)
      const existing = (await deps.store.list()).filter((r) => !knownStage(r.stage) || active.has(r.stage))
      if (existing.length >= maxActive) throw new Error(`a swap is already active (${existing[0].swapId}: ${nextEvent(existing[0].stage)})`)
      // Do all locally decidable checks before touching the door. ETH need only be non-zero here: exact gas is priced by
      // the signed lock path, but a zero balance can never submit an approval/lock transaction.
      const balances = await deps.wallet.balances()
      if (balances.usdc < input.amountIn) throw new Error('insufficient USDC balance for this swap')
      if (balances.eth < 1n) throw new Error('insufficient ETH balance for Base gas')
      await deps.beforeNewSwap?.()
      const retained = input.quote ? issuedQuotes.get(input.quote.quoteId) : undefined
      if (input.quote && retained && Object.keys(input.quote).some((key) => (input.quote as any)[key] !== (retained as any)[key])) throw new Error('the quote was changed; pass quote_id')
      if (input.quote && !retained && input.minBsvOut === undefined) throw new Error('quote_id is unknown; get a new quote or provide min_bsv_out')
      const q = retained && retained.expiry * 1000 > now() ? retained : await quote(input.amountIn)
      if (q.amountIn !== input.amountIn || q.usdcBaseUnits !== input.amountIn) throw new Error('quote is not bound to this exact amount')
      const floor = input.minBsvOut ?? (retained ? retained.bsvSats * 99n / 100n : undefined)
      if (floor !== undefined && q.bsvSats < floor) throw new Error('price moved below the permitted BSV amount; nothing was locked')
      const next: BuyerSwapRecord = { schemaVersion: 2, swapId: swapId(), requestId: requestId(), stage: 'quoted', amountIn: input.amountIn.toString(), quote: q, deliverTo: input.deliverTo, createdAtMs: now(), updatedAtMs: now() }
      await deps.store.put(next) // durable BEFORE admission/lock
      return next
    })
    // Background lifecycle failures are represented durably by `run`; this final catch is only a belt-and-suspenders
    // guard against an unexpected implementation bug and must never become an unhandled rejection.
    void run(record).catch((error) => log(`background swap ${record.swapId} escaped lifecycle handling: ${error instanceof Error ? error.message : String(error)}`))
    return { swapId: record.swapId, stage: 'quoted', expectedMinutes: 20 }
  }

  return {
    quote: async (request): Promise<Quote> => {
      if (!isErc20(request.from) || request.from !== 'USDC' || !isBsv(request.to)) throw new Error('not available: only USDC → BSV through the market maker door')
      return quote(request.amountIn)
    },
    convert: async (request: ConvertRequest): Promise<SwapResult> => {
      if (request.from !== 'USDC' || request.to !== 'BSV') throw new Error('not available: only USDC → BSV through the market maker door')
      if (!request.quote) throw new Error('convert needs a quote from quote(); nothing was locked')
      const started = await startSwap({ amountIn: request.amountIn, deliverTo: request.deliverTo || undefined, quote: request.quote as BuyerQuote | undefined })
      return { ok: true, route: 'bridge', status: 'pending', txids: { swapId: started.swapId } }
    },
    startSwap,
    status: async (id?: string): Promise<BuyerSwapRecord[]> => {
      const records = id ? [await deps.store.get(id)].filter((x): x is BuyerSwapRecord => !!x) : await deps.store.list()
      return records
    },
    recover: async (): Promise<BuyerSwapRecord[]> => {
      const records = await deps.store.list()
      const all = deps.executor.recoverAll ? await deps.executor.recoverAll(records) : undefined
      for (const record of records) {
        // A terminal buyer observation is authoritative.  It may acknowledge a
        // leftover engine tombstone, but is never re-derived or rewritten.
        // A persisted stage is untrusted.  Let durable settlement recovery
        // replace it when it can; otherwise turn it into the current explicit
        // attention state so a later recovery has a known state to render.
        if (!knownStage(record.stage)) {
          const derived = all?.get(record.swapId) ?? await deps.executor.recover?.(record)
          await write(record, derived?.stage ?? 'needs_attention', derived ?? {
            reason: 'an older or unknown record; recovery will update it',
          })
          continue
        }
        if (terminal.has(record.stage)) {
          if (record.settlementState === 'settled' || record.settlementState === 'refunded' || record.settlementState === 'aborted') await deps.executor.acknowledgeTerminal?.(record)
          continue
        }
        // A sweeping row's settlement is already final; the sweep loop below owns it until delivery is confirmed.
        if (record.stage === 'sweeping') continue
        const derived = all?.get(record.swapId)
        if (derived) {
          const saved = await write(record, derived.stage, derived)
          if (saved.settlementState === 'settled' || saved.settlementState === 'refunded' || saved.settlementState === 'aborted') await deps.executor.acknowledgeTerminal?.(saved)
          continue
        }
        if (!deps.executor.recover) continue
        const outcome = await deps.executor.recover(record)
        if (outcome) {
          const saved = await write(record, outcome.stage, outcome)
          if (saved.settlementState === 'settled' || saved.settlementState === 'refunded' || saved.settlementState === 'aborted') await deps.executor.acknowledgeTerminal?.(saved)
        }
      }
      // A claim is not safe to deliver until it has independently buried.  This
      // is deliberately recovery work so the process can restart between claim
      // and confirmation without prematurely sweeping a zero-conf output.
      for (const record of await deps.store.list()) {
        if (!record.deliverTo || !record.bsvClaimTxid || (record.stage !== 'claimed' && record.stage !== 'settled' && record.stage !== 'sweeping')) continue
        try {
          let outbox = record.sweepOutbox
          if (!outbox && deps.wallet.buildSweep) {
            const built = await deps.wallet.buildSweep(record.deliverTo, { onlyTxid: record.bsvClaimTxid })
            outbox = { ...built, sats: built.sats.toString() }
            // The signed transaction is durable before it can escape to a relay.
            await write(record, 'sweeping', { sweepOutbox: outbox })
          }
          if (outbox && deps.wallet.broadcastSweep && deps.wallet.isSweepConfirmed) {
            // Check before re-sending: a relay can reject a mined sweep (its input is spent), which must not hide delivery.
            if (await deps.wallet.isSweepConfirmed(outbox.txid, record.deliverTo)) { await write(record, 'delivered'); continue }
            await deps.wallet.broadcastSweep(outbox) // safe to repeat: it is the exact durable transaction
            if (await deps.wallet.isSweepConfirmed(outbox.txid, record.deliverTo)) await write(record, 'delivered')
          } else if (!hasDurableSweep()) {
            log(`cannot automatically deliver_to for ${record.swapId}: deliver_to needs the durable sweep interface (buildSweep, broadcastSweep, and isSweepConfirmed)`)
          }
        } catch (error) {
          log(`could not sweep confirmed BSV for ${record.swapId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return deps.store.list()
    },
    withdrawBsv: async (address) => serializeMoney(async () => {
      assertAddress(address)
      const blocked = (await deps.store.list()).find((r) => !knownStage(r.stage) || active.has(r.stage) || (!!r.deliverTo && ['claimed', 'settled', 'sweeping'].includes(r.stage)))
      if (blocked) throw new Error(`a swap blocks withdrawals (${blocked.swapId}: ${nextEvent(blocked.stage)})`)
      if (!deps.wallet.withdrawBsv) throw new Error('BSV sweeping is not configured')
      return deps.wallet.withdrawBsv(address)
    }),
    withdrawBase: async ({ asset, to, amount }) => serializeMoney(async () => {
      if (!isAddress(to, { strict: true }) || /^0x0{40}$/i.test(to)) throw new Error('to must be a non-zero checksummed Base address')
      if (to.toLowerCase() === deps.wallet.baseAddress.toLowerCase()) throw new Error('cannot withdraw to the kit address')
      if ((config.baseWithdrawalForbidden ?? []).some((address) => address.toLowerCase() === to.toLowerCase())) throw new Error('cannot withdraw to a swap or token contract')
      const blocked = (await deps.store.list()).find((r) => !knownStage(r.stage) || active.has(r.stage) || (!!r.deliverTo && ['claimed', 'settled', 'sweeping'].includes(r.stage)))
      if (blocked) throw new Error(`a swap blocks withdrawals (${blocked.swapId}: ${nextEvent(blocked.stage)})`)
      if (!/^(?:all|[1-9]\d*)$/.test(amount)) throw new Error('amount must be a positive atomic decimal string or all')
      const balances = await deps.wallet.balances(); let value: bigint
      if (asset === 'USDC') { value = amount === 'all' ? balances.usdc : BigInt(amount); if (value < 1n || value > balances.usdc) throw new Error('amount exceeds USDC balance'); if (balances.eth < 1n) throw new Error('ETH is needed for Base gas'); if (!deps.wallet.transferUsdc) throw new Error('Base USDC withdrawals are not configured'); const sent = await deps.wallet.transferUsdc(to as `0x${string}`, value); if (sent.status !== 'success') throw new Error('Base USDC transfer reverted'); return { asset, amount: value, to, txid: sent.hash, status: sent.status } }
      if (asset !== 'ETH') throw new Error('asset must be USDC or ETH')
      if (amount === 'all') { if (balances.usdc > 0n) throw new Error('withdraw the USDC first; it needs ETH for gas'); if (!deps.wallet.estimateEthTransferFee) throw new Error('Base ETH gas estimation is not configured'); const fee = await deps.wallet.estimateEthTransferFee(to as `0x${string}`); value = balances.eth - fee * 12n / 10n } else value = BigInt(amount)
      if (value < 1n || value > balances.eth) throw new Error('amount exceeds ETH balance'); if (!deps.wallet.transferEth) throw new Error('Base ETH withdrawals are not configured'); const sent = await deps.wallet.transferEth(to as `0x${string}`, value); if (sent.status !== 'success') throw new Error('Base ETH transfer reverted'); return { asset, amount: value, to, txid: sent.hash, status: sent.status }
    }),
    walletInfo: async () => {
      const isNew = reportNewWallet; reportNewWallet = false
      return { ...await deps.wallet.balances(), baseAddress: deps.wallet.baseAddress, bsvAddress: deps.wallet.bsvAddress, capUsdPerSwap,
        ...(isNew ? { new_wallet: true, backup_note: `Back up ${config.keysPath ?? 'keys.json'}: it is the only copy of this kit's keys.` } : {}) }
    },
  }
}
