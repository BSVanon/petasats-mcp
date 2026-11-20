// The close-down pin: which pair close.json holds, when it may move, and how a stop or a bad record is reported.
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { expect } from 'chai'
import { chmodSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getAddress } from 'viem'
import { BASE_USDC } from '../../../src/bridge/evm/base-tokens'
import { createBuyerKit } from '../../../src/sdk/buyer/buyer-kit'
import { CLOSED_STOP_REASON, closeKitStep } from '../../../src/sdk/buyer/close'
import type { BuyerHome } from '../../../src/sdk/buyer/local-state'
import { readBuyerLimits } from '../../../src/sdk/buyer/limits'
import { readSpendingStop, resumeSpending, stopSpending } from '../../../src/sdk/buyer/stop'
import type { BuyerKit, BuyerWithdrawalRecorder, BuyerWithdrawalReconcileOutcome } from '../../../src/sdk/buyer/types'
import {
  BAD_SWEEPS, DEST_BASE, DEST_BSV, NON_CHECKSUMMED_BASE, NON_P2PKH_BSV, OTHER_BASE, OTHER_BSV, OWN_BASE, OWN_BSV, PAIR, ZERO_BASE,
  fakeKit, home, readCloseFile, resolveWithdrawalIntent, walletInfoOf, writeCloseFile, writeWithdrawalIntent, type FakeState,
} from './close-helpers'

const ONE_USDC = 1_000_000n
const BASE_FORMAT = 'to must be a non-zero checksummed Base address'
const BSV_FORMAT = 'deliver_to must be a mainnet Base58Check P2PKH BSV address'
const pinnedText = (base: string, bsv: string): string =>
  `this kit's close-down goes to base ${base} and BSV ${bsv} and can only finish to that pair; call close_kit again with those two addresses`

/**
 * The real createBuyerKit over in-memory rails, so its own destination refusals are what close.ts sees. `ran` lists
 * every wallet call that could price, sign, record or send. `reconcile` defaults to "nothing to reconcile"; a test
 * for a prior withdrawal becoming final during reconciliation overrides it.
 */
function realKit(paths: BuyerHome, s: { usdc: bigint }, reconcile: () => Promise<BuyerWithdrawalReconcileOutcome | undefined> = async () => undefined): { kit: BuyerKit; transfers: string[]; ran: string[] } {
  const transfers: string[] = []
  const ran: string[] = []
  const fail = (): Promise<never> => Promise.reject(new Error('not used'))
  const send = async (name: string, onRecorded?: BuyerWithdrawalRecorder) => {
    ran.push(name)
    await onRecorded?.({ hash: `0x${'9'.repeat(64)}`, signedTx: '0x00', nonce: 0 })
    return { hash: `0x${'9'.repeat(64)}`, status: 'success', blockNumber: 1n }
  }
  const kit = createBuyerKit({ baseWithdrawalForbidden: [BASE_USDC] }, {
    door: { quote: fail, admit: fail } as never,
    executor: { execute: async () => ({ ok: true }) } as never,
    store: { list: async () => [], get: async () => undefined, put: async () => undefined },
    wallet: {
      baseAddress: OWN_BASE, bsvAddress: OWN_BSV,
      balances: async () => ({ usdc: s.usdc, eth: 10n ** 15n, claimedBsvSats: 0n, unconfirmedBsvSats: 0n }),
      transferUsdc: async (to: string, _amount: bigint, onRecorded?: BuyerWithdrawalRecorder) => { transfers.push(to); s.usdc = 0n; return send('transferUsdc', onRecorded) },
      transferEth: async (_to: string, _amount: bigint, onRecorded?: BuyerWithdrawalRecorder) => send('transferEth', onRecorded),
      priceEthTransfer: async () => { ran.push('priceEthTransfer'); return { gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, l1FeeWei: 1n, reserveWei: 30_000n } },
      withdrawBsv: async () => { ran.push('wallet.withdrawBsv'); return { sats: 0n, reason: 'no confirmed BSV is available to sweep' } },
    } as never,
    withdrawalIntents: { reconcile, record: async () => { ran.push('withdrawalIntents.record') }, done: async () => {}, list: () => [] },
    limits: () => readBuyerLimits(paths), spendingStopped: () => readSpendingStop(paths),
  })
  return { kit, transfers, ran }
}

function writeLimits(paths: BuyerHome, value: Record<string, unknown>): void {
  writeFileSync(paths.limitsPath, JSON.stringify({ format: 'petasats.limits/1', ...value }))
  chmodSync(paths.limitsPath, 0o600)
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { return error instanceof Error ? error.message : String(error) }
  return 'resolved'
}

describe('buyer kit close-down: the pin', () => {
  it('M1 (P-A) a destination the kit refuses (the USDC token) is refused before anything is pinned; the right pair then goes ahead', async () => {
    const paths = home()
    const { kit, transfers } = realKit(paths, { usdc: 5n * ONE_USDC })
    const wrong = await closeKitStep({ kit, paths }, { baseAddress: BASE_USDC, bsvAddress: DEST_BSV })
    expect(wrong.state).eq('refused')
    if (wrong.state === 'refused') {
      expect(wrong.reason).eq('cannot withdraw to a swap or token contract')
      expect(wrong.retry_after_seconds).eq(undefined)
    }
    expect(existsSync(join(paths.home, 'close.json')), 'nothing is pinned').eq(false)
    const right = await closeKitStep({ kit, paths }, PAIR)
    expect(right.state).eq('in_progress')
    expect(transfers).deep.eq([DEST_BASE])
    expect(readCloseFile(paths).baseAddress).eq(DEST_BASE)
  })

  it('M1 (P-A2) an address missing from baseDestinations or bsvDestinations is refused before anything is pinned', async () => {
    const paths = home()
    writeLimits(paths, { baseDestinations: [DEST_BASE], bsvDestinations: [DEST_BSV] })
    const { kit, transfers } = realKit(paths, { usdc: 5n * ONE_USDC })
    const base = await closeKitStep({ kit, paths }, { baseAddress: OTHER_BASE, bsvAddress: DEST_BSV })
    expect(base.state === 'refused' && base.reason).eq('refused by your limits file: this Base address is not in baseDestinations; nothing was sent')
    const bsv = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: OTHER_BSV })
    expect(bsv.state === 'refused' && bsv.reason).eq('refused by your limits file: this BSV address is not in bsvDestinations; nothing was sent')
    expect(existsSync(join(paths.home, 'close.json')), 'nothing is pinned').eq(false)
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('in_progress')
    expect(transfers).deep.eq([DEST_BASE])
  })

  it('M1 one rule set: the kit method refuses exactly as withdrawBase and withdrawBsv do, and every rule runs on every call', async () => {
    const paths = home()
    writeLimits(paths, { baseDestinations: [DEST_BASE, BASE_USDC, OWN_BASE], bsvDestinations: [DEST_BSV] })
    const s = { usdc: 5n * ONE_USDC }
    const { kit, ran } = realKit(paths, s)
    for (const base of [NON_CHECKSUMMED_BASE, ZERO_BASE, OTHER_BASE, OWN_BASE, BASE_USDC]) {
      const viaMethod = await rejection(kit.assertWithdrawDestinations({ base, bsv: DEST_BSV }))
      expect(viaMethod, base).not.eq('resolved')
      expect(await rejection(kit.withdrawBase({ asset: 'USDC', to: base, amount: 'all' })), base).eq(viaMethod)
    }
    for (const bsv of [NON_P2PKH_BSV, OTHER_BSV]) {
      const viaMethod = await rejection(kit.assertWithdrawDestinations({ base: DEST_BASE, bsv }))
      expect(viaMethod, bsv).not.eq('resolved')
      expect(await rejection(kit.withdrawBsv(bsv)), bsv).eq(viaMethod)
    }
    expect(await rejection(kit.assertWithdrawDestinations({ base: DEST_BASE, bsv: DEST_BSV }))).eq('resolved')
    // Called untyped: a value that is not a string, or a side left out, gets the malformed-address refusal.
    const untyped = kit as unknown as { assertWithdrawDestinations(to: unknown): Promise<void>; withdrawBase(request: unknown): Promise<unknown>; withdrawBsv(address: unknown): Promise<unknown> }
    for (const bad of [undefined, null, '', 0, {}]) {
      const label = JSON.stringify(bad) ?? 'undefined'
      for (const asset of ['USDC', 'ETH']) {
        s.usdc = asset === 'USDC' ? 5n * ONE_USDC : 0n // with these balances each withdrawal would reach its wallet call
        for (const amount of ['all', '1']) expect(await rejection(untyped.withdrawBase({ asset, to: bad, amount })), `${asset} ${amount} ${label}`).eq(BASE_FORMAT)
      }
      expect(await rejection(untyped.withdrawBsv(bad)), label).eq(BSV_FORMAT)
      expect(await rejection(untyped.assertWithdrawDestinations({ base: bad, bsv: DEST_BSV })), label).eq(BASE_FORMAT)
      expect(await rejection(untyped.assertWithdrawDestinations({ base: DEST_BASE, bsv: bad })), label).eq(BSV_FORMAT)
    }
    expect(await rejection(untyped.assertWithdrawDestinations({ bsv: DEST_BSV })), 'no base').eq(BASE_FORMAT)
    expect(await rejection(untyped.assertWithdrawDestinations({ base: DEST_BASE })), 'no bsv').eq(BSV_FORMAT)
    expect(ran, 'no wallet call ran').deep.eq([])

    // A prior withdrawal that becomes final during reconciliation never lets a malformed `to` skip the destination
    // checks: the format refusal fires first, and reconciliation (which belongs to the earlier withdrawal) never runs.
    let reconcileCalls = 0
    const finalOutcome: BuyerWithdrawalReconcileOutcome = { hash: `0x${'7'.repeat(64)}`, asset: 'USDC', to: DEST_BASE, amount: '1', status: 'success' }
    const reconciling = realKit(home(), { usdc: 5n * ONE_USDC }, async () => { reconcileCalls++; return finalOutcome })
    const untypedReconciling = reconciling.kit as unknown as { withdrawBase(request: unknown): Promise<unknown> }
    for (const bad of [undefined, null, '', 0, {}]) {
      const label = JSON.stringify(bad) ?? 'undefined'
      for (const asset of ['USDC', 'ETH']) {
        expect(await rejection(untypedReconciling.withdrawBase({ asset, to: bad, amount: 'all' })), `${asset} ${label}`).eq(BASE_FORMAT)
      }
    }
    expect(reconcileCalls, 'reconciliation belongs to the prior withdrawal; a malformed destination must never trigger it').eq(0)
    expect(reconciling.ran, 'no wallet call ran either').deep.eq([])

    // n5: a WELL-FORMED but forbidden `to` (the USDC token contract, forbidden via baseWithdrawalForbidden above)
    // must refuse on the same destination check as M1 (P-A) above, before reconciliation ever runs — not merely
    // when the input is malformed, as the loop just above already covers.
    const forbidden = await rejection(untypedReconciling.withdrawBase({ asset: 'USDC', to: BASE_USDC, amount: 'all' }))
    expect(forbidden).eq('cannot withdraw to a swap or token contract')
    expect(reconcileCalls, 'a forbidden destination must never trigger reconciliation either').eq(0)
  })

  it('U1 withdrawBase of all the ETH with no destination is refused before anything is priced or sent', async () => {
    const paths = home()
    writeLimits(paths, { baseDestinations: [DEST_BASE], bsvDestinations: [DEST_BSV] })
    const { kit, ran } = realKit(paths, { usdc: 0n })
    expect(await rejection(kit.withdrawBase({ asset: 'ETH', to: undefined as never, amount: 'all' }))).eq(BASE_FORMAT)
    expect(ran).deep.eq([])
  })

  it('U2 withdrawBsv with no address is refused before the sweep, with bsvDestinations set and without a limits file', async () => {
    for (const limits of [{ baseDestinations: [DEST_BASE], bsvDestinations: [DEST_BSV] }, undefined]) {
      const paths = home()
      if (limits) writeLimits(paths, limits)
      const { kit, ran } = realKit(paths, { usdc: 0n })
      expect(await rejection(kit.withdrawBsv(undefined as never)), String(!!limits)).eq(BSV_FORMAT)
      expect(ran, String(!!limits)).deep.eq([])
    }
  })

  it('M1 a pin nothing has used moves to a new pair; a send, a saved sweep, final, or a withdrawal since startedAt keeps it', async () => {
    const send = { asset: 'USDC', amount: '1', to: DEST_BASE, txid: `0x${'a'.repeat(64)}` }
    const cases: Array<{ label: string; record: Record<string, unknown>; intent?: { to: string; createdAtMs: number; done?: boolean }; moves: boolean }> = [
      { label: 'unused', record: {}, moves: true },
      { label: 'a withdrawal to the pinned address made before startedAt', record: {}, intent: { to: DEST_BASE, createdAtMs: 999, done: true }, moves: true },
      { label: 'a withdrawal since startedAt to another address', record: {}, intent: { to: OTHER_BASE, createdAtMs: 2000, done: true }, moves: true },
      { label: 'a send', record: { sends: [send] }, moves: false },
      { label: 'a saved BSV sweep', record: { bsvOutbox: { txid: 'c'.repeat(64), sats: '5000', inputs: [`${'d'.repeat(64)}.0`] } }, moves: false },
      { label: 'final balances', record: { final: { usdc: '0', eth_wei: '0', bsv_sats: '0' } }, moves: false },
      { label: 'a pending withdrawal to the pinned address since startedAt', record: {}, intent: { to: DEST_BASE, createdAtMs: 1000 }, moves: false },
      { label: 'a done withdrawal to the pinned address since startedAt', record: {}, intent: { to: DEST_BASE.toLowerCase(), createdAtMs: 5000, done: true }, moves: false },
    ]
    for (const { label, record, intent, moves } of cases) {
      const paths = home()
      writeCloseFile(paths, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV, startedAt: 1000, sends: [], ...record })
      if (intent) {
        const hash = `0x${'e'.repeat(64)}`
        writeWithdrawalIntent(paths, hash, 'USDC', intent.to, { createdAtMs: intent.createdAtMs })
        if (intent.done) resolveWithdrawalIntent(paths, hash, 'not-sent')
      }
      const state: FakeState = { usdc: ONE_USDC, eth: 0n, claimedBsvSats: 0n, swaps: [] }
      const { kit, calls } = fakeKit(paths, state)
      const result = await closeKitStep({ kit, paths }, { baseAddress: OTHER_BASE, bsvAddress: OTHER_BSV })
      if (moves) {
        expect(result.state, label).eq('in_progress')
        expect(calls.withdrawBase, label).deep.eq([{ asset: 'USDC', amount: 'all' }])
        expect([readCloseFile(paths).baseAddress, readCloseFile(paths).bsvAddress], label).deep.eq([OTHER_BASE, OTHER_BSV])
      } else {
        expect(result.state === 'refused' && result.reason, label).eq(pinnedText(DEST_BASE, DEST_BSV))
        expect(calls.withdrawBase, label).deep.eq([])
      }
    }
  })

  it('T4 a BSV pair mismatch refuses, naming the pinned pair', async () => {
    const paths = home()
    const state: FakeState = { usdc: ONE_USDC, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit, calls } = fakeKit(paths, state)
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('in_progress')
    const other = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: OTHER_BSV })
    expect(other.state === 'refused' && other.reason).eq(pinnedText(DEST_BASE, DEST_BSV))
    expect(other.sent.map((s) => s.asset)).deep.eq(['USDC'])
    expect(calls.withdrawBase).to.have.lengthOf(1)
  })

  it('T4 (P-G) the EIP-55 and lower-case forms of one Base address are the same pin; a different address is refused', async () => {
    const paths = home()
    const checksummed = getAddress(`0x${'ab'.repeat(20)}`)
    const other = getAddress(`0x${'cd'.repeat(20)}`)
    const ownChecksummed = getAddress(`0x${'ef'.repeat(20)}`)
    const state: FakeState = { usdc: ONE_USDC, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state, { walletInfo: async () => ({ ...walletInfoOf(state), baseAddress: ownChecksummed }) })
    expect((await closeKitStep({ kit, paths }, { baseAddress: checksummed, bsvAddress: DEST_BSV })).state).eq('in_progress')
    const lower = await closeKitStep({ kit, paths }, { baseAddress: checksummed.toLowerCase(), bsvAddress: DEST_BSV })
    expect(lower.state, 'the lower-case form is the same pin').eq('in_progress')
    const different = await closeKitStep({ kit, paths }, { baseAddress: other, bsvAddress: DEST_BSV })
    expect(different.state === 'refused' && different.reason).eq(pinnedText(checksummed, DEST_BSV))
    const own = await closeKitStep({ kit, paths }, { baseAddress: ownChecksummed.toLowerCase(), bsvAddress: DEST_BSV })
    expect(own.state === 'refused' && own.reason).eq("base_address must not be this kit's own Base address")
  })

  it("N3 validation refusals report the record's sends", async () => {
    const paths = home()
    const send = { asset: 'USDC', amount: '1', to: DEST_BASE, txid: `0x${'a'.repeat(64)}` }
    writeCloseFile(paths, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV, startedAt: 1, sends: [send] })
    const state: FakeState = { usdc: ONE_USDC, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state, { assertWithdrawDestinations: async (to) => { if (to.base === OTHER_BASE) throw new Error('cannot withdraw to a swap or token contract') } })
    for (const request of [{ baseAddress: NON_CHECKSUMMED_BASE, bsvAddress: DEST_BSV }, { baseAddress: DEST_BASE, bsvAddress: OWN_BSV }, { baseAddress: OTHER_BASE, bsvAddress: DEST_BSV }]) {
      const result = await closeKitStep({ kit, paths }, request)
      expect(result.state, request.baseAddress).eq('refused')
      expect(result.sent, request.baseAddress).deep.eq([send])
    }
  })

  it('N4 a close.json with a bad closedAt, final, send or saved sweep (the one sweep shape check) refuses with the inspect text and sends nothing', async () => {
    const base = { baseAddress: DEST_BASE, bsvAddress: DEST_BSV, startedAt: 1, sends: [] }
    const bad: Array<Record<string, unknown>> = [
      { ...base, closedAt: '12345' }, { ...base, closedAt: -1 }, { ...base, closedAt: 1.5 },
      // A value Date cannot format (above the largest valid Date, 8_640_000_000_000_000ms) is refused the same way,
      // for either field: close.ts formats closedAt with new Date(...).toISOString().
      { ...base, startedAt: Number.MAX_SAFE_INTEGER }, { ...base, closedAt: Number.MAX_SAFE_INTEGER },
      { ...base, final: { usdc: 0, eth_wei: '0', bsv_sats: '0' } }, { ...base, final: { usdc: '0', eth_wei: '01', bsv_sats: '0' } }, { ...base, final: { usdc: '0', eth_wei: '0' } },
      { ...base, sends: [{ asset: 'DOGE', amount: '1', to: DEST_BASE, txid: 'x' }] }, { ...base, sends: [{ asset: 'USDC', amount: 1, to: DEST_BASE, txid: 'x' }] },
      { ...base, bsvOutbox: { txid: 7, sats: '1', inputs: [] } }, { ...base, bsvOutbox: { txid: 'x', sats: '1', inputs: [7] } },
      ...BAD_SWEEPS.map((bsvOutbox) => ({ ...base, bsvOutbox })),
    ]
    for (const record of bad) {
      const paths = home()
      writeCloseFile(paths, record)
      const { kit, calls } = fakeKit(paths, { usdc: ONE_USDC, eth: 1n, claimedBsvSats: 5000n, swaps: [] })
      const result = await closeKitStep({ kit, paths }, PAIR)
      const label = JSON.stringify(record)
      expect(result.state === 'refused' && result.reason, label).eq(`close.json in ${paths.home} cannot be read (close.json has invalid contents). Nothing was sent. Inspect close.json: it holds this close-down's two addresses and its sends so far. Repair it, then call close_kit again.`)
      expect(calls.withdrawBase, label).deep.eq([])
      expect(calls.withdrawBsv, label).eq(0)
    }
  })

  it("m2 a hand-written STOP with at = Number.MAX_SAFE_INTEGER refuses close with STOP's own unreadable-STOP text: nothing is sent and close.json is not written", async () => {
    const paths = home()
    writeFileSync(paths.stopPath, JSON.stringify({ at: Number.MAX_SAFE_INTEGER, reason: 'pause' }))
    chmodSync(paths.stopPath, 0o600)
    const { kit, calls } = fakeKit(paths, { usdc: ONE_USDC, eth: 0n, claimedBsvSats: 0n, swaps: [] })
    const result = await closeKitStep({ kit, paths }, PAIR)
    expect(result.state).eq('refused')
    if (result.state === 'refused') {
      expect(result.reason).eq('spending is stopped; fix STOP at the terminal (STOP has invalid contents)')
      expect(result.retry_after_seconds).eq(undefined)
    }
    expect(result.sent).deep.eq([])
    expect(existsSync(join(paths.home, 'close.json'))).eq(false)
    expect(calls.withdrawBase).deep.eq([])
  })

  it('S4 (P-E) a stop written by another tool while the empty check runs still ends closed, and the next call is closed too', async () => {
    const paths = home()
    let reads = 0
    const state: FakeState = { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state, {
      walletInfo: async () => { reads++; if (reads === 2) stopSpending(paths, 'user asked to stop', 42); return walletInfoOf(state) },
    })
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('closed')
    expect(readSpendingStop(paths)?.reason).eq('user asked to stop')
    expect(readCloseFile(paths).closedAt).to.be.a('number')
    const again = await closeKitStep({ kit, paths }, PAIR)
    expect(again.state).eq('closed')
  })

  it("S4 final plus the user's own STOP is closed, not 'spending is stopped'; with no final it is still refused", async () => {
    const send = { asset: 'USDC', amount: '1', to: DEST_BASE, txid: `0x${'a'.repeat(64)}` }
    {
      const paths = home()
      writeCloseFile(paths, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV, startedAt: 1, sends: [send], final: { usdc: '0', eth_wei: '0', bsv_sats: '0' }, closedAt: 77 })
      stopSpending(paths, 'user asked to stop', 99)
      const { kit } = fakeKit(paths, { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] })
      const result = await closeKitStep({ kit, paths }, PAIR)
      expect(result.state).eq('closed')
      if (result.state === 'closed') expect([result.closed_at, result.sent]).deep.eq([new Date(77).toISOString(), [send]])
    }
    {
      const paths = home()
      writeCloseFile(paths, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV, startedAt: 1, sends: [send] })
      stopSpending(paths, 'user asked to stop', 99)
      const { kit } = fakeKit(paths, { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] })
      const result = await closeKitStep({ kit, paths }, PAIR)
      expect(result.state === 'refused' && result.reason).eq('spending is stopped; run `npx petasats-mcp resume` in a terminal, then close_kit again')
    }
  })

  it('S5 (P-F) died between (2) and (3), then funds arrive: the refusal fills in closedAt, so after resume a new pair goes ahead', async () => {
    const paths = home()
    const send = { asset: 'USDC', amount: '9', to: DEST_BASE, txid: `0x${'a'.repeat(64)}` }
    writeCloseFile(paths, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV, startedAt: 1, sends: [send], final: { usdc: '0', eth_wei: '0', bsv_sats: '0' } })
    stopSpending(paths, CLOSED_STOP_REASON, 12345)
    const state: FakeState = { usdc: 7n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state)
    const funds = await closeKitStep({ kit, paths }, PAIR)
    expect(funds.state === 'refused' && funds.reason).eq('funds arrived after this kit was closed; run `npx petasats-mcp resume` in a terminal, then close_kit again')
    expect(readCloseFile(paths).closedAt).eq(12345)
    resumeSpending(paths)
    const fresh = await closeKitStep({ kit, paths }, { baseAddress: OTHER_BASE, bsvAddress: DEST_BSV })
    expect(fresh.state).eq('in_progress')
    expect(existsSync(join(paths.home, 'close-12345.json'))).eq(true)
    expect(readCloseFile(paths).baseAddress).eq(OTHER_BASE)
  })
})
