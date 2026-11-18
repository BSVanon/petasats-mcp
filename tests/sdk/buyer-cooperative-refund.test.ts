import { expect } from 'chai'
import { describe, it } from 'mocha'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettlementRecord } from '../../src/bridge/settlement-session'
import { resolveCooperativeRefund } from '../../src/sdk/buyer/cooperative-refund'
import { buyerStageForSettlement, makeBuyerEngine } from '../../src/sdk/buyer/engine'
import { buyerStatusView } from '../../src/sdk/buyer/status-view'
import { COOPERATIVE_REFUND_REASON, type BuyerSwapRecord } from '../../src/sdk/buyer/types'
import { makeFileSwapRecordStore } from '../../src/market-maker/swap-record-store'

const HASH = 'a'.repeat(64)
const REFUND_TXID = `0x${'b'.repeat(64)}` as `0x${string}`

function record(over: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    hashHex: HASH, role: 'initiator', state: 'base-locked', amountUsdc: '1000000', amountBsvSats: 10_000,
    quoteRef: 'synthetic', baseTimelockBlock: 180_100, bsvRefundLocktime: 800_012, claimBudgetBaseBlocks: 36_000,
    baseRefundTs: 1, bsvRefundTs: 1, claimBudgetBaseSecs: 7_200, bsvClaimPubKeyHex: `02${'1'.repeat(64)}`,
    bsvRefundPubKeyHex: `03${'2'.repeat(64)}`, baseChainId: 8453, erc20SwapAddress: `0x${'3'.repeat(40)}`,
    usdcTokenAddress: `0x${'4'.repeat(40)}`, usdcDecimals: 6, baseClaimAddress: `0x${'5'.repeat(40)}`,
    baseRefundAddress: `0x${'6'.repeat(40)}`, capUsdPerSwap: 100, zeroConfCapUsd: 0,
    baseLockTxHash: `0x${'7'.repeat(64)}`, baseLockBlock: 100,
    history: [{ state: 'created', at: 1 }, { state: 'base-locked', at: 2 }], ...over,
  }
}

function rails(over: { locked?: boolean; outcome?: 'refunded' | 'claimed' | 'unresolved'; failFinalized?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    finalizedBlockNumber: async () => {
      calls.push('finalized')
      if (over.failFinalized) throw new Error('synthetic finalized outage')
      return 123n
    },
    isSwapLocked: async (_params: unknown, opts: { blockNumber: bigint }) => {
      calls.push(`locked:${opts.blockNumber}`)
      return over.locked ?? false
    },
    resolveSwapOutcome: async () => {
      calls.push('outcome')
      if (over.outcome === 'claimed') return { kind: 'claimed' as const, preimage: `0x${'8'.repeat(64)}` as `0x${string}`, eventTxid: REFUND_TXID }
      if (over.outcome === 'unresolved') return { kind: 'unresolved' as const, reason: 'not-found' as const }
      return { kind: 'refunded' as const, eventTxid: REFUND_TXID }
    },
  }
}

describe('buyer cooperative refund recovery', () => {
  it("K-I1: finalizes the counterparty’s Refund and a later BSV-lock observation cannot create a reveal", async () => {
    let current = record()
    const result = await resolveCooperativeRefund(current, {
      evm: rails(), now: () => 9_000, reread: () => current, persist: (next) => { current = next }, assertPoolSafe: () => {},
    })
    expect(result).to.include({ kind: 'refunded', eventTxid: REFUND_TXID })
    expect(current).to.include({ state: 'refunded', refundTxid: REFUND_TXID })
    expect(buyerStageForSettlement(current.state)).eq('refunded')
    // A stale later BSV lock is never a reason to re-enter a reveal-capable state.
    current = { ...current, bsvLockOutpoint: `${'c'.repeat(64)}_0` }
    let writes = 0
    const later = await resolveCooperativeRefund(current, {
      evm: rails(), now: () => 9_001, reread: () => current, persist: () => { writes++ }, assertPoolSafe: () => {},
    })
    expect(later.record).to.equal(current)
    expect(current).to.not.have.property('bsvClaimTxid')
    expect(writes).eq(0)
  })

  it('I4: cooperative-refund helper clamps both manual history edges to the previous timestamp', async () => {
    let current = record({ history: [{ state: 'created', at: 10 }, { state: 'base-locked', at: 20 }] })
    const result = await resolveCooperativeRefund(current, {
      evm: rails(), now: () => 9_000, reread: () => current,
      persist: (next) => { current = next }, assertPoolSafe: () => {},
    })
    expect(result.kind).to.equal('refunded')
    expect(current.history.slice(-2)).to.deep.equal([
      { state: 'refunding', at: 20 }, { state: 'refunded', at: 20 },
    ])
  })

  it('K-I2: a locked tuple, unavailable finalized read, unresolved event, or unsafe pool never changes the record', async () => {
    for (const scenario of [
      { name: 'still locked', rails: rails({ locked: true }), safe: () => {} },
      { name: 'finalized read unavailable', rails: rails({ failFinalized: true }), safe: () => {} },
      { name: 'no canonical event', rails: rails({ outcome: 'unresolved' }), safe: () => {} },
      { name: 'pool unsafe', rails: rails(), safe: () => { throw new Error('synthetic pool split') } },
    ]) {
      let current = record()
      const before = structuredClone(current)
      const result = await resolveCooperativeRefund(current, {
        evm: scenario.rails, now: () => 9_000, reread: () => current, persist: (next) => { current = next }, assertPoolSafe: scenario.safe,
      })
      expect(result.kind, scenario.name).eq('none')
      expect(current, scenario.name).to.deep.equal(before)
    }
  })

  it('marks a finalized exact-tuple Claim as attention, never as a refund', async () => {
    const current = record()
    const result = await resolveCooperativeRefund(current, {
      evm: rails({ outcome: 'claimed' }), now: () => 9_000, reread: () => current, persist: () => { throw new Error('must not persist') }, assertPoolSafe: () => {},
    })
    expect(result).to.include({ kind: 'claimed', eventTxid: REFUND_TXID })
    expect(current.state).eq('base-locked')
  })

  it("maps the finalized Refund through buyer recovery, unblocks the kit, and names the counterparty’s decline", async () => {
    const settlementDir = mkdtempSync(join(tmpdir(), 'petasats-buyer-coop-refund-'))
    const settlements = makeFileSwapRecordStore(settlementDir, { censusGroupRead: false })
    settlements.write(record())
    const engine = makeBuyerEngine({
      settlementDir, comms: {}, doorIdentity: `02${'9'.repeat(64)}`, evm: { ...rails(), address: () => `0x${'6'.repeat(40)}`, swapAddress: `0x${'3'.repeat(40)}`, chainId: 8453 },
      bsv: {}, chainTracker: {}, bsvReservePub: {}, usdcTokenAddress: `0x${'4'.repeat(40)}`, capUsdPerSwap: 100,
      now: () => 9_000, sleep: async () => {}, log: () => {}, assertEvmPoolSafe: () => {},
    } as any)
    const buyer = {
      swapId: 'd'.repeat(32), requestId: 'synthetic', stage: 'waiting_bsv_lock', amountIn: '1000000',
      quote: { from: 'USDC', to: 'BSV', route: 'bridge', amountIn: 1_000_000n, amountOut: 10_000n, expiry: 99, quoteId: 'q'.repeat(16), doorQuoteId: 'q'.repeat(16), usdcBaseUnits: 1_000_000n, bsvSats: 10_000n },
      createdAtMs: 1, updatedAtMs: 1, settlementHashHex: HASH, settlementState: 'base-locked', settlementRecordCreated: true,
    } as BuyerSwapRecord
    const outcome = (await engine.recoverAll([buyer])).get(buyer.swapId)
    expect(outcome).to.include({ stage: 'refunded', settlementState: 'refunded', baseRefundTxid: REFUND_TXID })
    expect(settlements.list().records[0]).to.include({ state: 'refunded', refundTxid: REFUND_TXID })
    const view = buyerStatusView({ ...buyer, ...outcome, stage: 'refunded', settlementState: 'refunded', reason: COOPERATIVE_REFUND_REASON })
    expect(view).to.include({ done: true, stage_label: "The counterparty declined; USDC came back" })
  })
})
