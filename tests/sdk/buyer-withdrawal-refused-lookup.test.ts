import { expect } from 'chai'
import { describe, it } from 'mocha'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { initialiseBuyerHome } from '../../src/sdk/buyer/local-state'
import { makeBuyerWithdrawalIntents } from '../../src/sdk/buyer/withdrawal-intent'
import { makeBuyerEvmRails } from '../../src/sdk/buyer/runtime/evm-rails'
import { isLookupRefusal, LookupRefusedError } from '../../src/bridge/evm/lookup-refusal'

const KEY = `0x${'11'.repeat(32)}` as Hex
const ACCOUNT = privateKeyToAccount(KEY)
const NONCE = 7
const BALANCE = 194790595100339n
const COST = 194891395100339n
const SWAP = '0x1111111111111111111111111111111111111111' as const
const USDC = '0x2222222222222222222222222222222222222222' as const
const PROBE_HASH = `0x${'ab'.repeat(32)}` as Hex

const reply = (id: unknown, result: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: '2.0', result, id }), { status, headers: { 'content-type': 'application/json' } })
const refusal = (id: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32602, message: 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode' }, id }), { status: 403, headers: { 'content-type': 'application/json' } })
/** Test-only 0.2.4 seam: viem gets the real 403 while the current guard cannot classify its clone. */
const unclassifiedRefusal = (id: unknown) => {
  const response = refusal(id)
  Object.defineProperty(response, 'clone', { value: () => new Response('not a lookup refusal') })
  return response
}
const insufficient = (id: unknown, cost: bigint) => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32003, message: `insufficient funds for gas * price + value: have ${BALANCE} want ${cost}` }, id }), { headers: { 'content-type': 'application/json' } })
const block = (number: bigint) => ({ number: `0x${number.toString(16)}`, hash: `0x${'cd'.repeat(32)}`, timestamp: '0x1', baseFeePerGas: '0x1', gasLimit: '0x1c9c380' })
const receipt = (hash: Hex, number: bigint) => ({ transactionHash: hash, blockHash: `0x${'ef'.repeat(32)}`, blockNumber: `0x${number.toString(16)}`, from: ACCOUNT.address, to: ACCOUNT.address, status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`, transactionIndex: '0x0', type: '0x2', contractAddress: null })

/** Synthetic Base JSON-RPC node: probes are real, unknown lookups get publicnode's measured 403. */
class FakeBaseNode {
  readonly methods: string[] = []
  readonly held = new Map<Hex, Hex>()
  readonly mined = new Map<Hex, bigint>()
  finalized = 100n
  finalizedNonce = NONCE
  failReceipts = false
  oldGuard = false
  cancelWasDurable = false
  withdrawalFile = ''

  fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: unknown[] }
    this.methods.push(request.method)
    const { id, method, params } = request
    if (method === 'eth_chainId') return reply(id, '0x2105')
    if (method === 'eth_blockNumber') return reply(id, `0x${(this.finalized + 2n).toString(16)}`)
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0]
      if (params[1] === true && tag !== 'pending') return reply(id, { ...block(typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : this.finalized), transactions: [PROBE_HASH] })
      if (tag === 'pending') return reply(id, { ...block(this.finalized + 2n), transactions: [] })
      return reply(id, block(tag === 'finalized' || tag === 'safe' ? this.finalized : this.finalized + 2n))
    }
    if (method === 'eth_getLogs') return reply(id, [])
    if (method === 'eth_getTransactionCount') return reply(id, `0x${this.finalizedNonce.toString(16)}`)
    if (method === 'eth_maxPriorityFeePerGas' || method === 'eth_gasPrice') return reply(id, '0x1')
    if (method === 'eth_estimateGas') return reply(id, '0x5208')
    if (method === 'eth_getTransactionReceipt') {
      const hash = params[0] as Hex
      if (hash === PROBE_HASH) return reply(id, receipt(PROBE_HASH, this.finalized - 200n))
      if (this.failReceipts) return new Response('synthetic receipt failure', { status: 500 })
      const mined = this.mined.get(hash)
      if (mined !== undefined) return reply(id, receipt(hash, mined))
      return this.oldGuard ? unclassifiedRefusal(id) : refusal(id)
    }
    if (method === 'eth_getTransactionByHash') {
      return this.oldGuard ? unclassifiedRefusal(id) : refusal(id)
    }
    if (method === 'eth_sendRawTransaction') {
      const signed = params[0] as Hex; const tx = parseTransaction(signed)
      const cost = (tx.value ?? 0n) + (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n)
      if (cost > BALANCE) return insufficient(id, cost)
      const hash = keccak256(signed); this.held.set(hash, signed)
      this.cancelWasDurable ||= this.withdrawalFile !== '' && JSON.parse(readFileSync(this.withdrawalFile, 'utf8')).cancels?.some((c: { hash: string }) => c.hash === hash)
      return reply(id, hash)
    }
    return reply(id, null)
  }) as typeof fetch

  mine(hash: Hex, number = this.finalized): void { this.mined.set(hash, BigInt(number)); this.finalized = BigInt(number); this.finalizedNonce = NONCE + 1 }
}

async function signedWithdrawal(): Promise<Hex> {
  return ACCOUNT.signTransaction({ chainId: 8453, type: 'eip1559', nonce: NONCE, to: ACCOUNT.address, value: COST - 21_000n * 10n, gas: 21_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })
}
async function setup() {
  const node = new FakeBaseNode(); const paths = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-k025-e2e-')))
  const rails = await makeBuyerEvmRails({ privateKey: KEY, swapAddress: SWAP, usdcTokenAddress: USDC, rpcUrls: ['http://base.test'], fetchImpl: node.fetch, retryDelayMs: 1 })
  const logs: string[] = []
  const intents = makeBuyerWithdrawalIntents(paths, rails.client, () => 1, undefined, { assertSafeForNewLock: () => rails.assertSafeForNewLock(), log: (line) => logs.push(line) })
  const signedTx = await signedWithdrawal(); const hash = keccak256(signedTx)
  await intents.record({ asset: 'ETH', to: ACCOUNT.address, amount: 1n, hash, signedTx, nonce: NONCE })
  node.withdrawalFile = join(paths.withdrawalsDir, `${hash}.json`)
  return { node, intents, rails, hash, signedTx, file: node.withdrawalFile, logs }
}
const rejects = async (run: () => Promise<unknown>, match: RegExp) => {
  const error = await run().then(() => expect.fail('must reject'), (value) => value as Error)
  expect(error.message).match(match)
}

describe('buyer withdrawal recovery — publicnode refused lookups through real rails', () => {
  it('call 1 records a zero-value self-cancel before the real client broadcasts it', async () => {
    const { node, intents, file } = await setup()
    await rejects(() => intents.reconcile(), /refused the withdrawal.*zero-value cancellation/)
    const record = JSON.parse(readFileSync(file, 'utf8')); expect(record.cancels).to.have.length(1)
    const cancel = parseTransaction(record.cancels[0].signedTx)
    expect({ value: cancel.value ?? 0n, to: cancel.to?.toLowerCase(), from: (await recoverTransactionAddress({ serializedTransaction: record.cancels[0].signedTx })).toLowerCase(), nonce: Number(cancel.nonce) }).deep.eq({ value: 0n, to: ACCOUNT.address.toLowerCase(), from: ACCOUNT.address.toLowerCase(), nonce: NONCE })
    expect(node.cancelWasDurable).eq(true); expect(node.methods.filter((method) => method === 'eth_sendRawTransaction')).to.have.length(2)
  })

  it('call 2 re-sends the same unmined cancellation and records no new one', async () => {
    const { node, intents, file } = await setup()
    await rejects(() => intents.reconcile(), /zero-value cancellation/); const before = readFileSync(file, 'utf8'); const sends = node.methods.filter((m) => m === 'eth_sendRawTransaction').length
    await rejects(() => intents.reconcile(), /being cancelled/)
    expect(readFileSync(file, 'utf8')).eq(before); expect(node.methods.filter((m) => m === 'eth_sendRawTransaction')).length(sends + 1)
    expect(JSON.parse(before)).deep.include({ state: 'pending' }); expect([...node.held.keys()]).deep.eq([JSON.parse(before).cancels[0].hash])
  })

  it('call 3 finalizes a mined cancellation even while the original receipt remains refused', async () => {
    const { node, intents, file } = await setup()
    await rejects(() => intents.reconcile(), /zero-value cancellation/); const cancel = JSON.parse(readFileSync(file, 'utf8')).cancels[0].hash as Hex
    node.mine(cancel, 101n)
    expect(await intents.reconcile()).deep.include({ status: 'cancelled' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).deep.include({ state: 'done', status: 'cancelled' })
    expect(node.finalizedNonce).eq(NONCE + 1)
  })

  it('records the manual nonce warning when both receipts remain refused after nonce consumption', async () => {
    const { node, intents, file } = await setup()
    await rejects(() => intents.reconcile(), /zero-value cancellation/); node.finalizedNonce = NONCE + 1
    const sends = node.methods.filter((m) => m === 'eth_sendRawTransaction').length
    await rejects(() => intents.reconcile(), /used its nonce but its receipt was not found/)
    expect(JSON.parse(readFileSync(file, 'utf8')).nonceConsumedAtBlock).eq(node.finalized.toString())
    expect(node.finalizedNonce).eq(NONCE + 1)
    expect(node.methods.filter((m) => m === 'eth_sendRawTransaction')).length(sends)
  })

  it('keeps a generic receipt failure byte-identical, with masked one-line diagnostics', async () => {
    const { node, intents, file, signedTx, logs } = await setup()
    node.failReceipts = true; const before = readFileSync(file, 'utf8')
    await rejects(() => intents.reconcile(), /could not confirm the previous Base withdrawal/)
    expect(readFileSync(file, 'utf8')).eq(before); expect(node.methods).not.include('eth_sendRawTransaction')
    expect(logs).length(1); expect(logs[0]).not.include(signedTx); expect(logs[0]).not.match(/0x[0-9a-f]{67,}/i)
    expect(node.methods.filter((m) => m === 'eth_getTransactionReceipt').length).greaterThan(1)
  })

  // A 0.2.4 control cannot run here: 0.2.4 also lacked the reconcile change, so the guard alone cannot reproduce it.
  // Instead: a refusal the transport guard does not convert (viem's raw 403 error) still counts as no receipt.
  it('a refusal the transport guard misses still reaches the zero-value cancellation', async () => {
    const { node, intents, rails, hash, file } = await setup(); node.oldGuard = true
    const raw = await rails.client.receipt(hash).then(() => expect.fail('must reject'), (error: unknown) => error)
    expect(raw).not.instanceOf(LookupRefusedError); expect(isLookupRefusal(raw)).eq(true)
    await rejects(() => intents.reconcile(), /refused the withdrawal.*zero-value cancellation/)
    expect(JSON.parse(readFileSync(file, 'utf8')).cancels).to.have.length(1); expect(node.cancelWasDurable).eq(true)
  })
})
