import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  keccak256,
  parseTransaction,
  parseAbiItem,
  sha256,
  type Address,
  type Chain,
  type Hex,
  type Transport,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import type { EvmNonceChainState, EvmNonceCounter, EvmNonceSelection } from './nonce-counter'
import type { EvmSendLock } from './send-lock'
import {
  EvmFeeCeilingError,
  evmOperationKey,
  type EvmNewBroadcastAuthorizer,
  resolveEvmReceiptWaitMs,
  resolveEvmHeadBumpAfterMs,
  resolveEvmRefreshBudgetMs,
  resolveEvmUnresolvedConsumedResendMs,
  sendCounterLeasedTransaction,
} from './inflight-sends'
import { localTransactionHash } from './inflight-submit'
import { baseRpcTransport } from './rpc'
import {
  ERC20_ABI,
  ERC20_SWAP,
  ERC20_SWAP_ABI,
  encodeApprove,
  encodeClaim,
  encodeLock,
  encodeRefund,
  type Erc20SwapParams,
  type LockupEvent,
} from './erc20swap'

/** A positive identity mismatch is distinct from an RPC outage: callers must keep reporting it as unhealthy even
 * when no current record happens to require EVM recovery. */
export class Erc20SwapContractIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Erc20SwapContractIdentityError'
  }
}

/** Runtime/boot counter failures are classified separately from contract-integrity failures for daemon health. */
export class EvmNonceCounterReadinessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvmNonceCounterReadinessError'
  }
}

export { EvmFeeCeilingError } from './inflight-sends'

export const DEFAULT_EVM_MAX_FEE_GWEI = '500'
const WEI_PER_GWEI = 1_000_000_000n

/** Parse the gas ceiling exactly (rather than through a lossy JS number) and fail closed on bad operator input. */
export function resolveEvmMaxFeePerGas(
  env: Record<string, string | undefined> = process.env,
): bigint {
  const raw = env.EVM_MAX_FEE_GWEI?.trim() || DEFAULT_EVM_MAX_FEE_GWEI
  const numeric = Number(raw)
  if (!Number.isFinite(numeric) || numeric <= 0 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    throw new Error(`EVM_MAX_FEE_GWEI must be a finite number greater than 0 (got '${raw}')`)
  }
  const [whole, fraction = ''] = raw.split('.')
  if (fraction.length > 9) {
    throw new Error(`EVM_MAX_FEE_GWEI supports at most 9 decimal places (got '${raw}')`)
  }
  const value = BigInt(whole) * WEI_PER_GWEI + BigInt((fraction + '000000000').slice(0, 9))
  if (value <= 0n) throw new Error(`EVM_MAX_FEE_GWEI must resolve to at least one wei (got '${raw}')`)
  return value
}

const LOCKUP_EVENT = parseAbiItem(
  'event Lockup(bytes32 indexed preimageHash, uint256 amount, address tokenAddress, address indexed claimAddress, address indexed refundAddress, uint256 timelock)',
)
const CLAIM_EVENT = parseAbiItem('event Claim(bytes32 indexed preimageHash, bytes32 preimage)')
const REFUND_EVENT = parseAbiItem('event Refund(bytes32 indexed preimageHash)')

const ERC20_TRANSFER_ABI = [parseAbiItem('function transfer(address to, uint256 amount) returns (bool)')]

/** Per-request `eth_getLogs` span (inclusive windows of at most this many blocks). mainnet.base.org rejects a wider
 *  range with -32614 "eth_getLogs is limited to a 2,000 range" (probed 2026-09-26; it allowed 10k when these scans were
 *  first chunked), and several providers cap at 2,000 too. */
export const CLAIM_SCAN_STEP = 2_000n
/** findLockup's newest window runs to `latest`; it starts this many blocks short of a full window, so blocks mined after
 *  the tip read (Base makes one every 2 s) cannot push it past the span cap. */
const LOCKUP_LATEST_HEADROOM = 100n
/** findLockup refuses a wider scan (about 9 days of Base blocks) rather than issue thousands of windowed reads. It covers
 *  the signer verifier's largest configurable lookback (302,400 blocks). */
export const LOCKUP_MAX_SCAN_BLOCKS = 400_000n
/**
 * Split the inclusive range [from, tip] into ≤`step`-wide inclusive windows (empty when from > tip). An old
 * lock's lock→tip span can be 30k+ blocks — far over the getLogs cap — so the Claim scan must chunk (review
 * 977c19b5 note; the 2026-08-20 old-lock recovery). Pure so the windowing is unit-tested without a live RPC.
 */
export function blockScanWindows(from: bigint, tip: bigint, step: bigint): Array<{ from: bigint; to: bigint }> {
  if (step <= 0n) throw new Error('blockScanWindows: step must be > 0')
  const windows: Array<{ from: bigint; to: bigint }> = []
  for (let f = from; f <= tip; f += step) windows.push({ from: f, to: f + step - 1n < tip ? f + step - 1n : tip })
  return windows
}

export interface EvmClientOpts {
  rpcUrl: string
  /** Ordered Base endpoints. Omit to retain the legacy single rpcUrl configuration. */
  rpcUrls?: readonly string[]
  /** 0x-prefixed 32-byte private key. OMIT for a KEYLESS read-only client (doc 25 E4): then `address` is REQUIRED and
   *  every write (approve/lock/claim/refund/transferErc20) throws — the brain holds no EVM key + routes signing to the
   *  isolated signer. Reads use the public client only, so they work identically keyed or keyless. */
  privateKey?: Hex
  /** The client's own EVM address — REQUIRED in keyless mode (no key to derive it from); ignored when `privateKey` is set. */
  address?: Address
  /** The deployed ERC20Swap contract address. */
  swapAddress: Address
  /** Defaults to Base Sepolia. */
  chain?: Chain
  /** Test seam: override the viem transport (e.g. a `custom` mock) instead of `http(rpcUrl)`. Prod passes none. */
  transport?: Transport
  
  sendLock?: EvmSendLock
  
  nonceCounter?: EvmNonceCounter
  /** Additional contracts the counter client may re-sign verbatim (normally the pinned USDC contract for approve). */
  pinnedTokenAddresses?: readonly Address[]
  /** Successful runtime/VERSION attestation cache lifetime. Defaults to five minutes; failures are never cached. */
  codeHashTtlMs?: number
  /** Test seam for the bounded identity-attestation cache clock. */
  now?: () => number
  /** Test-only identity seam for an injected fake transport. Production omits it and always uses canonical keccak256. */
  hashRuntimeCode?: (code: Hex) => Hex
  /** Optional service logger for advisory nonce-gap transitions. */
  log?: (message: string) => void
}
export interface SentTx {
  hash: Hex
  nonce?: number
  /** Pending counter outcomes use 0n; terminal outcomes carry the receipt block. */
  blockNumber: bigint
  status: 'success' | 'reverted' | 'pending'
  /** Internal signer accounting: replacements do not consume another per-nonce send allowance. */
  consumesSendAllowance?: boolean
}

/** Canonical finalized resolution of one ERC20Swap hashlock. Event transaction identity is retained so a competing
 * resolution can be persisted and surfaced to an operator. `unresolved` is deliberately broad: absence, malformed
 * provider data, contradictory Claim+Refund events, and every read failure all refuse terminal classification. */
export type SwapResolutionOutcome =
  | { kind: 'claimed'; preimage: Hex; eventTxid: Hex }
  | { kind: 'refunded'; eventTxid: Hex }
  | { kind: 'unresolved'; reason: 'not-found' | 'invalid-anchor' | 'malformed-log' | 'contradictory' | 'read-error'; detail?: string }

type LocalSignOpts = {
  writer: {
    prepareTransactionRequest(args: any): Promise<any>
    signTransaction(args: any): Promise<Hex>
  }
  publicClient: {
    getTransactionCount(args: { address: Address; blockTag: 'pending' }): Promise<number>
    estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>
    /** Some RPCs expose pending-pool transactions through pending block reads; unavailable/partial responses are safe fallbacks. */
    getBlock?(args: { blockTag: 'pending'; includeTransactions: true }): Promise<{ transactions?: unknown[] }>
    /** Known-hash lookup is the primary recovery RBF source; unlike pending blocks it is supported by standard RPCs. */
    getTransaction?(args: { hash: Hex }): Promise<unknown>
  }
  sender: Address
  /** The local account object, never merely its address. */
  localAccount: unknown
  to?: Address
  data: Hex
  /** Native value for a plain transfer; omitted for contract calls. */
  value?: bigint
  /** Explicit nonce chosen by the shared counter under the cross-process lease. Omit for original viem auto-read. */
  nonce?: number
  
  maxFeePerGasCeiling?: bigint
  
  recoveryFeeLadder?: boolean
  /** Hash of the prior recovery broadcast at this nonce, persisted by the watchtower for a reliable RBF floor. */
  priorBroadcastTxid?: Hex
}

/** The only write primitive used by Erc20SwapEvmClient: local sign then raw broadcast. */
export async function sendLocallySignedEvmTransaction(opts: LocalSignOpts & {
  writer: LocalSignOpts['writer'] & { sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex> }
  /** Observe the serialized transaction before it is broadcast. */
  onSignedTransaction?: (signedTx: Hex) => void | Promise<void>
}): Promise<Hex> {
  const serializedTransaction = await signLocallyEvmTransaction(opts)
  await opts.onSignedTransaction?.(serializedTransaction)
  const hash = await opts.writer.sendRawTransaction({ serializedTransaction })
  return hash
}

/** Prepare, price, and locally sign WITHOUT any network submit: the counter path records the bytes before submitting. */
export async function signLocallyEvmTransaction(opts: LocalSignOpts): Promise<Hex> {
  const expectedSenderNonce = opts.nonce ??
    await opts.publicClient.getTransactionCount({ address: opts.sender, blockTag: 'pending' })
  if (!Number.isSafeInteger(expectedSenderNonce) || expectedSenderNonce < 0) {
    throw new Error(`EVM send refused: pending sender nonce is invalid (${String(expectedSenderNonce)})`)
  }
  let feeFields: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined
  if (opts.recoveryFeeLadder) {
    const fresh = await opts.publicClient.estimateFeesPerGas()
    if (fresh.maxFeePerGas === undefined || fresh.maxPriorityFeePerGas === undefined ||
        fresh.maxFeePerGas < 0n || fresh.maxPriorityFeePerGas < 0n) {
      throw new Error('EVM send refused: estimateFeesPerGas did not return non-negative EIP-1559 maxFeePerGas and maxPriorityFeePerGas')
    }
    const sources = [
      await priorBroadcastEip1559Fees(opts.publicClient, opts.priorBroadcastTxid),
      await pendingEip1559Fees(opts.publicClient, opts.sender, expectedSenderNonce),
    ].filter((fees): fees is { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } => fees !== undefined)
    const bumpFloor = sources.reduce<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined>(
      (floor, fees) => floor
        ? { maxFeePerGas: max(floor.maxFeePerGas, fees.maxFeePerGas), maxPriorityFeePerGas: max(floor.maxPriorityFeePerGas, fees.maxPriorityFeePerGas) }
        : fees,
      undefined,
    )
    const maxFeePerGas = bumpFloor ? max(fresh.maxFeePerGas, increaseByOneEighth(bumpFloor.maxFeePerGas)) : fresh.maxFeePerGas
    const maxPriorityFeePerGas = bumpFloor ? max(fresh.maxPriorityFeePerGas, increaseByOneEighth(bumpFloor.maxPriorityFeePerGas)) : fresh.maxPriorityFeePerGas
    if (opts.maxFeePerGasCeiling !== undefined && maxFeePerGas > opts.maxFeePerGasCeiling) {
      throw new EvmFeeCeilingError(maxFeePerGas, opts.maxFeePerGasCeiling)
    }
    feeFields = { maxFeePerGas, maxPriorityFeePerGas }
  }
  const prepared = await opts.writer.prepareTransactionRequest({
    account: opts.localAccount,
    to: opts.to,
    data: opts.data,
    value: opts.value,
    nonce: expectedSenderNonce,
    ...feeFields,
  })
  return opts.writer.signTransaction(prepared)
}

async function priorBroadcastEip1559Fees(
  publicClient: { getTransaction?(args: { hash: Hex }): Promise<unknown> },
  priorBroadcastTxid?: Hex,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined> {
  if (!priorBroadcastTxid || !publicClient.getTransaction) return undefined
  try {
    const candidate = await publicClient.getTransaction({ hash: priorBroadcastTxid })
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const tx = candidate as Record<string, unknown>
    if (tx.blockNumber !== null || typeof tx.maxFeePerGas !== 'bigint' || typeof tx.maxPriorityFeePerGas !== 'bigint') return undefined
    return { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }
  } catch {
    // A known-hash lookup can still fail transiently; pending visibility and then the fresh estimate remain safe fallbacks.
    return undefined
  }
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

/** ceil(fee × 1.125), safely above the EIP-1559 replacement minimum. */
function increaseByOneEighth(fee: bigint): bigint {
  return (fee * 9n + 7n) / 8n
}

async function pendingEip1559Fees(
  publicClient: { getBlock?(args: { blockTag: 'pending'; includeTransactions: true }): Promise<{ transactions?: unknown[] }> },
  sender: Address,
  nonce: number,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined> {
  if (!publicClient.getBlock) return undefined
  try {
    const pending = await publicClient.getBlock({ blockTag: 'pending', includeTransactions: true })
    for (const candidate of pending.transactions ?? []) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const tx = candidate as Record<string, unknown>
      const txNonce = typeof tx.nonce === 'number' ? tx.nonce : typeof tx.nonce === 'bigint' ? Number(tx.nonce) : undefined
      if (typeof tx.from !== 'string' || tx.from.toLowerCase() !== sender.toLowerCase() || txNonce !== nonce ||
          typeof tx.maxFeePerGas !== 'bigint' || typeof tx.maxPriorityFeePerGas !== 'bigint') continue
      return { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }
    }
  } catch {
    // Pending-pool visibility is an optional RPC capability. The fresh estimate remains safe when this node cannot expose it.
  }
  return undefined
}

export class Erc20SwapEvmClient {
  private readonly wallet // undefined in KEYLESS read-only mode (doc 25 E4)
  private readonly pub
  private readonly addr: Address
  readonly swapAddress: Address
  readonly chainId: number
  /** True for a KEYLESS read-only client — every write throws; the brain holds no EVM key + routes signing to the signer. */
  readonly keyless: boolean
  private readonly sendLock?: EvmSendLock
  private readonly nonceCounter?: EvmNonceCounter
  private readonly codeHashTtlMs: number
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly hashRuntimeCode: (code: Hex) => Hex
  private readonly maxFeePerGasCeiling?: bigint
  private readonly pinnedContracts: readonly Address[]
  private readonly receiptWaitMs?: number
  private readonly headBumpAfterMs?: number
  private readonly refreshBudgetMs?: number
  private readonly unresolvedConsumedResendMs?: number
  private lastContractIdentityAttestedAtMs?: number
  private nonceGapHealthDetail?: string
  private nonceFirstBootDetail?: string
  private feeCeilingHealthDetail?: string
  /** No-counter clients may see stale pending-pool reads from a load-balanced RPC. A receipt-confirmed send floors it. */
  private nonceFloor?: number
  /** Serialize the no-counter sign→acknowledged-submit window inside this client instance. */
  private noCounterSendTail: Promise<void> = Promise.resolve()

  constructor(opts: EvmClientOpts) {
    const chain = opts.chain ?? baseSepolia
    const rpcUrls = opts.rpcUrls ?? [opts.rpcUrl]
    // Only already-signed raw broadcasts are submitted by this client; viem may therefore safely fail them over.
    // The single endpoint case remains the existing throttled/retrying HTTP transport.
    const transport = opts.transport ?? baseRpcTransport(rpcUrls)
    this.pub = createPublicClient({ chain, transport })
    this.swapAddress = opts.swapAddress
    this.chainId = chain.id
    this.sendLock = opts.sendLock
    this.nonceCounter = opts.nonceCounter
    this.codeHashTtlMs = opts.codeHashTtlMs ?? 300_000
    if (!Number.isFinite(this.codeHashTtlMs) || this.codeHashTtlMs <= 0) {
      throw new Error(`Erc20SwapEvmClient: codeHashTtlMs must be a positive finite number (got ${String(this.codeHashTtlMs)})`)
    }
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? console.error
    this.hashRuntimeCode = opts.hashRuntimeCode ?? keccak256
    if (this.nonceCounter && !this.sendLock) {
      throw new Error('Erc20SwapEvmClient: nonceCounter requires sendLock so counter reconciliation and persistence cannot escape the cross-process lease')
    }
    this.maxFeePerGasCeiling = this.nonceCounter ? resolveEvmMaxFeePerGas() : undefined
    this.pinnedContracts = [this.swapAddress, ...(opts.pinnedTokenAddresses ?? [])]
    this.receiptWaitMs = this.nonceCounter ? resolveEvmReceiptWaitMs() : undefined
    this.headBumpAfterMs = this.nonceCounter ? resolveEvmHeadBumpAfterMs() : undefined
    this.refreshBudgetMs = this.nonceCounter ? resolveEvmRefreshBudgetMs() : undefined
    this.unresolvedConsumedResendMs = this.nonceCounter ? resolveEvmUnresolvedConsumedResendMs() : undefined
    if (opts.privateKey) {
      const account = privateKeyToAccount(opts.privateKey)
      this.addr = account.address
      this.wallet = createWalletClient({ account, chain, transport })
      this.keyless = false
    } else {
      if (!opts.address) throw new Error('Erc20SwapEvmClient: keyless mode requires `address` (no privateKey to derive it from)')
      this.addr = opts.address
      this.wallet = undefined
      this.keyless = true
    }
  }

  address(): Address {
    return this.addr
  }

  /** The wallet client for a WRITE — throws in keyless mode (signing must route through the isolated signer, doc 25 E4). */
  private writer(): NonNullable<typeof this.wallet> {
    if (!this.wallet) {
      throw new Error('Erc20SwapEvmClient: KEYLESS read-only client — signing (approve/lock/claim/refund/transferErc20) must route through the isolated signer (doc 25 E4)')
    }
    return this.wallet
  }

  async assertChainId(): Promise<void> {
    const live = await this.pub.getChainId()
    if (live !== this.chainId) {
      throw new Error(
        `EVM RPC chain mismatch: the endpoint serves chainId ${live} but this client is pinned to ${this.chainId} — ` +
          `refusing (wrong or hijacked RPC?). Point rpcUrl at a chain-${this.chainId} node.`,
      )
    }
  }

  private async readNonceChainState(): Promise<EvmNonceChainState> {
    const chainPending = await this.pub.getTransactionCount({ address: this.addr, blockTag: 'pending' })
    const chainLatest = await this.pub.getTransactionCount({ address: this.addr, blockTag: 'latest' })
    return { chainId: this.chainId, address: this.addr, chainPending, chainLatest }
  }

  private observeNonceSelection(selection: EvmNonceSelection): void {
    if (selection.source === 'first-boot') {
      const detail = `counter initialized from chain pending nonce ${selection.nonce}; verify this is a genuine first boot, not lost live-account state`
      if (detail !== this.nonceFirstBootDetail) this.log(`[evm-nonce-counter] HEALTH WARN — ${detail}`)
      this.nonceFirstBootDetail = detail
    }
    const gap = selection.gapObservation
    if (!gap) {
      if (this.nonceGapHealthDetail) {
        this.log('[evm-nonce-counter] nonce-gap observation cleared; pending/latest state no longer shows counter-ahead with in-flight transactions')
      }
      this.nonceGapHealthDetail = undefined
      return
    }
    if (!gap.alert) return // retain an already-raised alert until the underlying gap condition clears
    const detail =
      `EVM nonce counter is ahead while transactions remain in flight for ${gap.observedForMs}ms ` +
      `(latest=${gap.chainLatest}, pending=${gap.chainPending}, nextNonce=${gap.nextNonce}); ` +
      'send remains fail-safe at max(counter,pending), but the account may be stuck/gapped and needs operator reconciliation'
    if (detail !== this.nonceGapHealthDetail) this.log(`[evm-nonce-counter] HEALTH WARN — ${detail}`)
    this.nonceGapHealthDetail = detail
  }

  /** Advisory account-gap state for watchtower health/M6 alerting. It never blocks a send. */
  nonceGapAlert(): string | undefined {
    return this.nonceGapHealthDetail
  }

  /** First-boot initialization is operator-visible: absence is safe only for a genuinely new durable counter. */
  nonceFirstBootAlert(): string | undefined {
    return this.nonceFirstBootDetail
  }

  /** Advisory only: a ceiling pause is retried each poll and clears after a send can again be priced safely. */
  feeCeilingAlert(): string | undefined {
    return this.feeCeilingHealthDetail
  }

  private observeFeeCeiling(error: EvmFeeCeilingError): void {
    const detail = `${error.message}; own-funds recovery remains armed and will retry`
    if (detail !== this.feeCeilingHealthDetail) this.log(`[evm-fee-ladder] HEALTH WARN — ${detail}`)
    this.feeCeilingHealthDetail = detail
  }

  private clearFeeCeilingAlert(): void {
    if (this.feeCeilingHealthDetail) this.log('[evm-fee-ladder] fee ceiling pause cleared; EVM recovery send pricing is within limit again')
    this.feeCeilingHealthDetail = undefined
  }

  /**
   * Boot/runtime probe for the durable counter. Both chain views and the complete counter check run under the same
   * cross-process flock used by sends, so unreadable/lost/foreign state becomes a loud readiness failure.
   */
  async assertNonceCounterReady(): Promise<void> {
    if (!this.nonceCounter) return
    if (!this.sendLock) throw new EvmNonceCounterReadinessError('EVM nonce counter readiness requires the shared send lock')
    try {
      await this.sendLock.runExclusive(async () => {
        const selection = this.nonceCounter!.assertReady(await this.readNonceChainState())
        this.observeNonceSelection(selection)
      })
    } catch (error) {
      throw new EvmNonceCounterReadinessError(
        `EVM nonce counter readiness failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Oldest unconsumed counter send age. Counter/file/RPC failures propagate so recovery health is not refreshed. */
  async oldestInflightAgeMs(): Promise<number> {
    if (!this.nonceCounter) return 0
    if (!this.sendLock) throw new EvmNonceCounterReadinessError('EVM nonce counter age read requires the shared send lock')
    return this.sendLock.runExclusive(async () => {
      const selection = this.nonceCounter!.selectNonce(await this.readNonceChainState())
      this.observeNonceSelection(selection)
      const oldest = (selection.inflight ?? []).reduce<number | undefined>(
        (value, entry) => value === undefined || entry.firstBroadcastAtMs < value ? entry.firstBroadcastAtMs : value,
        undefined,
      )
      return oldest === undefined ? 0 : Math.max(0, this.now() - oldest)
    })
  }

  /**
   * Attest the deployed contract, not merely its configured address. VERSION() is only a secondary diagnostic: the
   * primary identity is the exact canonical deployed-runtime hash pinned from our boltz-core@5.0.0 artifact.
   */
  async assertContractIdentity(): Promise<void> {
    const now = this.now()
    if (this.lastContractIdentityAttestedAtMs !== undefined && now - this.lastContractIdentityAttestedAtMs < this.codeHashTtlMs) return
    // A failed or mismatched re-attestation must never leave a previous success usable.
    this.lastContractIdentityAttestedAtMs = undefined
    const deployment = Object.values(ERC20_SWAP.deployments).find((candidate) =>
      candidate.chainId === this.chainId && candidate.address.toLowerCase() === this.swapAddress.toLowerCase())
    if (!deployment) {
      throw new Erc20SwapContractIdentityError(
        `ERC20Swap ${this.swapAddress} on chain ${this.chainId} has no pinned canonical deployed-runtime hash — refusing to arm/sign/terminalise recovery`,
      )
    }
    try {
      const code = await this.pub.getCode({ address: this.swapAddress })
      if (!code || code === '0x') throw new Erc20SwapContractIdentityError(`ERC20Swap contract mismatch: no runtime code at ${this.swapAddress} — refusing to arm recovery`)
      const codeHash = this.hashRuntimeCode(code)
      if (codeHash.toLowerCase() !== deployment.runtimeCodeHash.toLowerCase()) {
        throw new Erc20SwapContractIdentityError(
          `ERC20Swap runtime code mismatch at ${this.swapAddress}: keccak256(code)=${codeHash}, ` +
            `expected canonical ${deployment.runtimeCodeHash} — refusing to arm/sign/terminalise recovery`,
        )
      }
      const live = await this.pub.readContract({
        address: this.swapAddress, abi: ERC20_SWAP_ABI, functionName: 'VERSION',
      })
      if (live !== ERC20_SWAP.version) {
        throw new Erc20SwapContractIdentityError(
          `ERC20Swap contract mismatch: VERSION() returned ${String(live)} at ${this.swapAddress}, ` +
            `expected canonical version ${ERC20_SWAP.version} — refusing to arm recovery`,
        )
      }
      this.lastContractIdentityAttestedAtMs = now
    } catch (error) {
      this.lastContractIdentityAttestedAtMs = undefined
      throw error
    }
  }

  // ── reads ──
  async usdcBalance(token: Address): Promise<bigint> {
    return this.pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.addr] })
  }

  /**
   * Live ERC20 `decimals()` — the runtime cross-check for the allowlist (review bc909852). viem DECODES
   * the return, so a reverted/empty response THROWS (fail-closed) rather than silently reading 0; a real
   * contract returns its uint8. Paired with assertDecimalsMatch to catch a wrong/typo'd allowlist entry
   * before funds commit.
   */
  async tokenDecimals(token: Address): Promise<number> {
    return this.pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' })
  }
  async allowance(token: Address): Promise<bigint> {
    return this.pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [this.addr, this.swapAddress] })
  }

  // ── writes (calldata from the pure layer; wait for the receipt) ──
  private async send(
    to: Address,
    data: Hex,
    value: bigint | undefined = undefined,
    priorBroadcastTxid?: Hex,
    authorizeNewBroadcast?: EvmNewBroadcastAuthorizer,
    retainConsumedAttribution = false,
    operationSalt?: Hex,
    onRecorded?: (signed: { hash: Hex; signedTx: Hex; nonce: number }) => void | Promise<void>,
  ): Promise<SentTx> {
    // Keep this explicit: a local account signs, then only eth_sendRawTransaction
    // leaves the process. Never let an RPC node choose/sign an eth_sendTransaction.
    const writer = this.writer()
    if (this.nonceCounter) {
      if (value !== undefined && value !== 0n) throw new Error('transferNative is not supported by a counter-leased client')
      if (!this.sendLock || this.maxFeePerGasCeiling === undefined || this.receiptWaitMs === undefined ||
          this.headBumpAfterMs === undefined || this.refreshBudgetMs === undefined ||
          this.unresolvedConsumedResendMs === undefined) {
        throw new Error('EVM counter client is missing its send coordination configuration (fail-closed)')
      }
      if (!this.pinnedContracts.some((address) => address.toLowerCase() === to.toLowerCase())) {
        throw new Error(`EVM counter client refused an unpinned destination ${to} (fail-closed)`)
      }
      return sendCounterLeasedTransaction({
        sendLock: this.sendLock,
        nonceCounter: this.nonceCounter,
        chainId: this.chainId,
        sender: this.addr,
        to,
        data,
        pinnedContracts: this.pinnedContracts,
        localAccount: writer.account,
        writer,
        publicClient: this.pub,
        readChainState: () => this.readNonceChainState(),
        signNew: async (nonce) => {
          try {
            const signedTx = await signLocallyEvmTransaction({
              writer, publicClient: this.pub, sender: this.addr, localAccount: writer.account, to, data, value, nonce,
              recoveryFeeLadder: true, maxFeePerGasCeiling: this.maxFeePerGasCeiling,
              ...(priorBroadcastTxid ? { priorBroadcastTxid } : {}),
            })
            return { hash: localTransactionHash(signedTx), signedTx }
          } catch (error) {
            if (error instanceof EvmFeeCeilingError) this.observeFeeCeiling(error)
            throw error
          }
        },
        observeSelection: (selection) => this.observeNonceSelection(selection),
        maxFeePerGasCeiling: this.maxFeePerGasCeiling,
        receiptWaitMs: this.receiptWaitMs,
        headBumpAfterMs: this.headBumpAfterMs,
        refreshBudgetMs: this.refreshBudgetMs,
        unresolvedConsumedResendMs: this.unresolvedConsumedResendMs,
        retainConsumedAttribution,
        ...(operationSalt !== undefined ? { operationSalt } : {}),
        ...(authorizeNewBroadcast ? { authorizeNewBroadcast } : {}),
        ...(onRecorded ? { onRecorded } : {}),
        now: this.now,
        log: this.log,
        onFeeCeiling: (error) => this.observeFeeCeiling(error),
        clearFeeCeiling: () => this.clearFeeCeilingAlert(),
      })
    }
    if (authorizeNewBroadcast) {
      throw new Error('EVM new-broadcast authorization requires the durable counter send engine (fail-closed)')
    }
    // Without a counter: local sign then raw broadcast, optionally serialized by the lock. Contract identity reads
    // happen before send(), and the receipt wait stays outside the lock.
    const broadcast = async (): Promise<{ hash: Hex; nonce: number }> => {
      const pending = await this.pub.getTransactionCount({ address: this.addr, blockTag: 'pending' })
      const nonce = Math.max(pending, this.nonceFloor ?? 0)
      const hash = await sendLocallySignedEvmTransaction({
        writer, publicClient: this.pub, sender: this.addr, localAccount: writer.account, to, data, value, nonce,
        ...(onRecorded ? {
          onSignedTransaction: async (signedTx: Hex) => {
            const signedNonce = Number(parseTransaction(signedTx).nonce)
            if (!Number.isSafeInteger(signedNonce) || signedNonce < 0) throw new Error('EVM send refused: locally signed nonce is invalid')
            await onRecorded({ hash: localTransactionHash(signedTx), signedTx, nonce: signedNonce })
          },
        } : {}),
      })
      return { hash, nonce }
    }
    // The floor is per client, so concurrent callers must not both read it before either raw submit is acknowledged.
    // Keep the receipt wait below outside this short critical section exactly as before.
    const prior = this.noCounterSendTail
    let release!: () => void
    this.noCounterSendTail = new Promise<void>((resolve) => { release = resolve })
    await prior
    let sent: { hash: Hex; nonce: number }
    try {
      sent = this.sendLock ? await this.sendLock.runExclusive(() => broadcast()) : await broadcast()
    } finally {
      release()
    }
    const rcpt = await this.pub.waitForTransactionReceipt({ hash: sent.hash })
    // A raw-submit acknowledgement is ambiguous: the transaction can still disappear. Only a receipt proves this
    // nonce was consumed, so an uncertain send leaves the next operation to its pending-nonce read.
    this.nonceFloor = Math.max(this.nonceFloor ?? 0, sent.nonce + 1)
    return { hash: sent.hash, blockNumber: rcpt.blockNumber, status: rcpt.status }
  }

  /** Machine: approve the swap contract to pull `amount` USDC (before lock). */
  async approve(token: Address, amount: bigint, authorizeNewBroadcast?: EvmNewBroadcastAuthorizer): Promise<SentTx> {
    this.writer() // preserve the keyless write boundary before doing any network work
    await this.assertContractIdentity()
    return this.send(token, encodeApprove(this.swapAddress, amount), undefined, undefined, authorizeNewBroadcast, false)
  }

  /** Machine (initiator): lock USDC under the hashlock + T_base. */
  async lock(
    p: Erc20SwapParams,
    authorizeNewBroadcast?: EvmNewBroadcastAuthorizer,
    onRecorded?: (signed: { hash: Hex; signedTx: Hex; nonce: number }) => void | Promise<void>,
  ): Promise<SentTx> {
    if (onRecorded && this.nonceCounter) {
      throw new Error('Erc20SwapEvmClient: lock attempt recording requires a client without a nonce counter')
    }
    this.writer() // preserve the keyless write boundary before doing any network work
    await this.assertContractIdentity()
    return this.send(this.swapAddress, encodeLock(p), undefined, undefined, authorizeNewBroadcast, true, undefined, onRecorded)
  }

  /** Buyer-only nonce burn: a zero-value self-transfer that replaces any recorded lock attempt at this exact nonce.
   *  It deliberately neither reads nor raises the no-counter nonce floor. */
  async consumeNonce(
    nonce: number,
    priorTxid?: Hex,
    onRecorded?: (signed: { hash: Hex; signedTx: Hex; nonce: number }) => void | Promise<void>,
  ): Promise<Hex> {
    if (this.nonceCounter) throw new Error('Erc20SwapEvmClient: consumeNonce requires a client without a nonce counter')
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error(`Erc20SwapEvmClient: consumeNonce nonce is invalid (${String(nonce)})`)
    const writer = this.writer()
    const broadcast = async (): Promise<Hex> => sendLocallySignedEvmTransaction({
      writer, publicClient: this.pub, sender: this.addr, localAccount: writer.account, to: this.addr, data: '0x', value: 0n,
      nonce, recoveryFeeLadder: true, ...(priorTxid ? { priorBroadcastTxid: priorTxid } : {}),
      ...(onRecorded ? {
        onSignedTransaction: async (signedTx: Hex) => {
          const signedNonce = Number(parseTransaction(signedTx).nonce)
          if (signedNonce !== nonce) throw new Error('EVM nonce burn refused: locally signed nonce changed')
          await onRecorded({ hash: localTransactionHash(signedTx), signedTx, nonce: signedNonce })
        },
      } : {}),
    })
    const prior = this.noCounterSendTail
    let release!: () => void
    this.noCounterSendTail = new Promise<void>((resolve) => { release = resolve })
    await prior
    try {
      return this.sendLock ? await this.sendLock.runExclusive(() => broadcast()) : await broadcast()
    } finally {
      release()
    }
  }

  async claim(p: Erc20SwapParams, secret: number[], priorBroadcastTxid?: Hex, authorizeNewBroadcast?: EvmNewBroadcastAuthorizer): Promise<SentTx> {
    this.writer() // preserve the keyless write boundary before doing any network work
    await this.assertContractIdentity()
    return this.send(this.swapAddress, encodeClaim(p, secret), undefined, priorBroadcastTxid, authorizeNewBroadcast, true)
  }

  /** Machine: refund USDC after T_base if the swap didn't complete. */
  async refund(p: Erc20SwapParams, priorBroadcastTxid?: Hex, authorizeNewBroadcast?: EvmNewBroadcastAuthorizer): Promise<SentTx> {
    this.writer() // preserve the keyless write boundary before doing any network work
    await this.assertContractIdentity()
    return this.send(this.swapAddress, encodeRefund(p), undefined, priorBroadcastTxid, authorizeNewBroadcast, true)
  }

  async transferErc20(
    token: Address,
    to: Address,
    amount: bigint,
    opts: { operationSalt?: Hex; retainConsumedAttribution?: boolean } = {},
  ): Promise<SentTx> {
    return this.send(
      token,
      encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [to, amount] }),
      undefined,
      undefined,
      undefined,
      opts.retainConsumedAttribution ?? false,
      opts.operationSalt,
    )
  }

  /** Native ETH transfer using the same local-sign and raw-broadcast path as the swap writes. */
  async transferNative(to: Address, value: bigint): Promise<SentTx> {
    if (value <= 0n) throw new Error('transferNative value must be positive')
    return this.send(to, '0x', value)
  }
  /** Conservative EIP-1559 cost for a simple native transfer, used only to
   * leave gas behind for a buyer's explicit ETH "all" withdrawal. */
  async estimateNativeTransferFee(to: Address): Promise<bigint> {
    if (this.nonceCounter) throw new Error('transferNative is not supported by a counter-leased client')
    const [gas, fees] = await Promise.all([
      this.pub.estimateGas({ account: this.addr, to, data: '0x', value: 1n }),
      this.pub.estimateFeesPerGas(),
    ])
    if (gas <= 0n || fees.maxFeePerGas === undefined || fees.maxFeePerGas <= 0n) {
      throw new Error('could not estimate Base native-transfer gas')
    }
    return gas * fees.maxFeePerGas
  }

  async sendPinnedContract(
    to: Address,
    data: Hex,
    opts: {
      operationSalt?: Hex
      retainConsumedAttribution?: boolean
      onRecorded?: (signed: { hash: Hex; signedTx: Hex; nonce: number }) => void | Promise<void>
    } = {},
  ): Promise<SentTx> {
    return this.send(to, data, undefined, undefined, undefined, opts.retainConsumedAttribution ?? false, opts.operationSalt, opts.onRecorded)
  }

  /** True only while the durable counter still owns this exact salted operation, in-flight or consumed. */
  async hasCounterOperation(to: Address, data: Hex, operationSalt?: Hex): Promise<boolean> {
    if (!this.nonceCounter || !this.sendLock) {
      throw new Error('EVM operation attribution requires the durable counter send engine (fail-closed)')
    }
    const opKey = evmOperationKey(to, data, operationSalt)
    return this.sendLock.runExclusive(async () => {
      const selection = this.nonceCounter!.selectNonce(await this.readNonceChainState())
      this.observeNonceSelection(selection)
      return [...(selection.inflight ?? []), ...(selection.consumed ?? [])]
        .some((entry) => entry.opKey.toLowerCase() === opKey.toLowerCase())
    })
  }

  // ── watcher reads ──
  /**
   * Is the Base swap for these params CURRENTLY locked (unclaimed + unrefunded)? Reads the contract's live
   * `swaps[hashValues(...)]` — which Boltz DELETES on claim/refund — so a `false` means the lock is spent or never
   * existed. The permanent `Lockup` EVENT cannot tell this apart; this is the guard against locking BSV for a
   * replayed/already-consumed Base lock (review 23adfcda HIGH). Fail-closed: any read error propagates (caller must
   * treat a failed check as "do not lock"). `blockNumber` pins both reads to that exact block (a node lacking it
   * errors, never answers from another head); omitted, the reads use latest exactly as before.
   */
  async isSwapLocked(p: Erc20SwapParams, opts: { blockNumber?: bigint } = {}): Promise<boolean> {
    if (opts.blockNumber !== undefined && opts.blockNumber <= 0n) {
      throw new Error(`isSwapLocked: a pinned blockNumber must be positive (got ${String(opts.blockNumber)}; fail-closed)`)
    }
    const at = opts.blockNumber !== undefined ? { blockNumber: opts.blockNumber } : {}
    await this.assertContractIdentity()
    const h = await this.pub.readContract({
      address: this.swapAddress, abi: ERC20_SWAP_ABI, functionName: 'hashValues',
      args: [p.preimageHash, p.amount, p.tokenAddress, p.claimAddress, p.refundAddress, p.timelock], ...at,
    })
    return this.pub.readContract({ address: this.swapAddress, abi: ERC20_SWAP_ABI, functionName: 'swaps', args: [h], ...at })
  }

  /** The exact same tuple read pinned to the OP-stack `finalized` head. Recovery terminalization uses this rather than
   * latest-state absence, which could disappear across a shallow L2 reorg. Both reads are evaluated at one block tag. */
  async isSwapLockedFinalized(p: Erc20SwapParams): Promise<boolean> {
    await this.assertContractIdentity()
    const h = await this.pub.readContract({
      address: this.swapAddress, abi: ERC20_SWAP_ABI, functionName: 'hashValues',
      args: [p.preimageHash, p.amount, p.tokenAddress, p.claimAddress, p.refundAddress, p.timelock],
      blockTag: 'finalized',
    })
    return this.pub.readContract({
      address: this.swapAddress, abi: ERC20_SWAP_ABI, functionName: 'swaps', args: [h], blockTag: 'finalized',
    })
  }

  /** Resolve the mined block of a tx from its receipt — a BOUNDED anchor for findLockup (never scan getLogs from 0).
   *  Returns null if the tx is not yet mined / not found (caller falls back to a recent window). */
  async blockOfTx(txHash: Hex): Promise<number | null> {
    const r = await this.pub.getTransactionReceipt({ hash: txHash }).catch(() => null)
    return r != null && r.blockNumber != null ? Number(r.blockNumber) : null
  }

  /**
   * Find the machine's USDC Lockup for a given hashlock (the responder's trigger).
   * Returns the FULL committed tuple + emitter (`contractAddress`) + `chainId` so the
   * responder can validate the whole economics against the negotiated params before
   * locking BSV (SettlementSession.validateObservedBaseLock) — not just match `H`.
   */
  async findLockup(
    preimageHash: Hex,
    fromBlock: bigint = 0n,
  ): Promise<(LockupEvent & { txHash: Hex; logIndex: number; contractAddress: Address; chainId: number; blockNumber?: number }) | null> {
    // Chunked like the Claim/Refund scans, so an older lock (the signer verifier accepts one up to its lookback) stays
    // under the RPC's eth_getLogs span cap. The newest window still runs to `latest`, so a span that fits in one window
    // is the same single call as before.
    const tip = await this.pub.getBlockNumber()
    if (tip - fromBlock > LOCKUP_MAX_SCAN_BLOCKS) {
      throw new Error(`findLockup: a ${tip - fromBlock}-block scan exceeds the ${LOCKUP_MAX_SCAN_BLOCKS}-block bound; pass a recent fromBlock anchor`)
    }
    const openFrom = tip - CLAIM_SCAN_STEP + LOCKUP_LATEST_HEADROOM + 1n
    const windows: Array<{ from: bigint; to?: bigint }> = fromBlock < openFrom ? blockScanWindows(fromBlock, openFrom - 1n, CLAIM_SCAN_STEP) : []
    windows.push({ from: fromBlock < openFrom ? openFrom : fromBlock })
    for (const w of windows) {
      const logs = await this.pub.getLogs({
        address: this.swapAddress, event: LOCKUP_EVENT, args: { preimageHash }, fromBlock: w.from, ...(w.to === undefined ? {} : { toBlock: w.to }),
      })
      for (const log of logs) {
        const a = log.args
        if (a.preimageHash && a.amount !== undefined && a.tokenAddress && a.claimAddress && a.refundAddress && a.timelock !== undefined) {
          return {
            preimageHash: a.preimageHash, amount: a.amount, tokenAddress: a.tokenAddress,
            claimAddress: a.claimAddress, refundAddress: a.refundAddress, timelock: a.timelock,
            txHash: log.transactionHash ?? '0x', logIndex: log.logIndex ?? -1,
            contractAddress: log.address ?? this.swapAddress, chainId: this.chainId,
            blockNumber: log.blockNumber == null ? undefined : Number(log.blockNumber), // REAL mined block — the finality anchor (never the taker-supplied value)
          }
        }
      }
    }
    return null
  }

  /** Latest finalized block number (OP-stack `finalized` tag) — the finality gate. */
  async finalizedBlockNumber(): Promise<bigint> {
    return (await this.pub.getBlock({ blockTag: 'finalized' })).number ?? 0n
  }

  /** Account nonce at one exact, already-resolved block; never silently substitute a moving tag. */
  async nonceAtBlock(blockNumber: bigint): Promise<number> {
    if (blockNumber <= 0n) throw new Error(`nonceAtBlock: blockNumber must be positive (got ${String(blockNumber)}; fail-closed)`)
    return this.pub.getTransactionCount({ address: this.addr, blockNumber })
  }

  /** Pending account nonce, used only to avoid burning while another transaction is in flight. */
  async pendingNonce(): Promise<number> {
    return this.pub.getTransactionCount({ address: this.addr, blockTag: 'pending' })
  }

  /** Timestamp of one exact finalized block, in Unix seconds. */
  async blockTimestamp(blockNumber: bigint): Promise<number> {
    if (blockNumber <= 0n) throw new Error(`blockTimestamp: blockNumber must be positive (got ${String(blockNumber)}; fail-closed)`)
    const timestamp = (await this.pub.getBlock({ blockNumber })).timestamp
    const seconds = Number(timestamp)
    if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('blockTimestamp: RPC returned an invalid timestamp')
    return seconds
  }

  /**
   * Latest `safe` block number (OP-stack `safe` tag = L1-justified head, ~1 epoch).
   * One epoch weaker than `finalized` but still reorg-hard — the finality-gate fallback
   * when `finalized` freezes (see src/bridge/evm/finality.ts).
   */
  async safeBlockNumber(): Promise<bigint> {
    return (await this.pub.getBlock({ blockTag: 'safe' })).number ?? 0n
  }

  /** Latest block number (for an N-confirmations gate on a faster testnet drill). */
  async currentBlockNumber(): Promise<bigint> {
    return this.pub.getBlockNumber()
  }

  /**
   * Confirmations of a mined tx = tip − receiptBlock + 1; 0 if not yet mined, not
   * found, or REVERTED (a reverted refund never "confirms" — the watchtower keeps
   * treating it as unrecovered and, on the next poll, re-checks reveal / retries).
   * The watchtower's Base-refund confirmation gate reads this (recovery = CONFIRMATION).
   */
  async txConfirmations(hash: Hex): Promise<number> {
    try {
      const rcpt = await this.pub.getTransactionReceipt({ hash })
      if (rcpt.status !== 'success') return 0
      const tip = await this.pub.getBlockNumber()
      const confs = Number(tip - rcpt.blockNumber) + 1
      return confs > 0 ? confs : 0
    } catch {
      return 0 // not mined yet / not found
    }
  }

  /** True only when the receipt's block is at/below the OP-stack finalized head. By default a reverted receipt is not
   * final success; `requireSuccess=false` exists solely for the separately-bound already-resolved convergence path. */
  async txFinalized(hash: Hex, requireSuccess = true): Promise<boolean> {
    await this.assertContractIdentity()
    try {
      const rcpt = await this.pub.getTransactionReceipt({ hash })
      if (requireSuccess && rcpt.status !== 'success') return false
      const finalized = await this.finalizedBlockNumber()
      return rcpt.blockNumber <= finalized
    } catch {
      return false
    }
  }

  /**
   * Bind a mined transaction hash to an exact contract call. Confirmation alone is not evidence that a refund hash
   * belongs to this swap; recovery uses this together with `isSwapLocked(exactTuple) === false` before terminalising.
   * RPC/read errors propagate so callers fail closed.
   */
  async transactionCalls(hash: Hex, to: Address, data: Hex): Promise<boolean> {
    await this.assertContractIdentity()
    const tx = await this.pub.getTransaction({ hash })
    return tx.to?.toLowerCase() === to.toLowerCase() && tx.input.toLowerCase() === data.toLowerCase()
  }

  /**
   * Resolve HOW this exact hashlock left escrow, using only canonical events at/below the OP-stack `finalized` head.
   * The recorded lock block is mandatory: it is the bounded anchor that makes legitimately old swaps scannable under
   * public RPCs' `eth_getLogs` span cap. Every inclusive window is ≤`CLAIM_SCAN_STEP` blocks. Because Claim/Refund events
   * index only the public hashlock, every candidate event transaction is additionally bound to `claim`/`refund`
   * calldata for this exact six-field tuple before it is accepted; same-hash decoys are ignored. This method never
   * falls back to `latest`, genesis, or tuple absence. Any read/malformed-data doubt returns `unresolved` rather than
   * throwing or guessing; observing both tuple-bound event kinds is an on-chain/provider contradiction and likewise
   * fails closed.
   *
   * FENCED RESIDUAL: `transactionCalls` deliberately recognizes only a bare top-level call to this swap contract.
   * A genuine resolution submitted through a batcher/multicall therefore remains unresolved (`not-found`) and is
   * retried fail-closed. That is acceptable for the current de-minimis single-call recovery flow.
   */
  async resolveSwapOutcome(p: Erc20SwapParams, fromBlock: bigint): Promise<SwapResolutionOutcome> {
    try {
      if (fromBlock <= 0n) return { kind: 'unresolved', reason: 'invalid-anchor', detail: 'recorded lock block must be positive' }
      await this.assertContractIdentity()
      const tip = await this.finalizedBlockNumber()
      let claimed: Extract<SwapResolutionOutcome, { kind: 'claimed' }> | undefined
      let refunded: Extract<SwapResolutionOutcome, { kind: 'refunded' }> | undefined
      let malformed = false

      for (const w of blockScanWindows(fromBlock, tip, CLAIM_SCAN_STEP)) {
        const claimLogs = await this.pub.getLogs({
          address: this.swapAddress, event: CLAIM_EVENT, args: { preimageHash: p.preimageHash },
          fromBlock: w.from, toBlock: w.to,
        })
        const refundLogs = await this.pub.getLogs({
          address: this.swapAddress, event: REFUND_EVENT, args: { preimageHash: p.preimageHash },
          fromBlock: w.from, toBlock: w.to,
        })
        for (const log of claimLogs) {
          const preimage = log.args.preimage
          const eventTxid = log.transactionHash
          if (!preimage || !/^0x[0-9a-fA-F]{64}$/.test(preimage) || !eventTxid ||
              !/^0x[0-9a-fA-F]{64}$/.test(eventTxid) || sha256(preimage).toLowerCase() !== p.preimageHash.toLowerCase()) {
            malformed = true
            continue
          }
          const tupleBound = await this.transactionCalls(
            eventTxid,
            this.swapAddress,
            encodeClaim(p, Array.from(Buffer.from(preimage.slice(2), 'hex'))),
          )
          if (!tupleBound) continue
          if (claimed && (claimed.preimage.toLowerCase() !== preimage.toLowerCase() || claimed.eventTxid.toLowerCase() !== eventTxid.toLowerCase())) {
            malformed = true
            continue
          }
          claimed = { kind: 'claimed', preimage, eventTxid }
        }
        for (const log of refundLogs) {
          const eventTxid = log.transactionHash
          if (!eventTxid || !/^0x[0-9a-fA-F]{64}$/.test(eventTxid)) {
            malformed = true
            continue
          }
          const tupleBound = await this.transactionCalls(eventTxid, this.swapAddress, encodeRefund(p))
          if (!tupleBound) continue
          if (refunded && refunded.eventTxid.toLowerCase() !== eventTxid.toLowerCase()) {
            malformed = true
            continue
          }
          refunded = { kind: 'refunded', eventTxid }
        }
      }
      if (malformed) return { kind: 'unresolved', reason: 'malformed-log', detail: 'finalized resolution log was malformed or non-unique' }
      if (claimed && refunded) return { kind: 'unresolved', reason: 'contradictory', detail: 'both finalized Claim and Refund events exist for the preimage hash' }
      return claimed ?? refunded ?? { kind: 'unresolved', reason: 'not-found' }
    } catch (error) {
      return { kind: 'unresolved', reason: 'read-error', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Extract the revealed secret from a Claim event (belt-and-suspenders vs the BSV reveal; the
   * watchtower's fail-closed reveal check before a refund). CHUNKED: public RPCs cap `eth_getLogs`
   * (mainnet.base.org at 2,000 blocks), so an old lock's lock→tip span (can be 30k+ blocks)
   * is scanned in ≤`CLAIM_SCAN_STEP` windows — otherwise the scan errors and the reveal check
   * fail-closes forever, stranding recoverable refunds (caught 2026-08-20 recovering old de-minimis locks).
   */
  async findClaimSecret(preimageHash: Hex, fromBlock: bigint = 0n): Promise<number[] | null> {
    const tip = await this.pub.getBlockNumber()
    for (const w of blockScanWindows(fromBlock, tip, CLAIM_SCAN_STEP)) {
      const logs = await this.pub.getLogs({ address: this.swapAddress, event: CLAIM_EVENT, args: { preimageHash }, fromBlock: w.from, toBlock: w.to })
      for (const log of logs) {
        const p = log.args.preimage
        if (p) return Array.from(Buffer.from(p.slice(2), 'hex'))
      }
    }
    return null
  }

  async chainTipTimestamp(): Promise<number> {
    const block = await this.pub.getBlock()
    return Number(block.timestamp)
  }
}
