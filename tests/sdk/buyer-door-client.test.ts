import { describe, it } from 'mocha'
import { expect } from 'chai'
import { mapDoorDecline } from '../../src/sdk/buyer/door-client'

describe('buyer door decline mapping', () => {
  const cases: Array<[string, string]> = [
    ['missing authenticated sender', 'declined'], ['unsupported direction or asset', 'declined'], ['amount below minimum swap size', 'declined'],
    ['pricer declined quote', 'unavailable'], ['pricer did not bind the requested USDC amount', 'unavailable'], ['quote unavailable', 'unavailable'],
    ['swap admission unavailable', 'unavailable'], ['admission store write failed', 'unavailable'], ['kill-switch engaged', 'unavailable'],
    ['per-swap limit exceeded', 'limit'], ['identity count limit exceeded', 'limit'], ['identity USD limit exceeded', 'limit'],
    ['global count limit exceeded', 'busy'], ['global USD limit exceeded', 'busy'], ['admissions/hour limit exceeded', 'busy'], ['in-flight limit exceeded', 'busy'],
    ['identity quote rate limit exceeded', 'rate_limited'], ['global quote rate limit exceeded', 'rate_limited'],
    ['identity no-show limit exceeded', 'declined'], ['door busy: global no-show budget exhausted', 'declined'], ['hourly USD capacity exceeded', 'declined'],
    ['quote capacity busy', 'declined'], ['admission no longer live; request a fresh quote', 'declined'], ['quote unknown, expired, used, mismatched, or not owned', 'declined'],
  ]
  for (const [reason, code] of cases) it(`maps ${reason} with or without a retry suffix`, () => {
    const plain = mapDoorDecline(reason)
    const hinted = mapDoorDecline(`${reason} (retry after 15s)`)
    expect(plain.code).eq(code); expect(hinted.code).eq(code)
    expect(plain).not.to.have.property('retry_after_s')
    expect(hinted.retry_after_s).eq(15); expect(hinted.retry_hint).eq('retry after 15s')
    expect(plain.message).eq(`The market maker declined this request: ${reason}. Nothing was locked.`)
    expect(hinted.message).eq(`The market maker declined this request: ${reason} (retry after 15s). Nothing was locked.`)
  })

  it('ignores non-canonical retry text', () => {
    const decline = mapDoorDecline('quote capacity busy (retry after 15 seconds)')
    expect(decline).not.to.have.property('retry_after_s')
  })
})
