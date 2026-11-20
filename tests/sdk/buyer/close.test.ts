import { expect } from 'chai'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { CLOSED_STOP_REASON, closeKitStep } from '../../../src/sdk/buyer/close'
import { readSpendingStop, resumeSpending, stopSpending } from '../../../src/sdk/buyer/stop'
import type { BuyerSwapRecord } from '../../../src/sdk/buyer/types'
import { listBuyerWithdrawalIntents } from '../../../src/sdk/buyer/withdrawal-intent'
import {
  DEST_BASE, DEST_BSV, NON_CHECKSUMMED_BASE, NON_P2PKH_BSV, OTHER_BASE, OWN_BASE, OWN_BSV, ZERO_BASE,
  coin, fakeKit, gasDust, home, resolveWithdrawalIntent, row, runtimeKit, writeCloseFile, writeWithdrawalIntent, type FakeState,
} from './close-helpers'

describe('buyer kit close-down', () => {
  it('F1 a swap that is not finished refuses, naming the swap and stage, for every blocking stage', async () => {
    const finished = [row('d', 'delivered'), row('r', 'refunded'), row('x', 'failed'), row('f', 'settled')]
    const blockingCases: Array<[string, Partial<BuyerSwapRecord>]> = [
      ['quoted', {}], ['admitted', {}], ['usdc_locked', {}], ['waiting_bsv_lock', {}], ['bsv_lock_confirming', {}],
      ['claiming', {}], ['claimed', {}], ['settled', { deliverTo: DEST_BSV }], ['sweeping', {}], ['refund_waiting', {}],
      ['needs_attention', {}], ['some_unknown_future_stage', {}],
    ]
    for (const [stage, more] of blockingCases) {
      const paths = home()
      const state: FakeState = { usdc: 1_000_000n, eth: 1n, claimedBsvSats: 0n, swaps: [...finished, row('s', stage, more)] }
      const { kit, calls } = fakeKit(paths, state)
      const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
      expect(result.state, stage).eq('refused')
      if (result.state === 'refused') {
        expect(result.reason, stage).contains(`swap ${'s'.repeat(32)} is not finished yet (stage ${stage})`)
        expect(result.retry_after_seconds, stage).eq(300)
      }
      expect(calls.withdrawBase, stage).deep.eq([])
      expect(calls.withdrawBsv, stage).eq(0)
    }
  })

  it('F1b a needs_attention row with a reason includes it in the refusal', async () => {
    const paths = home()
    const state: FakeState = { usdc: 1_000_000n, eth: 1n, claimedBsvSats: 0n, swaps: [row('s', 'needs_attention', { reason: 'check the BSV claim' })] }
    const { kit, calls } = fakeKit(paths, state)
    const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(result.state).eq('refused')
    if (result.state === 'refused') expect(result.reason).contains(': check the BSV claim')
    expect(calls.withdrawBase).deep.eq([])
    expect(calls.withdrawBsv).eq(0)
  })

  it('F2 spending stopped for another reason refuses and calls no withdraw', async () => {
    const paths = home()
    stopSpending(paths, 'manual pause', 1)
    const state: FakeState = { usdc: 1_000_000n, eth: 1n, claimedBsvSats: 0n, swaps: [] }
    const { kit, calls } = fakeKit(paths, state)
    const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(result.state).eq('refused')
    if (result.state === 'refused') {
      expect(result.reason).match(/spending is stopped/)
      expect(result.reason).match(/npx petasats-mcp resume/)
    }
    expect(calls.withdrawBase).deep.eq([])
    expect(calls.withdrawBsv).eq(0)
  })

  it('F3 every invalid-address case refuses before any kit call that could send', async () => {
    const cases: Array<{ label: string; baseAddress: string; bsvAddress: string }> = [
      { label: 'non-checksummed base', baseAddress: NON_CHECKSUMMED_BASE, bsvAddress: DEST_BSV },
      { label: 'zero base', baseAddress: ZERO_BASE, bsvAddress: DEST_BSV },
      { label: 'non-P2PKH bsv', baseAddress: DEST_BASE, bsvAddress: NON_P2PKH_BSV },
      { label: "kit's own base", baseAddress: OWN_BASE, bsvAddress: DEST_BSV },
      { label: "kit's own bsv", baseAddress: DEST_BASE, bsvAddress: OWN_BSV },
    ]
    for (const { label, baseAddress, bsvAddress } of cases) {
      const paths = home()
      const state: FakeState = { usdc: 1_000_000n, eth: 1n, claimedBsvSats: 0n, swaps: [] }
      const { kit, calls } = fakeKit(paths, state)
      const result = await closeKitStep({ kit, paths }, { baseAddress, bsvAddress })
      expect(result.state, label).eq('refused')
      expect(calls.withdrawBase, label).deep.eq([])
      expect(calls.withdrawBsv, label).eq(0)
    }
  })

  it('F4 a close record pinned to different addresses refuses and names them', async () => {
    const paths = home()
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit: firstKit } = fakeKit(paths, state)
    const first = await closeKitStep({ kit: firstKit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(first.state).eq('in_progress') // sends the USDC and pins close.json to DEST_BASE/DEST_BSV

    const { kit: secondKit, calls } = fakeKit(paths, state)
    const result = await closeKitStep({ kit: secondKit, paths }, { baseAddress: OTHER_BASE, bsvAddress: DEST_BSV })
    expect(result.state).eq('refused')
    if (result.state === 'refused') {
      expect(result.reason).eq(`this kit's close-down goes to base ${DEST_BASE} and BSV ${DEST_BSV} and can only finish to that pair; call close_kit again with those two addresses`)
      expect(result.retry_after_seconds).eq(undefined)
      expect(result.sent.map((s) => s.asset)).deep.eq(['USDC'])
    }
    expect(calls.withdrawBase).deep.eq([])
  })

  it('F4b a withdrawBase throw that leaves a pending intent still pins the pair, refusing a later different pair', async () => {
    const paths = home()
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    // The kit's withdrawBase writes a pending intent (as the real one does on a successful broadcast) and then
    // throws (unknown broadcast outcome, receipt timeout): the pair must already be pinned by that point.
    const { kit: firstKit } = fakeKit(paths, state, {
      withdrawBase: async (request) => {
        writeWithdrawalIntent(paths, `0x${'e'.repeat(64)}`, request.asset, request.to)
        throw new Error('receipt lookup timed out; the broadcast outcome is unknown')
      },
    })
    const first = await closeKitStep({ kit: firstKit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(first.state).eq('in_progress') // item 3: a throw that left a pending intent is progress, not a refusal.

    const closeRecord = JSON.parse(readFileSync(join(paths.home, 'close.json'), 'utf8'))
    expect(closeRecord.baseAddress).eq(DEST_BASE)
    expect(closeRecord.bsvAddress).eq(DEST_BSV)

    const { kit: secondKit, calls } = fakeKit(paths, state)
    const result = await closeKitStep({ kit: secondKit, paths }, { baseAddress: OTHER_BASE, bsvAddress: DEST_BSV })
    expect(result.state).eq('refused')
    if (result.state === 'refused') expect(result.reason).contains(DEST_BASE)
    expect(calls.withdrawBase).deep.eq([])
    expect(calls.withdrawBsv).eq(0)
  })

  it('F5 reconcile is called once per call and withdrawBase is never called, for each of the three outcomes', async () => {
    // No reconcileWithdrawals capability at all: the original wait text, unchanged.
    {
      const paths = home()
      writeWithdrawalIntent(paths, `0x${'c'.repeat(64)}`, 'USDC', DEST_BASE)
      const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
      const { kit, calls } = fakeKit(paths, state)
      const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
      expect(result.state).eq('in_progress')
      if (result.state === 'in_progress') expect(result.call_again_after_seconds).eq(30)
      expect(calls.withdrawBase).deep.eq([])
    }
    // reconcileWithdrawals returns an outcome (non-success status, so nothing is appended to sent).
    {
      const paths = home()
      writeWithdrawalIntent(paths, `0x${'c'.repeat(64)}`, 'USDC', DEST_BASE)
      const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
      const { kit, calls } = fakeKit(paths, state, {
        reconcileWithdrawals: async () => ({ hash: `0x${'c'.repeat(64)}`, asset: 'USDC', to: DEST_BASE, amount: '1000000', status: 'reverted' }),
      })
      const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
      expect(result.state).eq('in_progress')
      if (result.state === 'in_progress') {
        expect(result.did).match(/is final \(reverted\)/)
        expect(result.call_again_after_seconds).eq(5)
        expect(result.sent).deep.eq([])
      }
      expect(calls.reconcileWithdrawals).eq(1)
      expect(calls.withdrawBase).deep.eq([])
    }
    // reconcileWithdrawals returns undefined: the current wait text, 30 s.
    {
      const paths = home()
      writeWithdrawalIntent(paths, `0x${'c'.repeat(64)}`, 'USDC', DEST_BASE)
      const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
      const { kit, calls } = fakeKit(paths, state, { reconcileWithdrawals: async () => undefined })
      const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
      expect(result.state).eq('in_progress')
      if (result.state === 'in_progress') expect(result.call_again_after_seconds).eq(30)
      expect(calls.reconcileWithdrawals).eq(1)
      expect(calls.withdrawBase).deep.eq([])
    }
    // reconcileWithdrawals throws: in_progress naming the kit's message, 60 s.
    {
      const paths = home()
      writeWithdrawalIntent(paths, `0x${'c'.repeat(64)}`, 'USDC', DEST_BASE)
      const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
      const { kit, calls } = fakeKit(paths, state, {
        reconcileWithdrawals: async () => { throw new Error('the Base RPC endpoints disagree; nothing new was sent') },
      })
      const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
      expect(result.state).eq('in_progress')
      if (result.state === 'in_progress') {
        expect(result.did).eq('nothing new sent; the Base RPC endpoints disagree; nothing new was sent')
        expect(result.call_again_after_seconds).eq(60)
      }
      expect(calls.reconcileWithdrawals).eq(1)
      expect(calls.withdrawBase).deep.eq([])
    }
  })

  it('F5b a close-down send that resolves through reconcile appears in sent exactly once across repeated calls', async () => {
    const paths = home()
    const hash = `0x${'c'.repeat(64)}`
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state, {
      // Signed and recorded after the pair was pinned, then its receipt timed out.
      withdrawBase: async (request) => { writeWithdrawalIntent(paths, hash, request.asset, request.to, { amount: '1000000' }); throw new Error('receipt timed out') },
      // Like the real reconcile, it marks the record done before it reports the outcome.
      reconcileWithdrawals: async () => { resolveWithdrawalIntent(paths, hash); state.usdc = 0n; return { hash, asset: 'USDC', to: DEST_BASE, amount: '1000000', status: 'success' } },
    })
    const send = { asset: 'USDC', amount: '1000000', to: DEST_BASE, txid: hash }

    expect((await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })).state).eq('in_progress')
    const second = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(second.state).eq('in_progress')
    if (second.state === 'in_progress') expect(second.sent).deep.eq([send])
    const third = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(third.state).eq('closed')
    if (third.state === 'closed') expect(third.sent).deep.eq([send])
  })

  it('F6 USDC still showing while its withdrawal is unresolved never sends a second time', async () => {
    const paths = home()
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit, calls } = fakeKit(paths, state)
    const first = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(first.state).eq('in_progress')
    expect(calls.withdrawBase).deep.eq([{ asset: 'USDC', amount: 'all' }])
    // state.usdc is untouched (as if the balance read has not caught up yet); the send just made left an
    // unresolved withdrawal-intent record, exactly like the real withdrawBase would.
    const second = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(second.state).eq('in_progress')
    expect(calls.withdrawBase).deep.eq([{ asset: 'USDC', amount: 'all' }])
  })

  it('F7 ETH dust that cannot pay its own gas is recorded and the kit closes', async () => {
    const paths = home()
    const state: FakeState = { usdc: 0n, eth: 1n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state, { withdrawBase: async () => { throw gasDust(state.eth) } })
    const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(result.state).eq('closed')
    if (result.state === 'closed') {
      expect(result.final).deep.eq({ usdc: '0', eth_wei: '1', bsv_sats: '0' })
      expect(result.sent).deep.eq([])
    }
  })

  it('F8 unconfirmed BSV waits; dust-small BSV is recorded and the close continues in the same call', async () => {
    {
      // The real kit and runtime: an unconfirmed coin at the kit address (a deposit, or a claim the indexer has not
      // seen confirm) is reported by walletInfo from the same coin list the sweep reads. Nothing is sent or stopped.
      const paths = home()
      const rails = { coins: [coin('a', 700_000, 0)] }
      const { kit, events } = await runtimeKit(paths, rails)
      const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
      expect(result.state).eq('in_progress')
      if (result.state === 'in_progress') {
        expect(result.did).eq('nothing sent; 700000 sats of BSV are not confirmed yet; they will be sent after they confirm')
        expect(result.call_again_after_seconds).eq(60)
      }
      expect(events.filter((event) => !event.startsWith('unspent'))).deep.eq([])
      expect(readSpendingStop(paths)).eq(undefined)
      // Once it confirms, the next call sweeps it.
      rails.coins[0] = coin('a', 700_000, 1)
      const next = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
      expect(next.state).eq('in_progress')
      if (next.state === 'in_progress') expect(next.sent.map((s) => [s.asset, s.amount, s.to])).deep.eq([['BSV', '699900', DEST_BSV]])
    }
    {
      // Thrown dust error: too small to send; the close carries on to the empty check in the same call.
      const paths = home()
      const state: FakeState = { usdc: 0n, eth: 0n, claimedBsvSats: 50n, swaps: [] }
      const { kit } = fakeKit(paths, state, { withdrawBsv: async () => { throw new Error('buyer sweep: output 50 sat is at or below dust (135)') } })
      const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
      expect(result.state).eq('closed')
      if (result.state === 'closed') expect(result.final).deep.eq({ usdc: '0', eth_wei: '0', bsv_sats: '50' })
    }
  })

  it('F9 a kit method throw refuses with its message and keeps earlier sends in the report', async () => {
    const paths = home()
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 500_000n, swaps: [] }
    const { kit } = fakeKit(paths, state)
    const first = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(first.state).eq('in_progress')
    state.usdc = 0n // the USDC send confirmed
    resolveWithdrawalIntent(paths, listBuyerWithdrawalIntents(paths)[0].hash)

    const { kit: failingKit } = fakeKit(paths, state, { withdrawBsv: async () => { throw new Error('refused by your limits file: bad; fix limits.json at the terminal; nothing was sent') } })
    const second = await closeKitStep({ kit: failingKit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(second.state).eq('refused')
    if (second.state === 'refused') {
      expect(second.reason).match(/refused by your limits file: bad/)
      expect(second.sent).to.have.lengthOf(1)
      expect(second.sent[0].asset).eq('USDC')
    }
  })

  it('F9b a withdrawBase throw that leaves a pending intent is in_progress, not refused', async () => {
    const paths = home()
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state, {
      withdrawBase: async (request) => {
        writeWithdrawalIntent(paths, `0x${'f'.repeat(64)}`, request.asset, request.to)
        throw new Error('RPC timed out')
      },
    })
    const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(result.state).eq('in_progress')
    if (result.state === 'in_progress') {
      expect(result.did).eq('the Base send is recorded but not confirmed: RPC timed out')
      expect(result.next).eq('call again; the kit confirms or re-sends it')
      expect(result.call_again_after_seconds).eq(60)
    }
  })

  it('F10 a swap that starts between calls makes the next call refuse', async () => {
    const paths = home()
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state)
    const first = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(first.state).eq('in_progress')
    state.usdc = 0n
    resolveWithdrawalIntent(paths, listBuyerWithdrawalIntents(paths)[0].hash)
    state.swaps = [row('n', 'usdc_locked')]

    const second = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(second.state).eq('refused')
    if (second.state === 'refused') expect(second.reason).match(/is not finished yet/)
  })

  it('F11 new USDC arriving after the USDC step is sent on a later call; the report lists both sends', async () => {
    const paths = home()
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state)
    const first = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(first.state).eq('in_progress')
    resolveWithdrawalIntent(paths, listBuyerWithdrawalIntents(paths)[0].hash)
    state.usdc = 2_000_000n // the first USDC confirmed gone, then new USDC arrived

    const second = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(second.state).eq('in_progress')
    const unresolved = listBuyerWithdrawalIntents(paths).find((w) => w.state !== 'done')
    expect(unresolved, 'the second send also left an unresolved intent record').to.exist
    resolveWithdrawalIntent(paths, unresolved!.hash)
    state.usdc = 0n

    const third = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(third.state).eq('closed')
    if (third.state === 'closed') {
      expect(third.sent).to.have.lengthOf(2)
      expect(third.sent.every((s) => s.asset === 'USDC')).eq(true)
    }
  })

  it('F11b a failed empty check (something changed mid-step) is in_progress, not refused, and the next call carries on', async () => {
    const paths = home()
    const state: FakeState = { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    let walletInfoCalls = 0
    // Reports empty on the first read of each call (section a) but, from the second read onward (section g's
    // fresh check), as if BSV had just arrived mid-step; it mutates the shared state so the default
    // withdrawBsv (used on the next call) agrees with what walletInfo reported.
    const { kit } = fakeKit(paths, state, {
      walletInfo: async () => {
        walletInfoCalls++
        if (walletInfoCalls > 1) state.claimedBsvSats = 777n
        return { baseAddress: OWN_BASE, bsvAddress: OWN_BSV, usdc: state.usdc, eth: state.eth, claimedBsvSats: state.claimedBsvSats, unconfirmedBsvSats: 0n, capUsdPerSwap: 100 }
      },
    })

    const first = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(first.state).eq('in_progress')
    if (first.state === 'in_progress') {
      expect(first.did).eq('nothing sent; a balance or swap changed during this step')
      expect(first.next).eq('call again')
      expect(first.call_again_after_seconds).eq(30)
    }

    const second = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(second.state).eq('in_progress') // carries on: claimedBsvSats now reads stably as 777n, so it gets swept.
    if (second.state === 'in_progress') expect(second.did).match(/sent the confirmed BSV/)
  })

  it('F12 a repeat call after closed sends nothing; funds arriving after the close refuse with the resume instruction', async () => {
    const paths = home()
    const state: FakeState = { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit, calls } = fakeKit(paths, state)
    const closedResult = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(closedResult.state).eq('closed')

    const repeat = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(repeat.state).eq('closed')
    expect(calls.withdrawBase).deep.eq([])
    expect(calls.withdrawBsv).eq(0)

    state.usdc = 1_000n // funds arrive after the close
    const afterFunds = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(afterFunds.state).eq('refused')
    if (afterFunds.state === 'refused') {
      expect(afterFunds.reason).match(/funds arrived after this kit was closed/)
      expect(afterFunds.reason).match(/npx petasats-mcp resume/)
    }
    expect(calls.withdrawBase).deep.eq([])
  })

  it('F12b after resume, a finished close-down is archived and a new close-down may use a different pair', async () => {
    const paths = home()
    const state: FakeState = { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state)
    const closed = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(closed.state).eq('closed')
    if (closed.state !== 'closed') throw new Error('unreachable')
    const closedAtMs = new Date(closed.closed_at).getTime()

    resumeSpending(paths)
    state.usdc = 500_000n // give the new close-down something to send, to prove it actually goes ahead

    const result = await closeKitStep({ kit, paths }, { baseAddress: OTHER_BASE, bsvAddress: DEST_BSV })
    expect(result.state).eq('in_progress') // goes ahead to a different pair instead of refusing

    const archivePath = join(paths.home, `close-${closedAtMs}.json`)
    expect(existsSync(archivePath), 'the old record is archived under its closedAt').eq(true)
    const archived = JSON.parse(readFileSync(archivePath, 'utf8'))
    expect(archived.baseAddress).eq(DEST_BASE)
    expect(archived.bsvAddress).eq(DEST_BSV)

    const current = JSON.parse(readFileSync(join(paths.home, 'close.json'), 'utf8'))
    expect(current.baseAddress).eq(OTHER_BASE)
  })

  it('F13 two concurrent calls on the same kit perform exactly one send between them', async () => {
    const paths = home()
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    // Like the real kit, the withdrawal record is written only after signing, after an await: without the close
    // lock, the second call would find no record yet and send again.
    let sends = 0
    const { kit, calls } = fakeKit(paths, state, {
      withdrawBase: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        sends++
        const hash = `0x${sends.toString().padStart(64, '0')}`
        writeWithdrawalIntent(paths, hash, request.asset, request.to)
        return { asset: request.asset, amount: state.usdc, to: request.to, txid: hash, status: 'success' }
      },
    })
    const [a, b] = await Promise.all([
      closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV }),
      closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV }),
    ])
    expect(calls.withdrawBase).to.have.lengthOf(1)
    expect(a.state).eq('in_progress')
    expect(b.state).eq('in_progress')
  })

  it('F14 the STOP write happens only after the empty check, once nothing more needs to send', async () => {
    const paths = home()
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 50_000n, swaps: [] }
    const { kit, calls } = fakeKit(paths, state)

    const first = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(first.state).eq('in_progress')
    expect(readSpendingStop(paths), 'no STOP while a send might still be needed').eq(undefined)

    resolveWithdrawalIntent(paths, listBuyerWithdrawalIntents(paths)[0].hash)
    state.usdc = 0n
    const second = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(second.state).eq('in_progress')
    expect(calls.withdrawBsv, 'the BSV send happens with no STOP in the way').eq(1)
    expect(readSpendingStop(paths), 'no STOP while the BSV send was still to make').eq(undefined)

    state.claimedBsvSats = 0n
    const third = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(third.state).eq('closed')
    expect(readSpendingStop(paths)?.reason, 'STOP appears only once the kit reports closed').eq(CLOSED_STOP_REASON)

    // BSV arriving after the STOP is never swept by close_kit: the call refuses with the resume instruction.
    state.claimedBsvSats = 50_000n
    const fourth = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(fourth.state).eq('refused')
    if (fourth.state === 'refused') expect(fourth.reason).match(/^funds arrived after this kit was closed/)
    expect(calls.withdrawBsv).eq(1)
  })

  it('F18a died after (1): no closedAt and no STOP is not archived, closes, and keeps every earlier send', async () => {
    const paths = home()
    const state: FakeState = { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit, calls } = fakeKit(paths, state)
    const earlierSend = { asset: 'USDC', amount: '1000000', to: DEST_BASE, txid: `0x${'a'.repeat(64)}` }
    const record = { baseAddress: DEST_BASE, bsvAddress: DEST_BSV, startedAt: 1, sends: [earlierSend], final: { usdc: '0', eth_wei: '0', bsv_sats: '0' } }
    writeCloseFile(paths, record)

    const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(result.state).eq('closed')
    if (result.state === 'closed') expect(result.sent).deep.eq([earlierSend])
    expect(readdirSync(paths.home).filter((f) => f.startsWith('close-')), 'no archive was created').deep.eq([])
    expect(calls.withdrawBase).deep.eq([])
    expect(calls.withdrawBsv).eq(0)
  })

  it("F18b died after (2): STOP with the closed reason and no closedAt finishes the write using the stop's at", async () => {
    const paths = home()
    const state: FakeState = { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit, calls } = fakeKit(paths, state)
    const earlierSend = { asset: 'USDC', amount: '1000000', to: DEST_BASE, txid: `0x${'a'.repeat(64)}` }
    const record = { baseAddress: DEST_BASE, bsvAddress: DEST_BSV, startedAt: 1, sends: [earlierSend], final: { usdc: '0', eth_wei: '0', bsv_sats: '0' } }
    const file = writeCloseFile(paths, record)
    stopSpending(paths, CLOSED_STOP_REASON, 12345)

    const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(result.state).eq('closed')
    if (result.state === 'closed') {
      expect(result.sent).deep.eq([earlierSend])
      expect(result.closed_at).eq(new Date(12345).toISOString())
    }
    expect(calls.withdrawBase).deep.eq([])
    expect(calls.withdrawBsv).eq(0)

    const current = JSON.parse(readFileSync(file, 'utf8'))
    expect(current.closedAt).eq(12345)
  })

  it('F18c STOP with the closed reason and no final refuses with the resume instruction', async () => {
    const paths = home()
    const state: FakeState = { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit, calls } = fakeKit(paths, state)
    writeCloseFile(paths, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV, startedAt: 1, sends: [] })
    stopSpending(paths, CLOSED_STOP_REASON, 12345)

    const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(result.state).eq('refused')
    if (result.state === 'refused') {
      expect(result.reason).match(/spending is stopped/)
      expect(result.reason).match(/npx petasats-mcp resume/)
    }
    expect(calls.withdrawBase).deep.eq([])
    expect(calls.withdrawBsv).eq(0)
  })

  it('F19 garbage in close.json refuses with an actionable message and sends nothing', async () => {
    const paths = home()
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit, calls } = fakeKit(paths, state)
    writeCloseFile(paths, 'not valid json{{{')

    const result = await closeKitStep({ kit, paths }, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV })
    expect(result.state).eq('refused')
    if (result.state === 'refused') {
      expect(result.reason).contains(`close.json in ${paths.home} cannot be read (`)
      expect(result.reason).contains("Nothing was sent. Inspect close.json: it holds this close-down's two addresses and its sends so far. Repair it, then call close_kit again.")
      expect(result.retry_after_seconds).eq(undefined)
      expect(result.sent).deep.eq([])
    }
    expect(calls.withdrawBase).deep.eq([])
    expect(calls.withdrawBsv).eq(0)
  })
})
