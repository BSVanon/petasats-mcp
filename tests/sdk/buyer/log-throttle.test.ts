import { expect } from 'chai'
import { describe, it } from 'mocha'
import { makeThrottledLog } from '../../../src/sdk/buyer/runtime/log-throttle'
import { makeRuntimeLog } from '../../../src/sdk/buyer/runtime/runtime'

describe('buyer runtime log throttle', () => {
  it('prints the first line, suppresses repeats, then reports their count after the window', () => {
    const lines: string[] = []; let at = 0
    const log = makeThrottledLog((line) => lines.push(line), { windowMs: 120_000, now: () => at })
    log('Base refund matures in 27883 block(s)')
    at = 1
    log('Base refund matures in 27882 block(s)')
    at = 120_000
    log('Base refund matures in 27881 block(s)')
    expect(lines).deep.eq([
      'Base refund matures in 27883 block(s)',
      'Base refund matures in 27881 block(s) (1 similar lines in the last 2 min)',
    ])
  })

  it('keeps lines about different swaps apart and counts repeats about the same swap', () => {
    const lines: string[] = []
    const log = makeThrottledLog((line) => lines.push(line), { now: () => 0 })
    log('in-process initiator recovery ARMED for 54be62f0a1b2… (claim)')
    log('in-process initiator recovery ARMED for 19af7551c3d4… (claim)')
    log('in-process initiator recovery TERMINAL for 19af7551c3d4… → settled (clearing the record)')
    log('in-process initiator recovery ARMED for 54be62f0a1b2… (claim)')
    log('RECOVERY NEEDS ATTENTION: cannot read settlement record 19af7551c3d4')
    log('RECOVERY NEEDS ATTENTION: cannot read settlement record 19af7551c3d4')
    expect(lines).deep.eq([
      'in-process initiator recovery ARMED for 54be62f0a1b2… (claim)',
      'in-process initiator recovery ARMED for 19af7551c3d4… (claim)',
      'in-process initiator recovery TERMINAL for 19af7551c3d4… → settled (clearing the record)',
      'RECOVERY NEEDS ATTENTION: cannot read settlement record 19af7551c3d4',
      'RECOVERY NEEDS ATTENTION: cannot read settlement record 19af7551c3d4',
    ])
  })

  it('groups numbers of any length, including across a digit-count boundary', () => {
    const lines: string[] = []
    const log = makeThrottledLog((line) => lines.push(line), { now: () => 0 })
    log('[wt] wait · Base refund matures in 99999 block(s) (base gate 53492322, ~929m)')
    log('[wt] wait · Base refund matures in 100000 block(s) (base gate 53492322, ~930m)')
    expect(lines).to.have.length(1)
  })

  it('never suppresses warning and error words', () => {
    const lines: string[] = []
    const log = makeThrottledLog((line) => lines.push(line), { now: () => 0 })
    for (const word of ['CRITICAL', 'FAILED', 'failed', 'WARN', 'warn', 'error', 'Error', 'refused', 'ATTENTION', 'cannot', '⚠', '🚨', 'STOP']) {
      log(`${word} 123456`)
      log(`${word} 123457`)
    }
    expect(lines).to.have.length(26)
  })

  it('evicts the least recently printed shape when full', () => {
    const lines: string[] = []; let at = 0
    const log = makeThrottledLog((line) => lines.push(line), { maxShapes: 2, now: () => ++at })
    log('alpha 1')
    log('beta 2')
    log('gamma 3')
    log('alpha 4')
    expect(lines).deep.eq(['alpha 1', 'beta 2', 'gamma 3', 'alpha 4'])
  })

  it('leaves a caller-provided runtime log unthrottled', () => {
    const lines: string[] = []
    const provided = (line: string): void => { lines.push(line) }
    const log = makeRuntimeLog(provided)
    expect(log).eq(provided)
    log('repeat 1')
    log('repeat 2')
    expect(lines).deep.eq(['repeat 1', 'repeat 2'])
  })
})
