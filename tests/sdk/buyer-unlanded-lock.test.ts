import { describe, it } from 'mocha'
import { expect } from 'chai'
import { buyerStageForSettlement } from '../../src/sdk/buyer/engine'
import { resolveUnlandedLock, UNLANDED_LOCK_ABORT_REASON } from '../../src/sdk/buyer/unlanded-lock'
import type { SettlementRecord } from '../../src/bridge/settlement-session'
import { createBuyerKit } from '../../src/sdk/buyer/buyer-kit'
import type { BuyerSwapRecord } from '../../src/sdk/buyer/types'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBuyerEngine } from '../../src/sdk/buyer/engine'
import { makeFileSwapRecordStore } from '../../src/market-maker/swap-record-store'

const HASH = 'a'.repeat(64)
const ZERO = `0x${'0'.repeat(64)}`
const record = (over: Partial<SettlementRecord> = {}): SettlementRecord => ({
  hashHex: HASH, role: 'initiator', state: 'base-locked', amountUsdc: '10', usdcTokenAddress: `0x${'1'.repeat(40)}`,
  baseClaimAddress: `0x${'2'.repeat(40)}`, baseRefundAddress: `0x${'3'.repeat(40)}`, baseTimelockBlock: 100,
  baseChainId: 8453, erc20SwapAddress: `0x${'4'.repeat(40)}`, usdcDecimals: 6, amountBsvSats: 100,
  quoteRef: 'synthetic', bsvRefundLocktime: 90, claimBudgetBaseBlocks: 1, baseRefundTs: 100, bsvRefundTs: 90,
  claimBudgetBaseSecs: 1, bsvClaimPubKeyHex: `02${'5'.repeat(64)}`, bsvRefundPubKeyHex: `03${'6'.repeat(64)}`,
  capUsdPerSwap: 1, zeroConfCapUsd: 0,
  baseLockTxHash: ZERO, baseLockLogIndex: -1, baseLockBlock: 0,
  history: [{ state: 'created', at: 1 }, { state: 'base-locked', at: 2 }], ...over,
})

function rails(over: Partial<{
  finalized: bigint; locked: boolean; nonce: number; pending: number; timestamp: number
  throwFinalized: boolean; throwLocked: boolean; throwNonce: boolean; throwPending: boolean; throwTimestamp: boolean; throwSubmit: boolean
}> = {}) {
  const calls: Array<{ kind: string; block?: bigint; nonce?: number; priorTxid?: string }> = []
  return {
    calls,
    finalizedBlockNumber: async () => { calls.push({ kind: 'finalized' }); if (over.throwFinalized) throw new Error('synthetic finalized failure'); return over.finalized ?? 90n },
    isSwapLocked: async (_p: unknown, opts: { blockNumber: bigint }) => { calls.push({ kind: 'locked', block: opts.blockNumber }); if (over.throwLocked) throw new Error('synthetic lookup refusal'); return over.locked ?? false },
    nonceAtBlock: async (block: bigint) => { calls.push({ kind: 'nonce', block }); if (over.throwNonce) throw new Error('synthetic nonce failure'); return over.nonce ?? 4 },
    pendingNonce: async () => { calls.push({ kind: 'pending' }); if (over.throwPending) throw new Error('synthetic pending failure'); return over.pending ?? 4 },
    blockTimestamp: async (block: bigint) => { calls.push({ kind: 'timestamp', block }); if (over.throwTimestamp) throw new Error('synthetic timestamp failure'); return over.timestamp ?? 1_000 },
    consumeNonce: async (nonce: number, priorTxid: `0x${string}` | undefined, onRecorded?: (signed: { hash: `0x${string}`; signedTx: `0x${string}`; nonce: number }) => Promise<void>) => {
      calls.push({ kind: 'burn-record', nonce, priorTxid })
      await onRecorded?.({ hash: `0x${nonce.toString(16).padStart(64, '0')}`, signedTx: `0x${'ab'.repeat(64)}`, nonce })
      if (over.throwSubmit) throw new Error('synthetic burn submit failure')
      calls.push({ kind: 'burn-submit', nonce, priorTxid })
      return `0x${nonce.toString(16).padStart(64, '0')}` as `0x${string}`
    },
  }
}

async function evaluate(source: SettlementRecord, chain = rails(), opts: { unmarked?: boolean; assertPoolSafe?: () => void } = {}) {
  let current: SettlementRecord | undefined = source
  const result = await resolveUnlandedLock(source, {
    evm: chain, now: () => 9_000,
    reread: () => current,
    persist: (next) => { current = next },
    assertPoolSafe: opts.assertPoolSafe ?? (() => {}),
    resolveUnmarkedRecords: opts.unmarked,
  })
  return { result, current, calls: chain.calls }
}

describe('buyer kit 0.2.2 — unlanded Base lock recovery', () => {
  it('GATE: a record changed while a burn was being priced is never overwritten and the burn is not submitted', async () => {
    const attempt = { txHash: `0x${'de'.repeat(32)}` as `0x${string}`, nonce: 4 }
    const source = record({ baseLockAttempts: [attempt] })
    const refunding = { ...source, refundTxid: `0x${'cd'.repeat(32)}` } as SettlementRecord
    let current: SettlementRecord | undefined = source
    let rereads = 0
    const chain = rails()
    const result = await resolveUnlandedLock(source, {
      evm: chain, now: () => 9_000,
      // The pre-burn re-read sees the original; a concurrent refund update lands before the burn is recorded.
      reread: () => (++rereads >= 2 ? (current = refunding) : current),
      persist: (next) => { current = next }, assertPoolSafe: () => {},
    })
    expect(result).to.equal(undefined)
    expect(current).to.equal(refunding)
    expect(chain.calls.some((call) => call.kind === 'burn-submit')).to.equal(false)
  })

  it('GATE: a damaged record whose nonce bound is far above the chain nonce is never burned through', async () => {
    const { result, current, calls } = await evaluate(record({ baseLockAttempts: [{ txHash: `0x${'de'.repeat(32)}`, nonce: 12 }] }))
    expect(result).to.equal(undefined)
    expect(current?.baseLockAttempts).to.have.length(1)
    expect(calls.some((call) => call.kind === 'burn-record')).to.equal(false)
  })

  it('F5 attempts consumed at finalized block write an aborted tombstone and render the buyer failed', async () => {
    const out = await evaluate(record({ baseLockAttempts: [{ txHash: `0x${'b'.repeat(64)}`, nonce: 3 }] }))
    expect(out.result).to.include({ state: 'aborted', abortReason: UNLANDED_LOCK_ABORT_REASON })
    expect(out.current?.history.at(-1)).to.deep.equal({ state: 'aborted', at: 9 })
    expect(buyerStageForSettlement(out.result!.state)).to.equal('failed')
  })

  it('F5 terminal failed recovery no longer occupies the buyer active slot or blocks a Base withdrawal', async () => {
    const prior: BuyerSwapRecord = {
      swapId: 's'.repeat(32), requestId: 'r'.repeat(16), stage: 'waiting_bsv_lock', amountIn: '10',
      quote: { from: 'USDC', to: 'BSV', route: 'bridge', amountIn: 10n, amountOut: 1n, expiry: 99, quoteId: 'q'.repeat(16), doorQuoteId: 'q'.repeat(16), usdcBaseUnits: 10n, bsvSats: 1n },
      createdAtMs: 1, updatedAtMs: 1, settlementHashHex: HASH, settlementRecordCreated: true, settlementState: 'base-locked',
    }
    const rows = new Map([[prior.swapId, prior]])
    const kit = createBuyerKit({ now: () => 1_000, maxActiveSwaps: 1 }, {
      store: { list: async () => [...rows.values()], get: async (id) => rows.get(id), put: async (next) => { rows.set(next.swapId, next) } },
      executor: {
        execute: async () => ({ ok: true }),
        recoverAll: async () => new Map([[prior.swapId, { stage: 'failed' as const, settlementState: 'aborted' as const, reason: UNLANDED_LOCK_ABORT_REASON }]]),
      },
      wallet: {
        baseAddress: `0x${'1'.repeat(40)}`, bsvAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
        balances: async () => ({ usdc: 20n, eth: 1n, claimedBsvSats: 0n }), transferUsdc: async () => ({ hash: 'synthetic', status: 'success' as const }),
      },
      door: { quote: async () => ({ quoteId: 'n'.repeat(16), bsvSats: 1, usdcBaseUnits: '10', expiresAtMs: 10_000 }), admit: async () => ({ swapNamespace: 'n'.repeat(32), handshakeDeadlineMs: 10_000 }) },
    })
    await kit.recover()
    expect((await kit.status(prior.swapId))[0].stage).to.equal('failed')
    await kit.withdrawBase({ asset: 'USDC', to: `0x${'2'.repeat(40)}`, amount: '1' })
    expect((await kit.startSwap({ amountIn: 10n, minBsvOut: 1n })).stage).to.equal('quoted')
  })

  it('T1 an unconsumed recorded attempt is burned (recorded before submit), never tombstoned', async () => {
    const attempt = `0x${'b'.repeat(64)}` as `0x${string}`
    const chain = rails()
    const out = await evaluate(record({ baseLockAttempts: [{ txHash: attempt, nonce: 4 }] }), chain)
    expect(out.result).to.equal(undefined)
    expect(out.current?.baseLockAttempts).to.deep.equal([
      { txHash: attempt, nonce: 4 },
      { txHash: `0x${'0'.repeat(63)}4`, nonce: 4, kind: 'burn', at: 9 },
    ])
    expect(chain.calls.filter((call) => call.kind.startsWith('burn'))).to.deep.equal([
      { kind: 'burn-record', nonce: 4, priorTxid: attempt }, { kind: 'burn-submit', nonce: 4, priorTxid: attempt },
    ])
  })

  it('F7 never resolves a tuple that is locked at finalized', async () => {
    const out = await evaluate(record({ baseLockAttempts: [{ txHash: `0x${'b'.repeat(64)}`, nonce: 3 }] }), rails({ locked: true, nonce: 9, pending: 9 }))
    expect(out.result).to.equal(undefined)
  })

  for (const fault of ['throwFinalized', 'throwLocked', 'throwNonce', 'throwTimestamp', 'throwPending'] as const) {
    it(`F8 ${fault}: a read failure does not resolve, then a later successful pass can resolve`, async () => {
      const source = record({ baseLockAttempts: [{ txHash: `0x${'b'.repeat(64)}`, nonce: 4 }] })
      expect((await evaluate(source, rails({ [fault]: true }))).result).to.equal(undefined)
      expect((await evaluate(source)).result).to.equal(undefined)
    })
  }

  for (const evidence of [
    { state: 'revealed' as const, secretHex: 'a'.repeat(64), baseLockTxHash: ZERO, history: [{ state: 'created' as const, at: 1 }, { state: 'base-locked' as const, at: 2 }, { state: 'revealed' as const, at: 3 }] },
    { bsvClaimTxid: 'c'.repeat(64) }, { bsvClaimTxHex: 'aa' }, { bsvClaimBeefHex: 'bb' }, { refundTxid: `0x${'d'.repeat(64)}` },
    { baseLockTxHash: `0x${'e'.repeat(64)}` },
  ]) {
    it('F9 evidence or a real lock hash is never resolved by this path', async () => {
      expect((await evaluate(record(evidence))).result).to.equal(undefined)
    })
  }

  it('T3 an opted-in old record waits 3600s after its base-locked entry, burns its finalized nonce, then applies rule A', async () => {
    const source = record()
    const tooEarly = rails({ timestamp: 3_601 })
    expect((await evaluate(source, tooEarly, { unmarked: true })).result).to.equal(undefined)
    expect(tooEarly.calls.filter((call) => call.kind === 'burn-record')).to.deep.equal([])
    // The anchor is the base-locked entry, not record creation: a slow approve must not shorten the wait.
    const slowApprove = rails({ timestamp: 3_602 })
    expect((await evaluate(record({ history: [{ state: 'created', at: 1 }, { state: 'base-locked', at: 500 }] }), slowApprove, { unmarked: true })).result).to.equal(undefined)
    expect(slowApprove.calls.filter((call) => call.kind === 'burn-record')).to.deep.equal([])
    const chain = rails({ timestamp: 3_602 })
    const first = await evaluate(source, chain, { unmarked: true })
    expect(first.current?.baseLockAttempts).to.deep.equal([{ txHash: `0x${'0'.repeat(63)}4`, nonce: 4, kind: 'burn', at: 9 }])
    expect(chain.calls.filter((call) => call.kind === 'burn-submit')).to.have.length(1)
    expect((await evaluate(first.current!, rails({ nonce: 5, pending: 5 }))).result?.state).to.equal('aborted')
  })

  it('T4 an explicit empty marker resolves at once with no nonce burn', async () => {
    const chain = rails()
    const out = await evaluate(record({ baseLockAttempts: [] }), chain)
    expect(out.result?.state).to.equal('aborted')
    expect(chain.calls.map((call) => call.kind)).to.deep.equal(['finalized', 'locked'])
  })

  it('T5 an executor still running for the hash blocks both rule A and burns', async () => {
    const source = record({ baseLockAttempts: [{ txHash: `0x${'b'.repeat(64)}`, nonce: 3 }] })
    const chain = rails({ nonce: 4 })
    const result = await resolveUnlandedLock(source, { evm: chain, now: () => 9_000, reread: () => source, persist: () => { throw new Error('must not persist') }, isExecuting: () => true, assertPoolSafe: () => {} })
    expect(result).to.equal(undefined)
    expect(chain.calls).to.deep.equal([])
  })

  it('T6 a burn persistence failure submits nothing; a submit failure is retried no sooner than 600s', async () => {
    const source = record({ baseLockAttempts: [{ txHash: `0x${'b'.repeat(64)}`, nonce: 4 }] })
    const persistFailure = rails()
    await resolveUnlandedLock(source, { evm: persistFailure, now: () => 9_000, reread: () => source, persist: () => { throw new Error('synthetic persist failure') }, assertPoolSafe: () => {} })
    expect(persistFailure.calls.filter((call) => call.kind === 'burn-submit')).to.deep.equal([])
    let current = source
    const submitFailure = rails({ throwSubmit: true })
    await resolveUnlandedLock(source, { evm: submitFailure, now: () => 9_000, reread: () => current, persist: (next) => { current = next }, assertPoolSafe: () => {} })
    await resolveUnlandedLock(current, { evm: submitFailure, now: () => 9_000, reread: () => current, persist: (next) => { current = next }, assertPoolSafe: () => {} })
    expect(submitFailure.calls.filter((call) => call.kind === 'burn-record')).to.have.length(1)
  })

  it('T8 burns every nonce through the bound in order, and T9 waits if pending is ahead', async () => {
    const attempts = [{ txHash: `0x${'b'.repeat(64)}` as `0x${string}`, nonce: 4 }, { txHash: `0x${'c'.repeat(64)}` as `0x${string}`, nonce: 6 }]
    const chain = rails()
    await evaluate(record({ baseLockAttempts: attempts }), chain)
    expect(chain.calls.filter((call) => call.kind === 'burn-submit').map((call) => call.nonce)).to.deep.equal([4, 5, 6])
    expect(chain.calls.filter((call) => call.kind === 'burn-submit').map((call) => call.priorTxid)).to.deep.equal([attempts[0].txHash, undefined, attempts[1].txHash])
    const pendingAhead = rails({ pending: 5 })
    expect((await evaluate(record({ baseLockAttempts: [{ txHash: `0x${'b'.repeat(64)}`, nonce: 4 }] }), pendingAhead)).result).to.equal(undefined)
    expect(pendingAhead.calls.filter((call) => call.kind === 'burn-record')).to.deep.equal([])
  })

  it('F12 exact tuple and nonce reads receive the same explicit finalized block number', async () => {
    const out = await evaluate(record({ baseLockAttempts: [{ txHash: `0x${'b'.repeat(64)}`, nonce: 3 }] }), rails({ finalized: 77n }))
    expect(out.calls.filter((call) => call.kind === 'locked' || call.kind === 'nonce').map((call) => call.block)).to.deep.equal([77n, 77n])
  })

  it('REVIEW2 H1: a record without the attempt marker is never burned or resolved unless the operator opts in', async () => {
    const source = record()
    for (const chain of [rails({ timestamp: 3_602 }), rails({ timestamp: 3_602, nonce: 9, pending: 9 })]) {
      const out = await evaluate(source, chain)
      expect(out.result).to.equal(undefined)
      expect(out.current).to.equal(source)
      expect(chain.calls.filter((call) => call.kind.startsWith('burn'))).to.deep.equal([])
    }
    const optedIn = rails({ timestamp: 3_602 })
    await evaluate(source, optedIn, { unmarked: true })
    expect(optedIn.calls.filter((call) => call.kind === 'burn-submit').map((call) => call.nonce)).to.deep.equal([4])
  })

  it('REVIEW2 H2: a split or unverified pool never writes a tombstone; the check runs after every read', async () => {
    for (const source of [record({ baseLockAttempts: [] }), record({ baseLockAttempts: [{ txHash: `0x${'b'.repeat(64)}`, nonce: 3 }] })]) {
      const chain = rails({ nonce: 4 })
      const out = await evaluate(source, chain, { assertPoolSafe: () => { chain.calls.push({ kind: 'pool' }); throw new Error('buyer EVM rail is split or unverified') } })
      expect(out.result).to.equal(undefined)
      expect(out.current).to.equal(source)
      expect(chain.calls.map((call) => call.kind).at(-1)).to.equal('pool')
      expect((await evaluate(source, rails({ nonce: 4 }))).result?.state).to.equal('aborted')
    }
  })
})

describe('buyer engine — a never-landed lock resolves through recoverAll', () => {
  const engineOver = (dir: string, chain: ReturnType<typeof rails>, over: Record<string, unknown> = {}) => makeBuyerEngine({
    settlementDir: dir, comms: {}, doorIdentity: 'b'.repeat(66), evm: chain, bsv: {}, chainTracker: {}, bsvReservePub: {},
    usdcTokenAddress: `0x${'1'.repeat(40)}`, capUsdPerSwap: 100, now: () => 9_000, sleep: async () => {}, log: () => {},
    assertEvmPoolSafe: () => {}, ...over,
  } as any) as any
  const buyer = { swapId: 'c'.repeat(32), stage: 'refund_waiting', settlementHashHex: HASH, settlementRecordCreated: true, settlementState: 'base-locked' } as unknown as BuyerSwapRecord

  it('ENGINE: recoverAll writes the aborted tombstone to disk and renders the swap failed; acknowledgment keeps it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'petasats-unlanded-'))
    const store = makeFileSwapRecordStore(dir, { censusGroupRead: false, recordMode: 0o600 })
    store.write(record({ baseLockAttempts: [{ txHash: `0x${'b'.repeat(64)}`, nonce: 3 }] }))
    const engine = engineOver(dir, rails({ nonce: 4 }))
    const outcome = (await engine.recoverAll([buyer])).get(buyer.swapId)
    expect(outcome).to.include({ stage: 'failed', settlementState: 'aborted' })
    const onDisk = store.list().records.find((entry) => entry.hashHex === HASH)!
    expect(onDisk.state).eq('aborted')
    expect(onDisk.abortReason).eq(UNLANDED_LOCK_ABORT_REASON)
    expect(onDisk.baseLockAttempts).to.deep.equal([{ txHash: `0x${'b'.repeat(64)}`, nonce: 3 }])
    await engine.acknowledgeTerminal({ ...buyer, stage: 'failed', settlementState: 'aborted', baseLockTxid: ZERO })
    expect(store.list().records.map((entry) => entry.hashHex)).to.include(HASH)
  })

  it('ENGINE REVIEW2: a split pool, or no pool check at all, leaves the record on disk untouched', async () => {
    for (const over of [{ assertEvmPoolSafe: () => { throw new Error('buyer EVM rail is split or unverified') } }, { assertEvmPoolSafe: undefined }]) {
      const dir = mkdtempSync(join(tmpdir(), 'petasats-unlanded-split-'))
      const store = makeFileSwapRecordStore(dir, { censusGroupRead: false, recordMode: 0o600 })
      store.write(record({ baseLockAttempts: [{ txHash: `0x${'b'.repeat(64)}`, nonce: 3 }] }))
      const outcome = (await engineOver(dir, rails({ nonce: 4 }), over).recoverAll([buyer])).get(buyer.swapId)
      expect(outcome?.stage).to.not.equal('failed')
      expect(store.list().records.find((entry) => entry.hashHex === HASH)!.state).eq('base-locked')
    }
  })

  it('ENGINE REVIEW2: an unmarked record is burned only with the operator opt-in', async () => {
    for (const optIn of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), 'petasats-unlanded-optin-'))
      const store = makeFileSwapRecordStore(dir, { censusGroupRead: false, recordMode: 0o600 })
      store.write(record())
      const chain = rails({ timestamp: 3_602 })
      await engineOver(dir, chain, { resolveUnmarkedStuckLocks: optIn }).recoverAll([buyer])
      expect(chain.calls.filter((call) => call.kind === 'burn-submit')).to.have.length(optIn ? 1 : 0)
      expect(store.list().records.find((entry) => entry.hashHex === HASH)!.baseLockAttempts?.length ?? 0).eq(optIn ? 1 : 0)
    }
  })

  it('CONTROL: a reverted-lock tombstone is still cleared on acknowledgment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'petasats-unlanded-control-'))
    const store = makeFileSwapRecordStore(dir, { censusGroupRead: false, recordMode: 0o600 })
    store.write(record({ state: 'aborted', abortReason: 'the USDC lock reverted; nothing was locked', history: [{ state: 'created', at: 1 }, { state: 'base-locked', at: 2 }, { state: 'aborted', at: 3 }] }))
    const engine = engineOver(dir, rails())
    await engine.acknowledgeTerminal({ ...buyer, stage: 'failed', settlementState: 'aborted', baseLockTxid: ZERO })
    expect(store.list().records.map((entry) => entry.hashHex)).to.not.include(HASH)
  })
})
