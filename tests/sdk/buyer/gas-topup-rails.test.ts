import { expect } from 'chai'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { custom, decodeFunctionData, encodeAbiParameters, isAddressEqual, numberToHex, parseAbi, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { BASE_USDC } from '../../../src/bridge/evm/base-tokens'
import { makeCowOrderBook } from '../../../src/sdk/buyer/gas-topup-api'
import { makeBuyerGasTopUp } from '../../../src/sdk/buyer/gas-topup'
import { ALREADY_HAS_GAS_WEI, COW_SETTLEMENT, COW_VAULT_RELAYER, GAS_TOPUP_SELL, usdcDomainSeparator } from '../../../src/sdk/buyer/gas-topup-order'
import { readGasTopUp } from '../../../src/sdk/buyer/gas-topup-state'
import { initialiseBuyerHome } from '../../../src/sdk/buyer/local-state'
import { makeBuyerGasTopUpRails } from '../../../src/sdk/buyer/runtime/gas-topup-rails'
import { FakeCowOrderBook, FakeGasChain } from './helpers/gas-fakes'

const READS = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function filledAmount(bytes orderUid) view returns (uint256)',
])
const BLOCK = 41_000_123n
const ALLOWANCE_STANDS = "a USDC allowance of 0.50 USDC or more for the CoW Protocol vault relayer already exists, so the kit could not later tell whether a new order sold; nothing was signed; send a little ETH for gas to the kit's Base address instead"
const word = (value: bigint): Hex => encodeAbiParameters([{ type: 'uint256' }], [value])
/** The rails use the real local clock, so the fake block time is now: the kit's clock check passes. */
const blockTime = (): number => Math.floor(Date.now() / 1000)
const safe = async (): Promise<void> => {}

/** A Base RPC as a viem custom transport: it answers the rails' reads and logs every call with its block tag. */
function fakeRpc(eth: bigint, filled = 0n, allowance = 0n) {
  const calls: Array<{ method: string; target?: string; fn?: string; args?: readonly unknown[]; block?: unknown }> = []
  const transport = custom({
    async request({ method, params }: { method: string; params?: any }) {
      if (method === 'eth_getBlockByNumber') {
        calls.push({ method, block: params[0] })
        return { number: numberToHex(BLOCK), timestamp: numberToHex(blockTime()), hash: `0x${'1'.repeat(64)}`, parentHash: `0x${'2'.repeat(64)}`, transactions: [] }
      }
      if (method === 'eth_getBalance') { calls.push({ method, block: params[1] }); return numberToHex(eth) }
      if (method === 'eth_call') {
        const { functionName, args } = decodeFunctionData({ abi: READS, data: params[0].data })
        calls.push({ method, target: params[0].to, fn: functionName, args, block: params[1] })
        if (functionName === 'DOMAIN_SEPARATOR') return usdcDomainSeparator()
        if (functionName === 'filledAmount') return word(filled)
        if (functionName === 'allowance') return word(allowance)
        return word(functionName === 'nonces' ? 7n : 2_000_000n)
      }
      throw new Error(`unexpected RPC method ${method}`)
    },
  })
  return { transport, calls }
}

describe('buy_gas Base rails', () => {
  it('refuses a key that is not the kit\'s Base key', () => {
    const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-rails-'))).home
    const other = privateKeyToAccount(generatePrivateKey()).address
    expect(() => makeBuyerGasTopUpRails({ home, privateKey: generatePrivateKey(), baseAddress: other, transport: fakeRpc(0n).transport, assertSafeForNewLock: safe })).to.throw("buy_gas signer does not match the kit's Base address")
  })

  it('reads the time, balances, nonce, domain and vault relayer allowance at one pinned block, and asks the order book nothing when the kit has gas', async () => {
    const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-rails-'))).home
    const privateKey = generatePrivateKey()
    const rpc = fakeRpc(ALREADY_HAS_GAS_WEI)
    let fetches = 0
    let gate = 0
    const rails = makeBuyerGasTopUpRails({ home, privateKey, baseAddress: privateKeyToAccount(privateKey).address, transport: rpc.transport, fetch: (async () => { fetches++; throw new Error('no fetch') }) as typeof fetch, assertSafeForNewLock: async () => { gate++ } })
    expect(rpc.calls).length(0) // assembling the rails reads nothing
    const step = await rails.buy()
    expect(step).deep.eq({ state: 'refused', reason: 'the kit already has gas (0.00002 ETH); nothing was signed' })
    expect(gate).eq(1)
    expect(rpc.calls[0]).deep.eq({ method: 'eth_getBlockByNumber', block: 'latest' })
    expect(rpc.calls.slice(1).map((c) => c.block)).deep.eq([numberToHex(BLOCK), numberToHex(BLOCK), numberToHex(BLOCK), numberToHex(BLOCK), numberToHex(BLOCK)])
    expect(rpc.calls.filter((c) => c.method === 'eth_call').every((c) => isAddressEqual(c.target as Hex, BASE_USDC))).eq(true)
    expect(rpc.calls.map((c) => c.fn ?? c.method).sort()).deep.eq(['DOMAIN_SEPARATOR', 'allowance', 'balanceOf', 'eth_getBalance', 'eth_getBlockByNumber', 'nonces'])
    const [owner, spender] = rpc.calls.find((c) => c.fn === 'allowance')!.args as readonly [Hex, Hex] // USDC.allowance(kit, vault relayer)
    expect(isAddressEqual(owner, privateKeyToAccount(privateKey).address)).eq(true)
    expect(isAddressEqual(spender, COW_VAULT_RELAYER)).eq(true)
    expect(fetches).eq(0)
  })

  it('refuses a new order while the vault relayer allowance it reads is 0.50 USDC or more, before asking for a quote', async () => {
    const buyWith = async (allowance: bigint) => {
      const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-rails-'))).home
      const privateKey = generatePrivateKey()
      let fetches = 0
      const rails = makeBuyerGasTopUpRails({ home, privateKey, baseAddress: privateKeyToAccount(privateKey).address, transport: fakeRpc(0n, 0n, allowance).transport, fetch: (async () => { fetches++; throw new Error('no fetch') }) as typeof fetch, assertSafeForNewLock: safe })
      return { step: await rails.buy(), fetches: () => fetches }
    }
    const standing = await buyWith(GAS_TOPUP_SELL)
    expect(standing.step).deep.eq({ state: 'refused', reason: ALLOWANCE_STANDS })
    expect(standing.fetches()).eq(0)
    const below = await buyWith(GAS_TOPUP_SELL - 1n) // the kit goes on to ask for a quote, which this fetch fails
    expect(below.step.state === 'refused' && below.step.reason).match(/^CoW Protocol could not quote the gas purchase /)
    expect(below.fetches()).eq(1)
  })

  it('reads an open order\'s filled amount from the settlement contract at the same block', async () => {
    const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-rails-'))).home
    const privateKey = generatePrivateKey()
    const account = privateKeyToAccount(privateKey)
    // Place an order with the fakes, so the home holds a real signed, posted record for this key.
    const chain = new FakeGasChain(); const book = new FakeCowOrderBook(chain)
    await makeBuyerGasTopUp({ home, owner: account.address, chain, api: makeCowOrderBook({ fetch: book.fetch }), signTypedData: account.signTypedData, now: chain.clock }).buy()
    const rpc = fakeRpc(0n, 500_000n)
    const notFound = (async () => new Response(JSON.stringify({ errorType: 'NotFound' }), { status: 404 })) as typeof fetch
    const rails = makeBuyerGasTopUpRails({ home, privateKey, baseAddress: account.address, transport: rpc.transport, fetch: notFound, assertSafeForNewLock: safe })
    await rails.assertNoOpenOrder('withdraw') // the chain shows the fill, so nothing is open
    expect(readGasTopUp(home)).to.include({ over: true, overAtBlock: BLOCK.toString() }) // the block the rails' reads were pinned to
    const filled = rpc.calls.find((c) => c.fn === 'filledAmount')
    expect(filled).to.include({ block: numberToHex(BLOCK) })
    expect(isAddressEqual(filled!.target as Hex, COW_SETTLEMENT)).eq(true)
    expect(rails.view()).to.include({ status: 'filled' })
  })

  it('3 reads Base only through the kit\'s safety gate: a split or unverified pool refuses before any read or signature', async () => {
    const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-rails-'))).home
    const privateKey = generatePrivateKey()
    const rpc = fakeRpc(0n)
    let fetches = 0
    const split = async (): Promise<never> => { throw new Error('buyer EVM rail is split or unverified — refusing a new lock') }
    const rails = makeBuyerGasTopUpRails({ home, privateKey, baseAddress: privateKeyToAccount(privateKey).address, transport: rpc.transport, fetch: (async () => { fetches++; throw new Error('no fetch') }) as typeof fetch, assertSafeForNewLock: split })
    const step = await rails.buy()
    expect(step.state).eq('refused')
    expect(step.state === 'refused' && step.reason).eq("the Base RPC could not be read (buyer EVM rail is split or unverified — refusing a new lock); nothing was signed; call buy_gas again shortly, or send a little ETH for gas to the kit's Base address instead")
    expect(rpc.calls).length(0); expect(fetches).eq(0)
  })
})
