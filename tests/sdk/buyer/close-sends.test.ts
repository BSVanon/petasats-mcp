// The close-down report and its empty check: every send listed exactly once, dust judged on fresh balances,
// keys_note, and which refusals say when to try again.
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { expect } from 'chai'
import { createBuyerKit } from '../../../src/sdk/buyer/buyer-kit'
import { CLOSE_BSV_DUST_LIMIT_SATS, closeKitStep } from '../../../src/sdk/buyer/close'
import { readSpendingStop } from '../../../src/sdk/buyer/stop'
import type { BuyerKit } from '../../../src/sdk/buyer/types'
import { resolveBuyerWithdrawalIntent } from '../../../src/sdk/buyer/withdrawal-intent'
import {
  DEST_BASE, DEST_BSV, OTHER_BASE, OWN_BASE, OWN_BSV, PAIR, fakeKit, gasDust, home, readCloseFile, resolveWithdrawalIntent, walletInfoOf, writeCloseFile,
  writeWithdrawalIntent, type FakeState,
} from './close-helpers'

const ONE_ETH = 10n ** 18n
/**
 * The real createBuyerKit with only ETH. Each balance read takes the next value in `eth` (the last one repeats): in a
 * close step, walletInfo's first read, then withdrawBase's own read, then the fresh read. Pricing reserves 1000 wei, so
 * withdrawBase judges 1000 wei or less as gas dust.
 */
function ethKit(eth: bigint[]): { kit: BuyerKit; sent: string[] } {
  const sent: string[] = []
  let reads = 0
  const fail = (): Promise<never> => Promise.reject(new Error('not used'))
  const kit = createBuyerKit({}, {
    door: { quote: fail, admit: fail } as never,
    executor: { execute: async () => ({ ok: true }) } as never,
    store: { list: async () => [], get: async () => undefined, put: async () => undefined },
    wallet: {
      baseAddress: OWN_BASE, bsvAddress: OWN_BSV,
      balances: async () => ({ usdc: 0n, eth: eth[Math.min(reads++, eth.length - 1)], claimedBsvSats: 0n, unconfirmedBsvSats: 0n }),
      priceEthTransfer: async () => ({ gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, l1FeeWei: 1n, reserveWei: 1000n }),
      transferEth: async () => { sent.push('transferEth'); return { hash: hex64('7'), status: 'success', blockNumber: 1n } },
    } as never,
  })
  return { kit, sent }
}
const KEEP = 'Keep {keys} if anything might still be sent to these addresses: it is the only way to recover it. Deleting the folder is your choice. To use the kit again, run npx petasats-mcp resume.'
const hex64 = (c: string): string => `0x${c.repeat(64)}`

describe('buyer kit close-down: the report and the empty check', () => {
  it('S1 (P-B) a USDC send resolved at the terminal with `withdrawal <hash> sent` is listed', async () => {
    const paths = home()
    const hash = hex64('e')
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state, {
      withdrawBase: async (request) => { writeWithdrawalIntent(paths, hash, request.asset, request.to, { amount: '1000000', nonceConsumedAtBlock: '7' }); throw new Error('signed and recorded but its broadcast was not confirmed') },
      reconcileWithdrawals: async () => { throw new Error(`a previous Base withdrawal ${hash} used its nonce but its receipt was not found`) },
    })
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('in_progress')
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('in_progress')
    await resolveBuyerWithdrawalIntent(paths, hash, 'sent')
    state.usdc = 0n
    const closed = await closeKitStep({ kit, paths }, PAIR)
    expect(closed.state).eq('closed')
    expect(closed.sent).deep.eq([{ asset: 'USDC', amount: '1000000', to: DEST_BASE, txid: hash }])
  })

  it('S1 (P-B2) a withdrawal another tool reconciled first, or one whose append was lost in a crash, is listed once', async () => {
    const paths = home()
    const hash = hex64('f')
    const state: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state, {
      withdrawBase: async (request) => { writeWithdrawalIntent(paths, hash, request.asset, request.to, { amount: '1000000' }); throw new Error('receipt timed out') },
      reconcileWithdrawals: async () => undefined,
    })
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('in_progress')
    resolveWithdrawalIntent(paths, hash) // another money tool's reconcile marked it done
    state.usdc = 0n
    const closed = await closeKitStep({ kit, paths }, PAIR)
    expect(closed.state).eq('closed')
    expect(closed.sent).deep.eq([{ asset: 'USDC', amount: '1000000', to: DEST_BASE, txid: hash }])
    expect(readCloseFile(paths).sends).to.have.lengthOf(1)
  })

  it('S1 lists only withdrawals to the pinned address, made since startedAt, that resolved as sent', async () => {
    const paths = home()
    writeCloseFile(paths, { baseAddress: DEST_BASE, bsvAddress: DEST_BSV, startedAt: 5000, sends: [] })
    const cases: Array<[string, string, number, 'success' | 'sent' | 'reverted' | 'not-sent']> = [
      [hex64('1'), DEST_BASE, 4999, 'success'], // made before this close-down started
      [hex64('2'), OTHER_BASE, 6000, 'success'], // to another address
      [hex64('3'), DEST_BASE, 6000, 'reverted'],
      [hex64('4'), DEST_BASE, 6000, 'not-sent'],
      [hex64('5'), DEST_BASE, 7000, 'sent'],
      [hex64('6'), DEST_BASE, 5000, 'success'],
    ]
    for (const [hash, to, createdAtMs, status] of cases) {
      writeWithdrawalIntent(paths, hash, 'USDC', to, { createdAtMs })
      resolveWithdrawalIntent(paths, hash, status)
    }
    const { kit } = fakeKit(paths, { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] })
    const closed = await closeKitStep({ kit, paths }, PAIR)
    expect(closed.state).eq('closed')
    expect(closed.sent.map((s) => s.txid)).deep.eq([hex64('6'), hex64('5')])
  })

  it('S2 (R2) a BSV txid is listed once when the coin it spent still reads as unspent; a Base txid once in any letter case', async () => {
    const paths = home()
    const txid = 'ab'.repeat(32)
    const state: FakeState = { usdc: 0n, eth: 0n, claimedBsvSats: 50_000n, swaps: [] }
    const { kit, calls } = fakeKit(paths, state, { withdrawBsv: async () => ({ txid, sats: 49_900n }) })
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('in_progress')
    const second = await closeKitStep({ kit, paths }, PAIR)
    expect(calls.withdrawBsv).eq(2)
    expect(second.sent).deep.eq([{ asset: 'BSV', amount: '49900', to: DEST_BSV, txid }])
    // The same Base withdrawal, once listed by its send and once found by its record in another letter case.
    const basePaths = home()
    const hash = hex64('A')
    const baseState: FakeState = { usdc: 1_000_000n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit: baseKit } = fakeKit(basePaths, baseState, {
      withdrawBase: async (request) => { writeWithdrawalIntent(basePaths, hash.toLowerCase(), request.asset, request.to, { amount: '1000000' }); return { asset: 'USDC', amount: 1_000_000n, to: request.to, txid: hash, status: 'success' } },
    })
    expect((await closeKitStep({ kit: baseKit, paths: basePaths }, PAIR)).state).eq('in_progress')
    resolveWithdrawalIntent(basePaths, hash)
    baseState.usdc = 0n
    const closed = await closeKitStep({ kit: baseKit, paths: basePaths }, PAIR)
    expect(closed.sent.map((s) => s.txid)).deep.eq([hash])
  })

  it('M3 (P-D) a BSV dust flag does not cover a fresh balance at the dust limit or above', async () => {
    const paths = home()
    let reads = 0
    const state: FakeState = { usdc: 0n, eth: 0n, claimedBsvSats: 300n, swaps: [] }
    const { kit } = fakeKit(paths, state, {
      walletInfo: async () => { reads++; if (reads === 2) state.claimedBsvSats = 1_000_300n; return walletInfoOf(state) },
      withdrawBsv: async () => {
        if (state.claimedBsvSats < CLOSE_BSV_DUST_LIMIT_SATS) throw new Error(`buyer sweep: output ${state.claimedBsvSats - 96n} sat is at or below dust (546)`)
        const sats = state.claimedBsvSats - 96n
        state.claimedBsvSats = 0n
        return { txid: 'cd'.repeat(32), sats }
      },
    })
    const first = await closeKitStep({ kit, paths }, PAIR)
    expect(first.state === 'in_progress' && first.did).eq('nothing sent; a balance or swap changed during this step')
    expect(readSpendingStop(paths), 'no STOP').eq(undefined)
    const second = await closeKitStep({ kit, paths }, PAIR)
    expect(second.state === 'in_progress' && second.did).eq(`sent the confirmed BSV to ${DEST_BSV}`)
    const closed = await closeKitStep({ kit, paths }, PAIR)
    expect(closed.state).eq('closed')
    if (closed.state === 'closed') expect(closed.final.bsv_sats).eq('0')
  })

  it('M3 (P-D2) an ETH gas-dust flag does not cover more ETH than this call judged dust', async () => {
    const paths = home()
    let reads = 0
    const state: FakeState = { usdc: 0n, eth: 5n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state, {
      walletInfo: async () => { reads++; if (reads === 2) state.eth = ONE_ETH; return walletInfoOf(state) },
      withdrawBase: async () => { throw gasDust(state.eth) },
    })
    const first = await closeKitStep({ kit, paths }, PAIR)
    expect(first.state).eq('in_progress')
    expect(readSpendingStop(paths)).eq(undefined)
    // Gas dust that does not grow during the call is left behind.
    const dust = home()
    const dustState: FakeState = { usdc: 0n, eth: 5n, claimedBsvSats: 0n, swaps: [] }
    const { kit: dustKit } = fakeKit(dust, dustState, { withdrawBase: async () => { throw gasDust(dustState.eth) } })
    const closed = await closeKitStep({ kit: dustKit, paths: dust }, PAIR)
    expect(closed.state === 'closed' && closed.final.eth_wei).eq('5')
  })

  it('m2 ETH that withdrawBase judged gas dust at d does not cover a deposit X the first and fresh reads both see', async () => {
    const paths = home()
    const { kit, sent } = ethKit([ONE_ETH, 600n, ONE_ETH])
    const step = await closeKitStep({ kit, paths }, PAIR)
    expect(step.state === 'in_progress' && step.did).eq('nothing sent; a balance or swap changed during this step')
    expect(sent).deep.eq([])
    expect(readSpendingStop(paths), 'no STOP').eq(undefined)
  })

  it('m2 a fresh read at most the balance withdrawBase judged gas dust closes, and final.eth_wei is the fresh read', async () => {
    for (const fresh of [600n, 400n]) {
      const paths = home()
      const { kit, sent } = ethKit([ONE_ETH, 600n, fresh])
      const closed = await closeKitStep({ kit, paths }, PAIR)
      expect(closed.state === 'closed' && closed.final.eth_wei, String(fresh)).eq(String(fresh))
      expect(sent).deep.eq([])
    }
  })

  it('m2 a gas-dust refusal that does not carry the judged balance is not dust: nothing is sent and the step does not close', async () => {
    const paths = home()
    const state: FakeState = { usdc: 0n, eth: 5n, claimedBsvSats: 0n, swaps: [] }
    const { kit, calls } = fakeKit(paths, state, { withdrawBase: async () => { throw new Error('the ETH balance does not cover the Base gas for a withdrawal; nothing was sent') } })
    const step = await closeKitStep({ kit, paths }, PAIR)
    expect(step.state === 'in_progress' && step.did).eq('nothing sent; a balance or swap changed during this step')
    expect(step.sent).deep.eq([])
    expect(calls.withdrawBase).deep.eq([{ asset: 'ETH', amount: 'all' }])
    expect(readSpendingStop(paths), 'no STOP').eq(undefined)
    expect(readCloseFile(paths).final, 'no final').eq(undefined)
  })

  it("M3 a closed kit's re-check uses the same dust limits: BSV below the limit, ETH no more than was left", async () => {
    const paths = home()
    const state: FakeState = { usdc: 0n, eth: 5n, claimedBsvSats: 300n, swaps: [] }
    const { kit } = fakeKit(paths, state, {
      withdrawBsv: async () => { throw new Error('buyer sweep: output 204 sat is at or below dust (546)') },
      withdrawBase: async () => { throw gasDust(state.eth) },
    })
    const closed = await closeKitStep({ kit, paths }, PAIR)
    expect(closed.state === 'closed' && closed.final).deep.eq({ usdc: '0', eth_wei: '5', bsv_sats: '300' })
    state.claimedBsvSats = CLOSE_BSV_DUST_LIMIT_SATS - 1n
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('closed')
    state.claimedBsvSats = CLOSE_BSV_DUST_LIMIT_SATS
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('refused')
    state.claimedBsvSats = 300n
    state.eth = 6n
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('refused')
    state.eth = 5n
    state.unconfirmedBsvSats = 1n
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('refused')
  })

  it("M4 keys_note says 'closed and empty' only when final is all zero; otherwise it names each amount left", async () => {
    {
      const paths = home()
      const { kit } = fakeKit(paths, { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] })
      const closed = await closeKitStep({ kit, paths }, PAIR)
      expect(closed.state === 'closed' && closed.keys_note).eq(`The kit is closed and empty. ${KEEP.replace('{keys}', paths.keysPath)}`)
    }
    {
      const paths = home()
      const { kit } = fakeKit(paths, { usdc: 0n, eth: 5n, claimedBsvSats: 300n, swaps: [] }, {
        withdrawBsv: async () => { throw new Error('buyer sweep: output 204 sat is at or below dust (546)') },
        withdrawBase: async () => { throw gasDust(5n) },
      })
      const closed = await closeKitStep({ kit, paths }, PAIR)
      expect(closed.state === 'closed' && closed.keys_note).eq(`The kit is closed. It still holds 300 sats of BSV and 5 wei of ETH, too little to pay their own network fee, so they stay in the kit. ${KEEP.replace('{keys}', paths.keysPath)}`)
    }
    {
      const paths = home()
      const { kit } = fakeKit(paths, { usdc: 0n, eth: 5n, claimedBsvSats: 0n, swaps: [] }, {
        withdrawBase: async () => { throw gasDust(5n) },
      })
      const closed = await closeKitStep({ kit, paths }, PAIR)
      expect(closed.state === 'closed' && closed.keys_note).eq(`The kit is closed. It still holds 5 wei of ETH, too little to pay its own network fee, so it stays in the kit. ${KEEP.replace('{keys}', paths.keysPath)}`)
    }
  })

  it('S6 a brief failure refuses with retry_after_seconds 60; a refusal only the user can clear carries none', async () => {
    const brief = ['the Base RPC timed out', 'buyer sweep: missing merkle proof for ' + 'ab'.repeat(32), 'withdraw the USDC first; it needs ETH for gas', 'a swap blocks withdrawals (x: y)']
    const needsUser = [
      'refused by your limits file: this BSV address is not in bsvDestinations; nothing was sent', 'spending is stopped; the user removes the stop with `npx petasats-mcp resume`',
      'ETH is needed for Base gas', 'BSV sweeping is not configured', 'cannot withdraw to a swap or token contract', 'deliver_to must be a mainnet Base58Check P2PKH BSV address',
    ]
    for (const message of [...brief, ...needsUser]) {
      for (const where of ['usdc', 'bsv', 'walletInfo'] as const) {
        const paths = home()
        const state: FakeState = { usdc: where === 'usdc' ? 1n : 0n, eth: 0n, claimedBsvSats: where === 'bsv' ? 5000n : 0n, swaps: [] }
        const fail = async (): Promise<never> => { throw new Error(message) }
        const { kit } = fakeKit(paths, state, where === 'usdc' ? { withdrawBase: fail } : where === 'bsv' ? { withdrawBsv: fail } : { walletInfo: fail })
        const result = await closeKitStep({ kit, paths }, PAIR)
        expect(result.state === 'refused' && result.reason, `${where}: ${message}`).eq(message)
        expect(result.state === 'refused' && result.retry_after_seconds, `${where}: ${message}`).eq(brief.includes(message) ? 60 : undefined)
      }
    }
  })
})
