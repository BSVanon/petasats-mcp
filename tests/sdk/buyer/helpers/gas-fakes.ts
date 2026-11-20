import { decodeFunctionData, isAddressEqual, keccak256, recoverTypedDataAddress, stringToBytes, type Address, type Hex } from 'viem'
import { BASE_USDC } from '../../../../src/bridge/evm/base-tokens'
import type { GasTopUpChainView } from '../../../../src/sdk/buyer/gas-topup'
import { COW_NATIVE_ETH, COW_ORDER_DOMAIN, COW_VAULT_RELAYER, ORDER_TYPES, orderUid, PERMIT_TYPES, USDC_PERMIT_DOMAIN, usdcDomainSeparator, type GasOrder } from '../../../../src/sdk/buyer/gas-topup-order'

/** A pinned-block Base view the test moves by hand, with the kit's USDC allowance to the CoW vault relayer. */
export class FakeGasChain {
  timestamp = 1_800_000_000n
  eth = 0n
  usdc = 2_000_000n
  usdcNonce = 7n
  /** USDC.allowance(kit, vault relayer): a permit sets it, and a fill uses it up. */
  allowance = 0n
  separator: Hex = usdcDomainSeparator()
  readonly filled = new Map<string, bigint>()
  failReads = 0
  reads = 0
  /** The block the last read was pinned to: each read that succeeds sees a later block, as a live chain moves on. */
  blockNumber = 1_000n
  async read(uid?: Hex): Promise<GasTopUpChainView> {
    this.reads++
    if (this.failReads > 0) { this.failReads--; throw new Error('synthetic Base RPC failure') }
    this.blockNumber++
    return { blockNumber: this.blockNumber, timestamp: this.timestamp, eth: this.eth, usdc: this.usdc, usdcNonce: this.usdcNonce, usdcDomainSeparator: this.separator, allowance: this.allowance, ...(uid === undefined ? {} : { filledAmount: this.filled.get(uid.toLowerCase()) ?? 0n }) }
  }
  /** A local clock in step with this chain's block time, so the kit's clock check passes. */
  readonly clock = (): number => Number(this.timestamp) * 1000
}

const PERMIT_CALL_ABI = [{
  type: 'function', name: 'permit', stateMutability: 'nonpayable', outputs: [],
  inputs: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
  ],
}] as const

/** Order-book text the kit must never pass on. */
export const UNTRUSTED_ERROR_TYPE = 'UnlistedErrorType7f3a'
export const UNTRUSTED_DESCRIPTION = 'untrusted order book text 7f3a: none of this sentence may reach a message, a reason or a record'

export type FakeReply = { status: number; body?: unknown } | 'network'
/** POST modes: the answer is lost, or the order book stores (or stores and fills) the order and still answers 4xx. */
export type FakePostMode = 'store-then-network' | 'store-then-refuse' | 'fill-then-refuse'
interface StoredOrder { uid: string; status: string; body: Record<string, any>; executedBuyAmount?: string }
interface HookPermit { owner: Address; spender: Address; value: bigint; deadline: bigint; signature: Hex }

/** The order a POST body signs, rebuilt field by field from the body as the order book would. */
export function orderFromBody(body: Record<string, any>): GasOrder {
  return {
    sellToken: body.sellToken, buyToken: body.buyToken, receiver: body.receiver, sellAmount: BigInt(body.sellAmount), buyAmount: BigInt(body.buyAmount),
    validTo: body.validTo, appData: body.appDataHash, feeAmount: BigInt(body.feeAmount), kind: body.kind, partiallyFillable: body.partiallyFillable,
    sellTokenBalance: body.sellTokenBalance, buyTokenBalance: body.buyTokenBalance,
  }
}

/** The USDC permit an appData carries as its pre-hook. */
function hookPermit(appData: string): HookPermit | undefined {
  const hook = JSON.parse(appData)?.metadata?.hooks?.pre?.[0]
  if (!hook || !isAddressEqual(hook.target, BASE_USDC)) return undefined
  const [owner, spender, value, deadline, v, r, s] = decodeFunctionData({ abi: PERMIT_CALL_ABI, data: hook.callData }).args
  return { owner, spender, value, deadline, signature: `${r}${s.slice(2)}${v.toString(16).padStart(2, '0')}` as Hex }
}

/**
 * The CoW Protocol order book as a fetch handler. It applies the checks the live order book applies to this order:
 * zero fee, the appData hash, the signature's owner, validTo bounds, duplicates, and the balance and allowance check,
 * with the permit pre-hook simulated against the fake chain's current nonce, or a standing allowance.
 */
export class FakeCowOrderBook {
  readonly orders = new Map<string, StoredOrder>()
  readonly posts: Array<Record<string, any>> = []
  readonly quotes: Array<Record<string, any>> = []
  gets = 0
  ethUsd = 1800n
  feeUnits = 1_700n
  /** Check the quote, balance and allowance before looking for a duplicate, as the live order book may. */
  duplicateCheckLast = false
  /** Refuse a POST that names a quoteId as InvalidQuote, as once the quote has expired (about 2 minutes). */
  quoteExpired = false
  quoteReply?: (body: Record<string, any>) => FakeReply | Promise<FakeReply>
  postReply?: (body: Record<string, any>) => FakeReply | FakePostMode | undefined
  getReply?: (uid: string) => FakeReply | undefined
  /** The nonce each stored order's permit pre-hook can run at: the nonce that was current when it was accepted. */
  private readonly hookNonce = new Map<string, bigint>()
  constructor(private readonly chain: FakeGasChain) {}

  /** Honors the request's abort signal, as fetch does, so a hung reply becomes the client's timeout. */
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const work = this.handle(String(input), init)
    const signal = init?.signal
    if (!signal) return work
    return await new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason ?? new Error('aborted'))
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
      work.then((response) => { signal.removeEventListener('abort', onAbort); resolve(response) }, (error) => { signal.removeEventListener('abort', onAbort); reject(error) })
    })
  }) as typeof fetch

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, any>
    let reply: FakeReply
    if (method === 'POST' && url.endsWith('/quote')) {
      this.quotes.push(body!)
      reply = this.quoteReply ? await this.quoteReply(body!) : this.answerQuote(body!)
    } else if (method === 'POST' && url.endsWith('/orders')) {
      this.posts.push(body!)
      const forced = this.postReply?.(body!)
      if (forced === 'store-then-network' || forced === 'store-then-refuse' || forced === 'fill-then-refuse') {
        const stored = await this.acceptOrder(body!)
        if (stored.status === 201 && forced === 'fill-then-refuse') this.settle(stored.body as string)
        reply = stored.status !== 201 ? stored : forced === 'store-then-network' ? 'network' : this.refuse('InsufficientAllowance', 'no allowance after pre-hooks')
      } else reply = forced ?? await this.acceptOrder(body!)
    } else if (method === 'GET' && url.includes('/orders/')) {
      this.gets++
      const uid = url.slice(url.lastIndexOf('/') + 1)
      const order = this.orders.get(uid.toLowerCase())
      reply = this.getReply?.(uid) ?? (order
        ? { status: 200, body: { uid: order.uid, status: order.status, executedBuyAmount: order.executedBuyAmount ?? '0', sellAmount: order.body.sellAmount } }
        : { status: 404, body: { errorType: 'NotFound', description: 'Order was not found' } })
    } else reply = { status: 404 }
    if (reply === 'network') throw new TypeError('fetch failed')
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
  }

  answerQuote(body: Record<string, any>): FakeReply {
    const sellAmount = BigInt(body.sellAmountBeforeFee) - this.feeUnits
    const buyAmount = (sellAmount * 10n ** 18n) / (this.ethUsd * 1_000_000n)
    return { status: 200, body: {
      quote: { sellToken: body.sellToken, buyToken: body.buyToken, receiver: body.receiver, sellAmount: sellAmount.toString(), buyAmount: buyAmount.toString(), validTo: body.validTo, appData: body.appDataHash, feeAmount: this.feeUnits.toString(), kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', signingScheme: 'eip712' },
      from: body.from, expiration: '2027-01-15T00:00:00.000Z', id: 4242, verified: true,
    } }
  }

  private refuse(errorType: string, description: string): { status: number; body: unknown } {
    return { status: 400, body: { errorType, description } }
  }

  /** The order book's checks; a 201 stores the order under the uid the order book computes from the signed order. */
  async acceptOrder(body: Record<string, any>): Promise<{ status: number; body?: unknown }> {
    if (body.feeAmount !== '0') return this.refuse('NonZeroFee', 'Fee must be zero')
    if (typeof body.appData !== 'string' || keccak256(stringToBytes(body.appData)) !== body.appDataHash) return this.refuse('AppDataHashMismatch', 'appData hash mismatch')
    if (Buffer.byteLength(body.appData) > 8192) return this.refuse('InvalidAppData', 'too large')
    const order = orderFromBody(body)
    const signer = await recoverTypedDataAddress({ domain: COW_ORDER_DOMAIN, types: ORDER_TYPES, primaryType: 'Order', message: order, signature: body.signature })
    if (!isAddressEqual(signer, body.from)) return this.refuse('WrongOwner', 'signature does not recover to from')
    if (BigInt(body.validTo) < this.chain.timestamp + 60n) return this.refuse('InsufficientValidTo', 'validTo is too soon')
    const uid = orderUid(order, signer)
    if (!this.duplicateCheckLast && this.orders.has(uid)) return this.refuse('DuplicatedOrder', 'order already exists')
    if (this.quoteExpired && body.quoteId !== undefined) return this.refuse('InvalidQuote', 'quote expired')
    if (this.chain.usdc < order.sellAmount) return this.refuse('InsufficientBalance', 'balance too low')
    const permit = await this.currentPermit(body.appData, signer)
    const hookAllows = permit !== undefined && permit.value >= order.sellAmount
    if ((!hookAllows && this.chain.allowance < order.sellAmount) || !isAddressEqual(order.buyToken, COW_NATIVE_ETH)) return this.refuse('InsufficientAllowance', 'no allowance after pre-hooks')
    if (this.orders.has(uid)) return this.refuse('DuplicatedOrder', 'order already exists')
    this.orders.set(uid, { uid, status: 'open', body })
    if (permit) this.hookNonce.set(uid, this.chain.usdcNonce)
    return { status: 201, body: uid }
  }

  /** The appData's permit when USDC would accept it now: this owner, the relayer, unexpired, at the current nonce. */
  private async currentPermit(appData: string, owner: Address): Promise<HookPermit | undefined> {
    const permit = hookPermit(appData)
    if (!permit || !isAddressEqual(permit.owner, owner) || !isAddressEqual(permit.spender, COW_VAULT_RELAYER) || permit.deadline < this.chain.timestamp) return undefined
    try {
      const signer = await recoverTypedDataAddress({ domain: USDC_PERMIT_DOMAIN, types: PERMIT_TYPES, primaryType: 'Permit', message: { owner: permit.owner, spender: permit.spender, value: permit.value, nonce: this.chain.usdcNonce, deadline: permit.deadline }, signature: permit.signature })
      return isAddressEqual(signer, owner) ? permit : undefined
    } catch { return undefined }
  }

  /** Anyone holding the public appData can run its permit out of band: the nonce moves on, the allowance is its value. */
  async runPermit(appData: string): Promise<boolean> {
    const permit = hookPermit(appData)
    if (!permit || !await this.currentPermit(appData, permit.owner)) return false
    this.chain.usdcNonce += 1n
    this.chain.allowance = permit.value
    return true
  }

  /**
   * A solver settles the order. Its permit hook runs if it still can (one whose nonce has moved on reverts and is
   * skipped, as the hooks trampoline does), then the fill takes the allowance and 0.50 USDC and the ETH arrives.
   * With chainSeesIt false only the order book's status changes.
   */
  settle(uid: string, executedBuyAmount?: bigint, opts: { chainSeesIt?: boolean } = {}): void {
    const order = this.orders.get(uid.toLowerCase())
    if (!order) throw new Error(`no order ${uid}`)
    const bought = executedBuyAmount ?? BigInt(order.body.buyAmount)
    order.status = 'fulfilled'; order.executedBuyAmount = bought.toString()
    if (opts.chainSeesIt === false) return
    const sell = BigInt(order.body.sellAmount)
    const permit = hookPermit(order.body.appData)
    if (permit && this.hookNonce.get(uid.toLowerCase()) === this.chain.usdcNonce && permit.deadline >= this.chain.timestamp) {
      this.chain.usdcNonce += 1n
      this.chain.allowance = permit.value
    }
    if (this.chain.allowance < sell || this.chain.usdc < sell) throw new Error('the settlement reverts: the allowance or the balance is too low')
    this.chain.allowance -= sell
    this.chain.filled.set(uid.toLowerCase(), sell)
    this.chain.usdc -= sell
    this.chain.eth += bought
  }

  only(): StoredOrder {
    if (this.orders.size !== 1) throw new Error(`expected one order, found ${this.orders.size}`)
    return [...this.orders.values()][0]
  }
}
