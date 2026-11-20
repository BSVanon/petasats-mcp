/**
 * buy_gas: sell exactly 0.50 USDC from the kit's own Base balance for native ETH paid to the kit, through one CoW
 * Protocol order whose USDC allowance is an EIP-2612 permit carried as an appData pre-hook. A CoW Protocol solver
 * settles it and pays the gas; the kit sends no Base transaction. One step per call. The kit holds its money lock
 * around every call and its home lock keeps other processes out. A record keeps blocking until the chain shows that
 * its order can no longer spend, whatever the order book answers, so a new order is signed only when no earlier one
 * can still fill.
 */
import type { Address, Hex, LocalAccount } from 'viem'
import { CowApiError, type CowOrderBook } from './gas-topup-api'
import {
  ALREADY_HAS_GAS_WEI, assertSignableOrder, assertSignablePermit, buildGasAppData, buildGasOrder, buildGasPermit, checkGasQuote,
  COW_ORDER_DOMAIN, COW_ORDER_URL, GAS_TOPUP_EXPIRY_GRACE_SECONDS, GAS_TOPUP_MAX_AHEAD_SECONDS, GAS_TOPUP_MAX_CLOCK_SKEW_SECONDS,
  GAS_TOPUP_SELL, GAS_TOPUP_VALID_FOR_SECONDS, hashAppData, minusSlippage, ORDER_TYPES, orderCreationBody, orderUid,
  PERMIT_TYPES, permitCallData, placeholderPermitCallData, quoteRequestBody, USDC_PERMIT_DOMAIN, usdcDomainSeparator,
  type GasAppData, type GasOrder,
} from './gas-topup-order'
import {
  archiveGasTopUp, GAS_TOPUP_MAY_HAVE_FILLED, GAS_TOPUP_SWAP_MESSAGE, GAS_TOPUP_WAIT_MESSAGE, isOpenGasTopUp, loadGasTopUp,
  writeGasTopUp, type GasTopUpRecord,
} from './gas-topup-state'
import type { BuyerGasTopUp, GasTopUpStep } from './types'

/** One pinned Base block: every value is read at the same block, so its time, balances and nonce agree. */
export interface GasTopUpChainView {
  /** The block every read in this view is pinned to. */
  blockNumber: bigint
  timestamp: bigint
  eth: bigint
  usdc: bigint
  usdcNonce: bigint
  usdcDomainSeparator: Hex
  /** USDC.allowance(kit, COW_VAULT_RELAYER): a new order is signed only while it is below the sell amount. */
  allowance: bigint
  /** GPv2Settlement.filledAmount(uid), present when a uid was asked for. */
  filledAmount?: bigint
}
export interface GasTopUpDeps {
  home: string
  owner: Address
  chain: { read(uid?: Hex): Promise<GasTopUpChainView> }
  api: CowOrderBook
  /** A viem local account's signTypedData: the key stays inside the account. */
  signTypedData: LocalAccount['signTypedData']
  /**
   * Record timestamps, and the local clock a new order is checked against: the Base block time must be within 10
   * minutes of it, and validTo at most 25 minutes past it. A record ends by expiry only when both the Base block time
   * and this clock are past validTo plus the grace.
   */
  now?: () => number
}

const CALL_AGAIN_SECONDS = 30
/** A 'signed' order is re-posted only while the order book would still accept its validTo (60 s minimum, plus margin). */
const REPOST_MIN_REMAINING_SECONDS = 90n
const SEND_ETH = "send a little ETH for gas to the kit's Base address instead"
const EXPIRED_UNSOLD = 'no CoW Protocol solver filled the order before it expired; nothing was sold'
const NOT_ON_RPC_YET = 'the ETH from this gas purchase does not show on the Base RPC yet; check wallet_info again shortly'
const CLOCK_SKEW = "the Base block time and this computer's clock differ by more than 10 minutes; nothing was signed"
const FILL_NOT_SHOWN = "the Base RPC no longer shows this order's fill; the kit treats it as open until it expires; call buy_gas again to check it"
const REJECTED_OPEN = 'nothing was sold so far, but the kit treats the order as open until it expires; call buy_gas again after it expires to check it'
/** The block rule's note on a record that did not end 'filled': no ETH is coming for it, unlike NOT_ON_RPC_YET. */
const OLDER_BLOCK_NOTE = "this answer comes from an older Base block than the kit's last check; nothing new was signed; call buy_gas again shortly"

/** An order ends by expiry only when both the Base block time and the local clock are past validTo plus the grace. */
const pastGrace = (record: GasTopUpRecord, viewSeconds: bigint, localSeconds: number): boolean =>
  viewSeconds > BigInt(record.validTo + GAS_TOPUP_EXPIRY_GRACE_SECONDS) && localSeconds > record.validTo + GAS_TOPUP_EXPIRY_GRACE_SECONDS
/** The order book's executedBuyAmount is stored and reported only from buyAmountMin up to twice it. */
const plausibleEth = (record: GasTopUpRecord, amount: string | undefined): amount is string =>
  amount !== undefined && BigInt(amount) >= BigInt(record.buyAmountMin) && BigInt(amount) <= 2n * BigInt(record.buyAmountMin)

function formatUnits(value: bigint, decimals: number, symbol: string, minimumFraction = 0): string {
  const digits = value.toString().padStart(decimals + 1, '0')
  const fraction = digits.slice(-decimals).replace(/0+$/, '').padEnd(minimumFraction, '0')
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ''} ${symbol}`
}
export const formatEth = (wei: bigint): string => formatUnits(wei, 18, 'ETH')
const formatUsdc = (units: bigint): string => formatUnits(units, 6, 'USDC', 2)
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const short = (error: unknown): string => message(error).slice(0, 300)
const refused = (reason: string): GasTopUpStep => ({ state: 'refused', reason })

export function makeBuyerGasTopUp(deps: GasTopUpDeps): BuyerGasTopUp {
  const now = deps.now ?? Date.now
  const owner = deps.owner
  const save = (record: GasTopUpRecord): GasTopUpRecord => { writeGasTopUp(deps.home, record); return record }
  const signedOrder = (record: GasTopUpRecord): { order: GasOrder; appData: GasAppData } => {
    const appData = hashAppData(record.appData)
    return { appData, order: buildGasOrder({ owner, buyAmount: BigInt(record.buyAmountMin), validTo: record.validTo, appDataHash: appData.hash }) }
  }
  /** A record is acted on only when it is this kit's and its fields rebuild exactly the order its uid names. */
  const load = (): GasTopUpRecord | undefined => loadGasTopUp(deps.home, owner)

  /** POST the stored signed order. An answer is only reported in the record: a 4xx never ends it. */
  const post = async (record: GasTopUpRecord): Promise<GasTopUpRecord> => {
    const { order, appData } = signedOrder(record)
    let uid: string
    try {
      uid = await deps.api.postOrder(orderCreationBody(order, owner, record.signature as Hex, appData, record.quoteId))
    } catch (error) {
      if (error instanceof CowApiError && error.kind === 'rejected') {
        if (error.errorType === 'DuplicatedOrder') return save({ ...record, status: 'posted', postedAt: record.postedAt ?? now() })
        return save({ ...record, status: 'rejected', reason: error.message })
      }
      return record // no answer: it may have been accepted, so it stays 'signed' and the next call finds out
    }
    if (uid.toLowerCase() !== record.uid.toLowerCase()) {
      return save({ ...record, status: 'rejected', reason: `the CoW Protocol order book answered with uid ${uid}, not this order's uid ${record.uid}; it is not treated as posted` })
    }
    return save({ ...record, status: 'posted', postedAt: now() })
  }

  /**
   * Bring a record up to date. The order book's answer is only reported in it; the chain alone ends it: filledAmount
   * equal to the sell amount (filled), or a block time past validTo plus the grace while the local clock is past it
   * too (expired). A failed chain read ends nothing. Re-posts the same signed order only when asked to, and returns
   * the chain view it read, if any.
   */
  const reconcile = async (record: GasTopUpRecord, repost: boolean): Promise<{ record: GasTopUpRecord; view?: GasTopUpChainView }> => {
    let current = record
    try {
      const book = await deps.api.getOrder(current.uid)
      if (book?.status === 'fulfilled') current = save({ ...current, status: 'filled', ...(plausibleEth(current, book.executedBuyAmount) ? { executedBuyAmount: book.executedBuyAmount } : {}) })
      else if (book && current.status !== 'posted') current = save({ ...current, status: 'posted', postedAt: current.postedAt ?? now() })
    } catch { /* no answer; the chain below still decides fills and expiry */ }
    let view: GasTopUpChainView | undefined
    try { view = await deps.chain.read(current.uid as Hex) } catch { view = undefined }
    if (view?.filledAmount !== undefined) {
      // Only the exact sell amount is a fill: GPv2Settlement.invalidateOrder writes 2^256 - 1, which is not one.
      if (view.filledAmount === BigInt(current.sellAmount)) {
        const { reason: _reason, ...filled } = current // a refusal the order book gave before the fill is not kept
        return { record: save({ ...filled, status: 'filled', over: true, overAtBlock: view.blockNumber.toString() }), view }
      }
      // A new order is signed only while the kit's USDC allowance for the vault relayer is below the sell amount, so
      // any fill needs the order's permit, and the permit moves the nonce. An expired order's permit has passed its
      // deadline (validTo), so it can no longer run. A solver may later clear an expired order's filledAmount, and an
      // unchanged nonce still shows that nothing was pulled.
      if (pastGrace(current, view.timestamp, Math.floor(now() / 1000))) {
        const unsold = view.filledAmount === 0n && view.usdcNonce === BigInt(current.permitNonce)
        const outcome: Partial<GasTopUpRecord> = !unsold ? { status: 'expired', reason: GAS_TOPUP_MAY_HAVE_FILLED }
          : current.status === 'rejected' ? {} : { status: 'expired', reason: EXPIRED_UNSOLD }
        const { executedBuyAmount: _amount, ...ended } = current // the order book's amount stays only on a fill
        return { record: save({ ...ended, ...outcome, over: true, overAtBlock: view.blockNumber.toString() }), view }
      }
    }
    if (repost && current.status === 'signed' && view && BigInt(current.validTo) - view.timestamp > REPOST_MIN_REMAINING_SECONDS) return { record: await post(current), view }
    return { record: current, view }
  }

  const step = (record: GasTopUpRecord, view?: GasTopUpChainView, note?: string): GasTopUpStep => {
    const common = { uid: record.uid, order_url: `${COW_ORDER_URL}${record.uid}`, min_eth: formatEth(BigInt(record.buyAmountMin)) }
    if (record.status === 'signed' || record.status === 'posted') {
      const tooLateToPost = view !== undefined && BigInt(record.validTo) - view.timestamp <= REPOST_MIN_REMAINING_SECONDS
      return {
        state: 'pending', ...common, sold: '0.50 USDC', call_again_after_seconds: CALL_AGAIN_SECONDS,
        note: note ?? (record.status === 'posted' ? 'the order is waiting for a CoW Protocol solver; call buy_gas again to check it'
          : tooLateToPost ? 'the order is signed and saved, but too little time is left to post it; call buy_gas again after it expires to check it'
            : 'the order is signed and saved, and the CoW Protocol order book has not confirmed it yet; call buy_gas again to finish posting it'),
      }
    }
    if (record.status === 'filled') {
      const shown = note ?? (record.over ? undefined : NOT_ON_RPC_YET) // the order book's word alone: the chain has not shown it
      return { state: 'filled', ...common, sold: '0.50 USDC', ...(plausibleEth(record, record.executedBuyAmount) ? { eth_received: formatEth(BigInt(record.executedBuyAmount)) } : {}), ...(shown === undefined ? {} : { note: shown }) }
    }
    const noted = note === undefined ? {} : { note }
    if (record.status === 'rejected') {
      // The order book's refusal alone: the order may still have been stored, so nothing is final until the chain ends it.
      const refusal = record.reason === undefined ? '' : `${record.reason}; `
      return record.over ? { state: 'rejected', ...common, sold: 'nothing', reason: `${refusal}nothing was sold`, ...noted }
        : { state: 'rejected', ...common, sold: 'nothing so far', reason: `${refusal}${REJECTED_OPEN}`, ...noted }
    }
    return { state: record.status, ...common, sold: record.reason === GAS_TOPUP_MAY_HAVE_FILLED ? 'up to 0.50 USDC' : 'nothing', reason: record.reason ?? 'nothing was sold', ...noted }
  }

  const buy = async (opts: { beforeNewOrder?: () => Promise<void>; beforeSave?: () => void | Promise<void> } = {}): Promise<GasTopUpStep> => {
    let existing: GasTopUpRecord | undefined
    try { existing = load() } catch (error) { return refused(message(error)) } // an unreadable record refuses before anything is read or signed
    if (existing && isOpenGasTopUp(existing)) {
      const latest = await reconcile(existing, true)
      // The chain is past the order's end and this computer's clock is not, by more than 10 minutes: the record stays
      // open, and the refusal names the clock, so a wrong clock never makes a wait with no end.
      const end = latest.record.validTo + GAS_TOPUP_EXPIRY_GRACE_SECONDS
      const localNow = Math.floor(now() / 1000)
      if (isOpenGasTopUp(latest.record) && latest.view && latest.view.timestamp > BigInt(end) && localNow <= end
        && Number(latest.view.timestamp) - localNow > GAS_TOPUP_MAX_CLOCK_SKEW_SECONDS) return refused(CLOCK_SKEW)
      return step(latest.record, latest.view)
    }
    // No earlier order can still fill. The kit's own wait (a Base withdrawal or swap lock) runs before the new order's chain read.
    try { await opts.beforeNewOrder?.() } catch (error) { return refused(message(error)) }
    // A filled record's fill must show again in this read until it is past validTo plus the grace on both clocks.
    const filled = existing?.status === 'filled' ? existing : undefined
    let view: GasTopUpChainView
    try { view = await deps.chain.read(filled ? filled.uid as Hex : undefined) } catch (error) {
      return refused(`the Base RPC could not be read (${short(error)}); nothing was signed; call buy_gas again shortly, or ${SEND_ETH}`)
    }
    const localSeconds = Math.floor(now() / 1000)
    if (filled && !pastGrace(filled, view.timestamp, localSeconds) && view.filledAmount !== BigInt(filled.sellAmount)) {
      // The kit trusts the eth_call answers of the gated Base RPC pool, as it does for balances. A fill one read showed
      // and a later read does not show reopens the record, so no new order is signed beside one that may still fill.
      // This also runs on a read older than overAtBlock (the block rule below): a lagging or faked block number must
      // never hide a vanished fill behind NOT_ON_RPC_YET and lock the kit into a wait that never ends.
      const { over: _over, overAtBlock: _block, ...reopened } = filled
      return step(save({ ...reopened, status: 'posted' }), view, FILL_NOT_SHOWN)
    }
    // A read from a block before the one that ended the last record may not show its fill yet. Every read from before
    // a fill is such a read, so this also covers a USDC permit nonce that has not moved yet at the read's block. A
    // record that did not end 'filled' (expired, or rejected) is told so with a different note: no ETH is coming for it.
    // Base is an OP-stack chain, where a block's time is fixed by its height: a block replaced at the same height keeps
    // its time, so an order seen past its end stays past it. Only a chain head that moves back below overAtBlock could
    // show the order as live again; this rule then still signs nothing, while withdrawals, swaps and close_kit trust
    // the stored end.
    if (existing?.overAtBlock !== undefined && view.blockNumber < BigInt(existing.overAtBlock)) {
      return step(existing, undefined, existing.status === 'filled' ? NOT_ON_RPC_YET : OLDER_BLOCK_NOTE)
    }
    if (Math.abs(Number(view.timestamp) - localSeconds) > GAS_TOPUP_MAX_CLOCK_SKEW_SECONDS) return refused(CLOCK_SKEW)
    if (view.eth >= ALREADY_HAS_GAS_WEI) return refused(`the kit already has gas (${formatEth(view.eth)}); nothing was signed`)
    if (view.usdc < GAS_TOPUP_SELL) return refused(`buy_gas needs 0.50 USDC in the kit, and it has ${formatUsdc(view.usdc)}; nothing was signed; ${SEND_ETH}`)
    // A standing allowance lets a settlement take the USDC without the order's permit, so an unmoved permit nonce could
    // not later show that nothing sold: a new order is signed only while the allowance is below the sell amount.
    if (view.allowance >= GAS_TOPUP_SELL) return refused(`a USDC allowance of 0.50 USDC or more for the CoW Protocol vault relayer already exists, so the kit could not later tell whether a new order sold; nothing was signed; ${SEND_ETH}`)
    if (view.usdcDomainSeparator.toLowerCase() !== usdcDomainSeparator().toLowerCase()) {
      return refused("Base USDC's signing domain is not the one this kit signs permits for; nothing was signed")
    }
    // The chain's clock sets validTo, never more than 25 minutes past the local clock; the permit deadline is validTo.
    const validTo = Math.min(Number(view.timestamp) + GAS_TOPUP_VALID_FOR_SECONDS, localSeconds + GAS_TOPUP_MAX_AHEAD_SECONDS)
    const permit = buildGasPermit(owner, view.usdcNonce, validTo)
    let quote: unknown
    try { quote = await deps.api.quote(quoteRequestBody(owner, validTo, buildGasAppData(placeholderPermitCallData(permit)))) } catch (error) {
      return refused(`CoW Protocol could not quote the gas purchase (${short(error)}); nothing was signed; call buy_gas again later, or ${SEND_ETH}`)
    }
    let quoted: { buyAmount: bigint; quoteId?: number }
    try { quoted = checkGasQuote(quote as Parameters<typeof checkGasQuote>[0], owner) } catch (error) {
      return refused(`CoW Protocol's quote was not accepted: ${short(error)}; nothing was signed; ${SEND_ETH}`)
    }
    const plan = { owner, nonce: view.usdcNonce, validTo, quoteBuyAmount: quoted.buyAmount }
    try { assertSignablePermit(permit, plan) } catch (error) { return refused(short(error)) }
    const permitSignature = await deps.signTypedData({ domain: USDC_PERMIT_DOMAIN, types: PERMIT_TYPES, primaryType: 'Permit', message: permit })
    const appData = buildGasAppData(permitCallData(permit, permitSignature))
    const order = buildGasOrder({ owner, buyAmount: minusSlippage(quoted.buyAmount), validTo, appDataHash: appData.hash })
    try { assertSignableOrder(order, plan, appData, permit, permitSignature) } catch (error) { return refused(short(error)) }
    const signature = await deps.signTypedData({ domain: COW_ORDER_DOMAIN, types: ORDER_TYPES, primaryType: 'Order', message: order })
    const record: GasTopUpRecord = {
      uid: orderUid(order, owner), owner, sellAmount: GAS_TOPUP_SELL.toString(), buyAmountMin: order.buyAmount.toString(), validTo,
      permitNonce: view.usdcNonce.toString(), appDataHash: appData.hash, appData: appData.json, signature,
      ...(quoted.quoteId === undefined ? {} : { quoteId: quoted.quoteId }), signedAt: now(), status: 'signed',
    }
    // A STOP can land while the quote is in flight: checked again here, so a stopped kit saves and posts nothing.
    try { await opts.beforeSave?.() } catch (error) { return refused(message(error)) }
    if (existing) archiveGasTopUp(deps.home, existing) // the finished record joins the history before the new one replaces it
    save(record) // durable before the order book ever sees it
    return step(await post(record))
  }

  return {
    buy,
    assertNoOpenOrder: async (purpose) => {
      const record = load()
      if (!record || !isOpenGasTopUp(record)) return
      const { record: current } = await reconcile(record, false)
      if (isOpenGasTopUp(current)) throw new Error(purpose === 'swap' ? GAS_TOPUP_SWAP_MESSAGE : GAS_TOPUP_WAIT_MESSAGE)
    },
    view: () => {
      try {
        const record = load()
        return record ? { status: record.status, uid: record.uid, open: isOpenGasTopUp(record) } : undefined
      } catch { return { status: 'unreadable' } }
    },
  }
}
