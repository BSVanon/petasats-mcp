import { expect } from 'chai'
import { describe, it } from 'mocha'
import { buyerStatusView } from '../../src/sdk/buyer/status-view'
import type { BuyerSwapRecord } from '../../src/sdk/buyer/types'

describe('buyer status view wording', () => {
  const record = {
    swapId: 'e'.repeat(32), requestId: 'synthetic', stage: 'failed', amountIn: '1000000',
    quote: { from: 'USDC', to: 'BSV', route: 'bridge', amountIn: 1_000_000n, amountOut: 10_000n, expiry: 99, quoteId: 'q'.repeat(16), doorQuoteId: 'q'.repeat(16), usdcBaseUnits: 1_000_000n, bsvSats: 10_000n },
    createdAtMs: 1, updatedAtMs: 1,
  } as BuyerSwapRecord

  it('shows reasons stored by an older kit in counterparty wording, without changing the record', () => {
    const old = { ...record, reason: 'The market maker declined this request: largest amount Maker can fund right now is 5 sat. Nothing was locked.', settlementModeDowngradeReason: 'market maker did not agree to fast settlement' } as BuyerSwapRecord
    expect(buyerStatusView(old)).to.include({
      reason: 'The counterparty declined this request: largest amount the counterparty can fund right now is 5 sat. Nothing was locked.',
      settlement_mode_downgrade_reason: 'the counterparty did not agree to fast settlement',
    })
    expect(old.reason).to.match(/^The market maker declined/)
  })

  it('leaves current text and missing reasons as they are', () => {
    expect(buyerStatusView({ ...record, reason: 'the USDC lock reverted; nothing was locked' })).to.include({ reason: 'the USDC lock reverted; nothing was locked', settlement_mode_downgrade_reason: null })
    expect(buyerStatusView(record).reason).to.equal(undefined)
  })
})
