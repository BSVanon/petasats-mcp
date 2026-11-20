// The close-down's BSV leg through the real kit and runtime (fake rails only): unconfirmed BSV is waited for, and a
// sweep is saved in close.json before its broadcast, so a send whose result was lost is still listed exactly once.
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { expect } from 'chai'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import { MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { closeKitStep } from '../../../src/sdk/buyer/close'
import { buildSweepTx } from '../../../src/sdk/buyer/runtime/sweep'
import { readSpendingStop } from '../../../src/sdk/buyer/stop'
import { BAD_SWEEPS, DEST_BSV, PAIR, coin, fakeKit, home, readCloseFile, runtimeKit, walletInfoOf, type FakeState, type RuntimeCoin } from './close-helpers'

/** The txid the fake sweep builder gives these coins: a pure function of the inputs, like the real one. */
const sweepTxid = (coins: RuntimeCoin[]): string => createHash('sha256').update(coins.map((c) => `${c.tx_hash}.${c.tx_pos}`).join(',')).digest('hex')
const bsvSend = (coins: RuntimeCoin[]) => ({ asset: 'BSV', amount: String(coins.reduce((total, c) => total + c.value, 0) - 100), to: DEST_BSV, txid: sweepTxid(coins) })

describe('buyer kit close-down: BSV', () => {
  it('S3 the sweep (txid, sats, inputs) is saved in close.json before its broadcast, then listed once and cleared', async () => {
    const paths = home()
    const a = coin('a', 50_000, 3, 1)
    const rails = { coins: [a], relay: async (txid: string) => {
      expect(readCloseFile(paths).bsvOutbox, 'saved before the broadcast').deep.eq({ txid, sats: '49900', inputs: [`${a.tx_hash}.1`] })
      rails.coins = []
    } }
    const { kit, events } = await runtimeKit(paths, rails)
    const sent = await closeKitStep({ kit, paths }, PAIR)
    expect(sent.state === 'in_progress' && sent.did).eq(`sent the confirmed BSV to ${DEST_BSV}`)
    expect(events.filter((event) => !event.startsWith('unspent'))).deep.eq([`build ${sweepTxid([a])}`, `broadcast ${sweepTxid([a])}`])
    expect(readCloseFile(paths).sends).deep.eq([bsvSend([a])])
    expect(readCloseFile(paths).bsvOutbox).eq(undefined)
    const closed = await closeKitStep({ kit, paths }, PAIR)
    expect(closed.state === 'closed' && closed.sent).deep.eq([bsvSend([a])])
  })

  it('S3 (P-C) a broadcast that went out but threw is listed on the next call from the saved sweep', async () => {
    const paths = home()
    const a = coin('a', 500_000)
    const rails = { coins: [a], relay: async () => { rails.coins = []; throw new Error('broadcast: all endpoints timed out') } }
    const { kit } = await runtimeKit(paths, rails)
    const lost = await closeKitStep({ kit, paths }, PAIR)
    expect(lost.state === 'refused' && [lost.reason, lost.retry_after_seconds]).deep.eq(['broadcast: all endpoints timed out', 60])
    const next = await closeKitStep({ kit, paths }, PAIR)
    expect(next.state === 'in_progress' && next.did).eq(`nothing new sent; the earlier BSV send ${sweepTxid([a])} went out`)
    expect(next.sent).deep.eq([bsvSend([a])])
    const closed = await closeKitStep({ kit, paths }, PAIR)
    expect(closed.state === 'closed' && closed.sent).deep.eq([bsvSend([a])])
  })

  it('S3 a broadcast that never happened is retried: the same coins give the same txid, listed once', async () => {
    const paths = home()
    const a = coin('a', 80_000)
    let fail = true
    const rails = { coins: [a], relay: async () => { if (fail) throw new Error('broadcast: the relay refused the transaction'); rails.coins = [] } }
    const { kit, events } = await runtimeKit(paths, rails)
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('refused')
    expect(readCloseFile(paths).bsvOutbox?.txid).eq(sweepTxid([a]))
    fail = false
    const retried = await closeKitStep({ kit, paths }, PAIR)
    expect(retried.sent).deep.eq([bsvSend([a])])
    expect(events.filter((event) => event.startsWith('broadcast'))).deep.eq([`broadcast ${sweepTxid([a])}`, `broadcast ${sweepTxid([a])}`])
    expect(readCloseFile(paths).bsvOutbox).eq(undefined)
  })

  it('S3 new coins give a new sweep that replaces a saved one that never went out', async () => {
    const paths = home()
    const a = coin('a', 80_000)
    const b = coin('b', 20_000)
    let fail = true
    const rails = { coins: [a], relay: async () => { if (fail) throw new Error('broadcast: the relay refused the transaction'); rails.coins = [] } }
    const { kit } = await runtimeKit(paths, rails)
    expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('refused')
    rails.coins = [a, b]
    fail = false
    const sent = await closeKitStep({ kit, paths }, PAIR)
    expect(sent.sent).deep.eq([bsvSend([a, b])])
  })

  it('S3 a saved sweep whose inputs are all spent is listed before a new sweep replaces it, and before dust is left behind', async () => {
    {
      const paths = home()
      const a = coin('a', 80_000)
      const b = coin('b', 20_000)
      let lose = true
      const rails = { coins: [a], relay: async () => { rails.coins = rails.coins.filter((c) => c !== a && c !== b); if (lose) throw new Error('broadcast: all endpoints timed out') } }
      const { kit } = await runtimeKit(paths, rails)
      expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('refused')
      rails.coins = [b]
      lose = false
      const sent = await closeKitStep({ kit, paths }, PAIR)
      expect(sent.sent).deep.eq([bsvSend([a]), bsvSend([b])])
    }
    {
      const paths = home()
      const a = coin('a', 80_000)
      const rails = { coins: [a], relay: async () => { rails.coins = []; throw new Error('broadcast: all endpoints timed out') } }
      const { kit } = await runtimeKit(paths, rails)
      expect((await closeKitStep({ kit, paths }, PAIR)).state).eq('refused')
      rails.coins = [coin('c', 300)] // a tiny deposit: too small to sweep
      const closed = await closeKitStep({ kit, paths }, PAIR)
      expect(closed.state).eq('closed')
      if (closed.state === 'closed') {
        expect(closed.sent).deep.eq([bsvSend([a])])
        expect(closed.final.bsv_sats).eq('300')
      }
    }
  })

  it('S3 withdraw_bsv, which passes no hook, sweeps as before and writes no close record', async () => {
    const paths = home()
    const a = coin('a', 60_000)
    const rails = { coins: [a], relay: async () => { rails.coins = [] } }
    const { kit } = await runtimeKit(paths, rails)
    expect(await kit.withdrawBsv(DEST_BSV)).deep.eq({ txid: sweepTxid([a]), sats: 59_900n })
    expect(existsSync(join(paths.home, 'close.json'))).eq(false)
  })

  it('M2 the runtime reports unconfirmed BSV from the same coin list it sweeps from', async () => {
    const paths = home()
    const { kit } = await runtimeKit(paths, { usdc: 0n, eth: 0n, coins: [coin('a', 10_000, 2), coin('b', 700, 0), coin('c', 300, 0)] })
    const info = await kit.walletInfo()
    expect([info.claimedBsvSats, info.unconfirmedBsvSats]).deep.eq([10_000n, 1_000n])
  })

  it('M2 the BSV step waits while any coin is unconfirmed, then one sweep takes every coin', async () => {
    const paths = home()
    const rails = { coins: [coin('a', 700_000, 3), coin('b', 5_000, 0)] }
    const { kit, events } = await runtimeKit(paths, rails)
    const waiting = await closeKitStep({ kit, paths }, PAIR)
    expect(waiting.state === 'in_progress' && waiting.did).eq('nothing sent; 5000 sats of BSV are not confirmed yet; they will be sent after they confirm')
    expect(events.filter((event) => !event.startsWith('unspent')), 'nothing built or broadcast').deep.eq([])
    rails.coins[1] = coin('b', 5_000, 1)
    const sent = await closeKitStep({ kit, paths }, PAIR)
    expect(sent.state === 'in_progress' && sent.sent).deep.eq([bsvSend(rails.coins)])
  })

  it('M2 BSV still unconfirmed when the empty check runs keeps the close in progress, with no STOP', async () => {
    const paths = home()
    let reads = 0
    const state: FakeState = { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }
    const { kit } = fakeKit(paths, state, { walletInfo: async () => { reads++; if (reads === 2) state.unconfirmedBsvSats = 500n; return walletInfoOf(state) } })
    const result = await closeKitStep({ kit, paths }, PAIR)
    expect(result.state === 'in_progress' && [result.did, result.call_again_after_seconds]).deep.eq(['nothing sent; 500 sats of BSV are not confirmed yet; they will be sent after they confirm', 60])
    expect(readSpendingStop(paths)).eq(undefined)
  })

  it('N5 the one sweep shape check before the broadcast: a plan that fails it is neither saved nor sent', async () => {
    for (const bad of BAD_SWEEPS) {
      const paths = home()
      let broadcast = false
      const { kit } = fakeKit(paths, { usdc: 0n, eth: 0n, claimedBsvSats: 5000n, swaps: [] }, {
        withdrawBsv: async (_address, opts) => {
          await opts?.beforeBroadcast?.({ txid: bad.txid, sats: BigInt(bad.sats), inputs: bad.inputs })
          broadcast = true
          return { txid: bad.txid, sats: BigInt(bad.sats) }
        },
      })
      const label = JSON.stringify(bad)
      const result = await closeKitStep({ kit, paths }, PAIR)
      expect(result.state === 'refused' && result.reason, label).eq('the BSV send could not be recorded before its broadcast; nothing was sent')
      expect(broadcast, label).eq(false)
      expect(readCloseFile(paths).bsvOutbox, label).eq(undefined)
    }
  })

  it('R1 two sweeps of the same confirmed coin are byte-identical, so a rebuilt sweep has the same txid', async () => {
    const key = PrivateKey.fromRandom()
    const parent = new Transaction()
    parent.addOutput({ lockingScript: new P2PKH().lock(key.toPublicKey().toAddress()), satoshis: 50000 })
    parent.merklePath = new MerklePath(800000, [[{ offset: 0, hash: parent.id('hex') as string, txid: true }, { offset: 1, duplicate: true }]])
    const source = { tx_hash: parent.id('hex') as string, tx_pos: 0, value: 50000, height: 800000, confirmations: 3, sourceTx: parent }
    const first = await buildSweepTx({ coins: [source], toAddress: DEST_BSV, key, feeRate: 500 })
    const second = await buildSweepTx({ coins: [source], toAddress: DEST_BSV, key, feeRate: 500 })
    expect(second.rawTx).eq(first.rawTx)
    expect(second.tx.id('hex')).eq(first.tx.id('hex'))
  })
})
