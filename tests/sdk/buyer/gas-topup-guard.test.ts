// FIX-C1 item 7: buy_gas never signs while a Base withdrawal is unresolved or a swap's Base approve or lock can still
// be sent; a state only the user can clear keeps its own message; a waiting swap, the unaffordable-cancel state and a
// bad limits.json never refuse it.
import { expect } from 'chai'
import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { createBuyerKit } from '../../../src/sdk/buyer/buyer-kit'
import { makeCowOrderBook } from '../../../src/sdk/buyer/gas-topup-api'
import { makeBuyerGasTopUp } from '../../../src/sdk/buyer/gas-topup'
import { GAS_TOPUP_BASE_BUSY_MESSAGE } from '../../../src/sdk/buyer/gas-topup-guard'
import { readBuyerLimits } from '../../../src/sdk/buyer/limits'
import { initialiseBuyerHome, type BuyerHome } from '../../../src/sdk/buyer/local-state'
import type { BuyerSwapRecord, BuyerWithdrawalIntents } from '../../../src/sdk/buyer/types'
import { makeBuyerWithdrawalIntents, MAX_CANCELS, type BuyerWithdrawalRails } from '../../../src/sdk/buyer/withdrawal-intent'
import { OWN_BSV, row, writeWithdrawalIntent } from './close-helpers'
import { FakeCowOrderBook, FakeGasChain } from './helpers/gas-fakes'

const hashOf = (digit: string): string => `0x${digit.repeat(64)}`
const WITHDRAWAL = hashOf('a')
const SIGNED = `0x${'d'.repeat(10)}`
const insufficientFunds = (): Error => new Error('insufficient funds for gas * price + value')
/** A Base RPC for the withdrawal records: nothing mined, the nonce not yet used, and a re-send that returns the hash. */
const quietRails = (more: Partial<BuyerWithdrawalRails> = {}): BuyerWithdrawalRails => ({
  receipt: async () => undefined, finalizedBlockNumber: async () => 10n, nonceAtBlock: async () => 0, resendSigned: async () => WITHDRAWAL as `0x${string}`, ...more,
})

/** The real kit and gas module over fakes, with the given swap rows and Base withdrawal records. */
function guardHarness(opts: { swaps?: BuyerSwapRecord[]; rails?: BuyerWithdrawalRails; intents?: BuyerWithdrawalIntents; badLimits?: boolean } = {}) {
  const paths: BuyerHome = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-gas-guard-')))
  const account = privateKeyToAccount(generatePrivateKey())
  const chain = new FakeGasChain()
  const book = new FakeCowOrderBook(chain)
  let signatures = 0
  const signTypedData = (async (parameters: any) => { signatures++; return account.signTypedData(parameters) }) as LocalAccount['signTypedData']
  const gasTopUp = makeBuyerGasTopUp({ home: paths.home, owner: account.address, chain, api: makeCowOrderBook({ fetch: book.fetch, timeoutMs: 200 }), signTypedData, now: chain.clock })
  const never = async (): Promise<never> => { throw new Error('nothing but buy_gas runs in these tests') }
  const swaps = opts.swaps ?? []
  if (opts.badLimits) writeFileSync(paths.limitsPath, '{ "maxSwapUsd": ', { mode: 0o600 })
  const kit = createBuyerKit({}, {
    store: { list: async () => swaps, get: async () => undefined, put: async () => {} },
    door: { quote: never, admit: never }, executor: { execute: never },
    wallet: { baseAddress: account.address, bsvAddress: OWN_BSV, balances: never, withdrawBsv: never, transferUsdc: never, transferEth: never },
    withdrawalIntents: opts.intents ?? makeBuyerWithdrawalIntents(paths, opts.rails ?? quietRails()),
    limits: () => readBuyerLimits(paths),
    gasTopUp,
  })
  const nothingSigned = (): void => { expect(book.quotes, 'quotes').length(0); expect(signatures, 'signatures').eq(0); expect(chain.reads, 'chain reads').eq(0) }
  return { paths, account, chain, book, kit, swaps, signatures: () => signatures, nothingSigned }
}

const withdrawalTo = (paths: BuyerHome): void => writeWithdrawalIntent(paths, WITHDRAWAL, 'USDC', privateKeyToAccount(generatePrivateKey()).address)

describe('buy_gas waits for a Base withdrawal or swap lock, and only for those', () => {
  it('7 quoted and admitted swaps refuse with the approved text, before anything is read, quoted or signed', async () => {
    expect(GAS_TOPUP_BASE_BUSY_MESSAGE).eq('a Base withdrawal or swap lock is still being confirmed; nothing was signed; call buy_gas again in 30 s')
    for (const swap of [row('a', 'quoted'), row('b', 'admitted'), row('c', 'needs_attention', { settlementState: 'created' }), row('d', 'usdc_locked', { settlementState: 'created' }), row('e', 'a_stage_this_kit_does_not_know')]) {
      const h = guardHarness({ swaps: [swap] })
      expect(await h.kit.buyGas!(), swap.stage).deep.eq({ state: 'refused', reason: GAS_TOPUP_BASE_BUSY_MESSAGE })
      h.nothingSigned()
    }
  })

  it('7 a swap that is only waiting (for the BSV lock, a refund, or after it) never refuses buy_gas', async () => {
    const waiting = ['refund_waiting', 'waiting_bsv_lock', 'bsv_lock_confirming', 'claiming', 'claimed', 'settled', 'sweeping', 'delivered', 'refunded', 'failed']
    for (const stage of [...waiting, 'needs_attention', 'usdc_locked']) {
      const h = guardHarness({ swaps: [row('a', stage, { settlementState: waiting.includes(stage) ? 'created' : 'base-locked' })] })
      const step = await h.kit.buyGas!()
      expect(step.state, stage).eq('pending')
      expect(h.book.orders.size, stage).eq(1)
    }
  })

  it('7 a pending Base withdrawal refuses with the approved text, and nothing is quoted or signed', async () => {
    const resent = guardHarness()
    withdrawalTo(resent.paths) // the re-send answers its own hash: still pending
    expect(await resent.kit.buyGas!()).deep.eq({ state: 'refused', reason: GAS_TOPUP_BASE_BUSY_MESSAGE })
    resent.nothingSigned()
    const mined = guardHarness({ rails: quietRails({ receipt: async () => ({ status: 'success', blockNumber: 11n }) }) })
    withdrawalTo(mined.paths) // mined, but past the finalized block
    expect(await mined.kit.buyGas!()).deep.eq({ state: 'refused', reason: GAS_TOPUP_BASE_BUSY_MESSAGE })
    mined.nothingSigned()
    // A record that reconcile did not settle still waits.
    const listed = guardHarness({ intents: {
      reconcile: async () => undefined, record: async () => {}, done: async () => {},
      list: () => [{ asset: 'USDC', to: 'unused', amount: '1', hash: WITHDRAWAL, createdAtMs: 1, state: 'pending' }],
    } })
    expect(await listed.kit.buyGas!()).deep.eq({ state: 'refused', reason: GAS_TOPUP_BASE_BUSY_MESSAGE })
    listed.nothingSigned()
    // Once it is final on Base, buy_gas goes ahead.
    const final = guardHarness({ rails: quietRails({ receipt: async () => ({ status: 'success', blockNumber: 9n }), nonceAtBlock: async () => 1 }) })
    withdrawalTo(final.paths)
    expect((await final.kit.buyGas!()).state).eq('pending')
  })

  it('7 the consumed-nonce warning, the cancel limit and "cannot cancel" keep their own message, with no call-again', async () => {
    const nonce = guardHarness({ rails: quietRails({ nonceAtBlock: async () => 1 }) })
    withdrawalTo(nonce.paths)
    const warned = await nonce.kit.buyGas!()
    expect(warned.state === 'refused' && warned.reason).eq(`a previous Base withdrawal (${WITHDRAWAL}) used its nonce but its receipt was not found, so it may have been paid; check ${WITHDRAWAL} on a Base block explorer, then run \`npx petasats-mcp withdrawal ${WITHDRAWAL} sent\` or \`npx petasats-mcp withdrawal ${WITHDRAWAL} not-sent\`; nothing new was sent`)
    nonce.nothingSigned()

    const limit = guardHarness({ rails: quietRails({ resendSigned: async () => hashOf('f') as `0x${string}` }) })
    const cancels = ['b', 'c', 'e'].map((digit) => ({ hash: hashOf(digit), signedTx: SIGNED, atMs: 0 }))
    expect(cancels).length(MAX_CANCELS)
    const file = join(limit.paths.withdrawalsDir, `${WITHDRAWAL}.json`)
    writeFileSync(file, JSON.stringify({ asset: 'USDC', to: limit.account.address, amount: '1', nonce: 0, hash: WITHDRAWAL, signedTx: SIGNED, createdAtMs: 1, state: 'pending', cancels }))
    chmodSync(file, 0o600)
    const limited = await limit.kit.buyGas!()
    expect(limited.state === 'refused' && limited.reason).eq(`the previous Base withdrawal ${WITHDRAWAL} could not be cancelled after 3 attempts. It stays recorded. Nothing new was sent.`)
    limit.nothingSigned()

    const unsupported = guardHarness({ rails: quietRails({ resendSigned: async () => { throw insufficientFunds() } }) })
    withdrawalTo(unsupported.paths)
    const cannot = await unsupported.kit.buyGas!()
    expect(cannot.state === 'refused' && cannot.reason).eq(`this kit runtime cannot cancel the refused Base withdrawal ${WITHDRAWAL}. The withdrawal stays recorded and blocks new money until it is resolved. Nothing new was sent.`)
    unsupported.nothingSigned()
    for (const step of [warned, limited, cannot]) expect(step.state === 'refused' && step.reason).not.include('call buy_gas again')
  })

  it('7 the unaffordable-cancel state never refuses buy_gas: buying gas is its way out', async () => {
    const h = guardHarness({ rails: quietRails({ resendSigned: async () => { throw insufficientFunds() }, consumeNonce: async () => { throw insufficientFunds() } }) })
    withdrawalTo(h.paths)
    const step = await h.kit.buyGas!()
    expect(step.state).eq('pending')
    expect(h.book.orders.size).eq(1)
  })

  it('7 a bad limits.json never refuses buy_gas', async () => {
    const h = guardHarness({ badLimits: true })
    expect(() => readBuyerLimits(h.paths)).to.throw(/^refused by your limits file: /)
    expect((await h.kit.buyGas!()).state).eq('pending')
    expect(h.book.orders.size).eq(1)
  })

  it('7 the wait runs only before a new order: an open order is reconciled and reported first', async () => {
    const h = guardHarness()
    const first = await h.kit.buyGas!()
    expect(first.state).eq('pending')
    h.swaps.push(row('a', 'quoted'))
    const again = await h.kit.buyGas!()
    expect(again).to.deep.include({ state: 'pending', uid: first.state === 'pending' && first.uid })
    h.book.settle(h.book.only().uid)
    expect((await h.kit.buyGas!()).state).eq('filled') // the fill is reported, even with the quoted swap waiting
    expect(await h.kit.buyGas!()).deep.eq({ state: 'refused', reason: GAS_TOPUP_BASE_BUSY_MESSAGE })
    expect(h.book.orders.size).eq(1)
  })
})
