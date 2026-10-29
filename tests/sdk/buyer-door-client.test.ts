import { describe, it } from 'mocha'
import { expect } from 'chai'
import { mapDoorDecline } from '../../src/sdk/buyer/door-client'

describe('buyer door decline mapping', () => {
  const cases: Array<[string, string]> = [
    ['pricer declined quote', 'unavailable'], ['pricer did not bind the requested USDC amount', 'unavailable'], ['quote unavailable', 'unavailable'],
    ['swap admission unavailable', 'unavailable'], ['admission store write failed', 'unavailable'], ['kill-switch engaged', 'unavailable'],
    ['per-swap limit exceeded', 'limit'], ['identity count limit exceeded', 'limit'], ['identity USD limit exceeded', 'limit'],
    ['global count limit exceeded', 'busy'], ['global USD limit exceeded', 'busy'], ['admissions/hour limit exceeded', 'busy'], ['in-flight limit exceeded', 'busy'],
    ['identity quote rate limit exceeded', 'rate_limited'], ['global quote rate limit exceeded', 'rate_limited'],
  ]
  for (const [reason, code] of cases) it(`maps ${reason}`, () => expect(mapDoorDecline(reason).code).eq(code))
})
