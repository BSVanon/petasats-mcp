// Which close-down refusals carry retry_after_seconds: errors only the user can clear (a kit record or coin that is not
// valid, a filesystem refusal, a send that reverted on chain, a custom kit missing a capability) carry none.
// Import each module directly, not the buyer index: the public export ships these modules but not the index.
import { expect } from 'chai'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createBuyerKit } from '../../../src/sdk/buyer/buyer-kit'
import { closeKitStep } from '../../../src/sdk/buyer/close'
import type { BuyerKit } from '../../../src/sdk/buyer/types'
import { makeBuyerWithdrawalIntents, type BuyerWithdrawalRails } from '../../../src/sdk/buyer/withdrawal-intent'
import { OWN_BASE, OWN_BSV, PAIR, fakeKit, home, walletInfoOf, writeCloseFile, writeWithdrawalIntent, type FakeState } from './close-helpers'

const fsError = (code: string): Error => Object.assign(new Error(`${code}: operation refused, rename 'close.json'`), { code })
const refusal = (step: Awaited<ReturnType<typeof closeKitStep>>): { reason?: string; retry?: number } =>
  step.state === 'refused' ? { reason: step.reason, retry: step.retry_after_seconds } : { reason: `not refused: ${step.state}` }

describe('buyer kit close-down: refusals only the user can clear', () => {
  it('S6 an invalid kit record, a coin that is not the kit\'s, a filesystem refusal or a reverted send carries no retry_after', async () => {
    const needsUser: Error[] = [
      new Error('invalid Base withdrawal record'), new Error(`buyer sweep: source output is not a kit P2PKH coin for ${'ab'.repeat(32)}:0`),
      new Error('Base USDC transfer reverted'), new Error('Base ETH transfer reverted'), new Error('invalid buyer swap quote field amountIn'),
      new Error('unsafe local file /tmp/kit/swaps/a.json; replace it with a regular file and chmod 600 /tmp/kit/swaps/a.json'),
      new Error('unsafe permissions on /tmp/kit/withdrawals/a.json; run chmod 600 /tmp/kit/withdrawals/a.json'),
      ...['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EISDIR', 'ENOTDIR'].map(fsError),
    ]
    // A file that went away between two reads, or a SyntaxError from an indexer's reply, is still brief.
    const brief: Error[] = [fsError('ENOENT'), new SyntaxError('Unexpected token < in JSON at position 0')]
    for (const error of [...needsUser, ...brief]) {
      for (const where of ['usdc', 'bsv', 'walletInfo'] as const) {
        const paths = home()
        const state: FakeState = { usdc: where === 'usdc' ? 1n : 0n, eth: 0n, claimedBsvSats: where === 'bsv' ? 5000n : 0n, swaps: [] }
        const fail = async (): Promise<never> => { throw error }
        const { kit } = fakeKit(paths, state, where === 'usdc' ? { withdrawBase: fail } : where === 'bsv' ? { withdrawBsv: fail } : { walletInfo: fail })
        const label = `${where}: ${error.message}`
        expect(refusal(await closeKitStep({ kit, paths }, PAIR)), label).deep.eq({ reason: error.message, retry: needsUser.includes(error) ? undefined : 60 })
      }
    }
  })

  it('S6 a kit record that does not parse, read by the close-down itself, carries no retry_after', async () => {
    // A withdrawal record that is not JSON, in the kit folder.
    const paths = home()
    const file = join(paths.withdrawalsDir, `0x${'e'.repeat(64)}.json`)
    writeFileSync(file, '{"asset": "USDC",')
    chmodSync(file, 0o600)
    const { kit, calls } = fakeKit(paths, { usdc: 1n, eth: 0n, claimedBsvSats: 0n, swaps: [] })
    const corrupt = refusal(await closeKitStep({ kit, paths }, PAIR))
    expect(corrupt.reason).match(/JSON/)
    expect(corrupt.retry).eq(undefined)
    expect(calls.withdrawBase).deep.eq([])
    // A swap record that does not parse: the kit's status() reads it from the kit folder.
    const swaps = home()
    const { kit: base } = fakeKit(swaps, { usdc: 1n, eth: 0n, claimedBsvSats: 0n, swaps: [] })
    const swapKit: BuyerKit = { ...base, status: async () => { throw new SyntaxError('Unexpected end of JSON input') } }
    expect(refusal(await closeKitStep({ kit: swapKit, paths: swaps }, PAIR))).deep.eq({ reason: 'Unexpected end of JSON input', retry: undefined })
    // A record that fails its checks is refused the same way.
    const invalid = home()
    writeWithdrawalIntent(invalid, `0x${'f'.repeat(64)}`, 'USDC', PAIR.baseAddress, { amount: '01' })
    const { kit: invalidKit } = fakeKit(invalid, { usdc: 1n, eth: 0n, claimedBsvSats: 0n, swaps: [] })
    expect(refusal(await closeKitStep({ kit: invalidKit, paths: invalid }, PAIR))).deep.eq({ reason: 'invalid Base withdrawal record', retry: undefined })
  })

  it('S6 the archive rename onto a folder (EISDIR) carries no retry_after and sends nothing', async () => {
    const paths = home()
    writeCloseFile(paths, { baseAddress: PAIR.baseAddress, bsvAddress: PAIR.bsvAddress, startedAt: 1, sends: [], final: { usdc: '0', eth_wei: '0', bsv_sats: '0' }, closedAt: 77 })
    mkdirSync(join(paths.home, 'close-77.json'))
    const { kit, calls } = fakeKit(paths, { usdc: 1n, eth: 0n, claimedBsvSats: 0n, swaps: [] })
    const step = refusal(await closeKitStep({ kit, paths }, PAIR))
    expect(step.reason).match(/^EISDIR/)
    expect(step.retry).eq(undefined)
    expect(calls.withdrawBase).deep.eq([])
  })

  it('N4 a custom kit without the destination checks or the unconfirmed BSV report is refused, with no retry, before anything is pinned or sent', async () => {
    for (const lacking of ['assertWithdrawDestinations', 'unconfirmedBsvSats'] as const) {
      const paths = home()
      const state: FakeState = { usdc: 1n, eth: 1n, claimedBsvSats: 5000n, swaps: [] }
      const { kit: full, calls } = fakeKit(paths, state)
      const kit = (lacking === 'assertWithdrawDestinations'
        ? { ...full, assertWithdrawDestinations: undefined }
        : { ...full, walletInfo: async () => ({ ...walletInfoOf(state), unconfirmedBsvSats: undefined }) }) as unknown as BuyerKit
      const reason = lacking === 'assertWithdrawDestinations' ? 'close_kit destination checks are not configured' : 'unconfirmed BSV reporting is not configured'
      expect(refusal(await closeKitStep({ kit, paths }, PAIR)), lacking).deep.eq({ reason, retry: undefined })
      expect(existsSync(join(paths.home, 'close.json')), `${lacking}: nothing is pinned`).eq(false)
      expect([calls.withdrawBase, calls.withdrawBsv], `${lacking}: nothing is sent`).deep.eq([[], 0])
    }
  })

  it('N4 the kit\'s walletInfo refuses a wallet that does not report unconfirmed BSV, so close_kit does too', async () => {
    const fail = (): Promise<never> => Promise.reject(new Error('not used'))
    const kit = createBuyerKit({}, {
      door: { quote: fail, admit: fail } as never,
      executor: { execute: async () => ({ ok: true }) } as never,
      store: { list: async () => [], get: async () => undefined, put: async () => undefined },
      wallet: { baseAddress: OWN_BASE, bsvAddress: OWN_BSV, balances: async () => ({ usdc: 1n, eth: 1n, claimedBsvSats: 0n }) },
    })
    let message = 'resolved'
    try { await kit.walletInfo() } catch (error) { message = (error as Error).message }
    expect(message).eq('unconfirmed BSV reporting is not configured')
    const paths = home()
    expect(refusal(await closeKitStep({ kit, paths }, PAIR))).deep.eq({ reason: message, retry: undefined })
    expect(existsSync(join(paths.home, 'close.json')), 'nothing is pinned').eq(false)
  })

  it("a consumed-nonce warning from a real withdrawal-intent setup, surfaced through reconcileWithdrawals, carries no retry_after", async () => {
    const paths = home()
    const nonceHash = `0x${'a'.repeat(64)}` as `0x${string}`
    // Built inline, not imported from ../buyer-withdrawal-fake (that module imports the buyer index, which this
    // test file's own header forbids: the exporter then drops the whole file, B1). No receipt and a finalized
    // nonce one past the recorded withdrawal's nonce is what withdrawal-intent.ts treats as a consumed nonce.
    const rails: BuyerWithdrawalRails = {
      receipt: async () => undefined,
      finalizedBlockNumber: async () => 100n,
      nonceAtBlock: async () => 5,
      resendSigned: async () => { throw new Error('resendSigned should not be called: this record has no cancels') },
    }
    const intents = makeBuyerWithdrawalIntents(paths, rails)
    await intents.record({ asset: 'USDC', to: PAIR.baseAddress, amount: 1n, hash: nonceHash, signedTx: `0x${'b'.repeat(64)}`, nonce: 4 })
    const fail = (): Promise<never> => Promise.reject(new Error('not used'))
    const kit = createBuyerKit({}, {
      door: { quote: fail, admit: fail } as never,
      executor: { execute: async () => ({ ok: true }) } as never,
      withdrawalIntents: intents,
      store: { list: async () => [], get: async () => undefined, put: async () => undefined },
      wallet: { baseAddress: OWN_BASE, bsvAddress: OWN_BSV, balances: async () => ({ usdc: 0n, eth: 0n, claimedBsvSats: 0n, unconfirmedBsvSats: 0n }) },
    })
    const step = refusal(await closeKitStep({ kit, paths }, PAIR))
    expect(step.reason).match(/used its nonce but its receipt was not found/)
    expect(step.retry).eq(undefined)
  })

  it('the same pattern-based classification already in NEEDS_THE_USER also applies inside the reconcile catch', async () => {
    const paths = home()
    writeWithdrawalIntent(paths, `0x${'c'.repeat(64)}`, 'USDC', PAIR.baseAddress)
    const { kit } = fakeKit(paths, { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }, { reconcileWithdrawals: async () => { throw new Error('invalid Base withdrawal record') } })
    expect(refusal(await closeKitStep({ kit, paths }, PAIR))).deep.eq({ reason: 'invalid Base withdrawal record', retry: undefined })
  })

  it('m3 the cancel-outcome refusals (gas to cancel, retry limit, unsupported runtime) also carry no retry_after, message unchanged', async () => {
    // The exact wording withdrawal-intent.ts's cancelResultMessage throws at :153, :154 and :156 (not changed by
    // this round); NEEDS_THE_USER in close.ts now matches each one so step e refuses instead of retrying forever.
    const cancelHash = `0x${'a'.repeat(64)}`
    const messages = [
      `the account cannot pay the gas to cancel the refused withdrawal ${cancelHash}. Add a little ETH for Base gas, then call again. The kit will then complete or cancel it, never both. Nothing new was sent.`,
      `the previous Base withdrawal ${cancelHash} could not be cancelled after 3 attempts. It stays recorded. Nothing new was sent.`,
      `this kit runtime cannot cancel the refused Base withdrawal ${cancelHash}. The withdrawal stays recorded and blocks new money until it is resolved. Nothing new was sent.`,
    ]
    for (const message of messages) {
      const paths = home()
      writeWithdrawalIntent(paths, `0x${'c'.repeat(64)}`, 'USDC', PAIR.baseAddress)
      const { kit } = fakeKit(paths, { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }, { reconcileWithdrawals: async () => { throw new Error(message) } })
      expect(refusal(await closeKitStep({ kit, paths }, PAIR)), message).deep.eq({ reason: message, retry: undefined })
    }
  })

  it('m3 "being cancelled" stays in_progress with 60 seconds: it clears with time, so it is not a refusal', async () => {
    // withdrawal-intent.ts's beingCancelled message (:150), deliberately not added to NEEDS_THE_USER.
    const cancelHash = `0x${'a'.repeat(64)}`
    const message = `the previous Base withdrawal ${cancelHash} is being cancelled at its nonce (cancellation not yet confirmed). Try again after the cancellation is final on Base. Nothing new was sent.`
    const paths = home()
    writeWithdrawalIntent(paths, `0x${'c'.repeat(64)}`, 'USDC', PAIR.baseAddress)
    const { kit } = fakeKit(paths, { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }, { reconcileWithdrawals: async () => { throw new Error(message) } })
    const step = await closeKitStep({ kit, paths }, PAIR)
    expect(step.state).eq('in_progress')
    if (step.state === 'in_progress') expect(step.call_again_after_seconds).eq(60)
  })

  it('a brief, unclassified error from reconcile still gets another try, not a refusal', async () => {
    const paths = home()
    writeWithdrawalIntent(paths, `0x${'d'.repeat(64)}`, 'USDC', PAIR.baseAddress)
    const { kit } = fakeKit(paths, { usdc: 0n, eth: 0n, claimedBsvSats: 0n, swaps: [] }, { reconcileWithdrawals: async () => { throw new Error('the indexer timed out') } })
    const step = await closeKitStep({ kit, paths }, PAIR)
    expect(step.state).eq('in_progress')
    if (step.state === 'in_progress') expect(step.call_again_after_seconds).eq(60)
  })
})
