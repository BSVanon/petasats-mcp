// Behind the kit's own destination rules, its Base rails refuse a `to` that is not a 0x-prefixed 20-byte hex address
// before any pricing, signing or record: the real signing client, wrapped as the kit's rails wrap it, on a transport
// that records every request and reaches no network.
import { expect } from 'chai'
import { custom } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { BASE_USDC } from '../../../src/bridge/evm/base-tokens'
import { Erc20SwapEvmClient } from '../../../src/bridge/evm/client'
import { ERC20_SWAP } from '../../../src/bridge/evm/erc20swap'
import { buyerBaseChain } from '../../../src/bridge/evm/tip-floor'
import { guardBuyerEvmWrites } from '../../../src/sdk/buyer/runtime/evm-rails'

const FORMAT = 'to must be a non-zero checksummed Base address'

async function rejection(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { return error instanceof Error ? error.message : String(error) }
  return 'resolved'
}

describe('buyer kit Base rails: the destination', () => {
  it('U3 a Base ETH or USDC transfer, and the ETH pricing, refuse a missing or malformed to before any request, pool check or signature', async () => {
    const requests: string[] = []
    const transport = custom({ request: async ({ method }: { method: string }) => { requests.push(method); throw new Error('no network in this test') } }, { retryCount: 0 })
    const throwaway = generatePrivateKey()
    const raw = new Erc20SwapEvmClient({
      rpcUrl: 'http://synthetic.invalid', privateKey: throwaway, swapAddress: ERC20_SWAP.deployments.baseMainnet.address,
      pinnedTokenAddresses: [BASE_USDC], chain: buyerBaseChain, transport,
    })
    let poolChecks = 0
    const rails = guardBuyerEvmWrites(raw, () => { poolChecks++ })
    const recorded: unknown[] = []
    const onRecorded = (signed: unknown): void => { recorded.push(signed) }
    const malformed = [undefined, null, '', 0, {}, '0x1234', `0x${'1'.repeat(39)}`, `0x${'1'.repeat(41)}`, '1'.repeat(42), `0x${'g'.repeat(40)}`, ` 0x${'1'.repeat(40)}`]
    for (const to of malformed) {
      const label = JSON.stringify(to) ?? 'undefined'
      expect(await rejection(rails.transferNative(to as never, 123_456n, { onRecorded })), `ETH ${label}`).eq(FORMAT)
      expect(await rejection(rails.transferErc20(BASE_USDC, to as never, 1n, { onRecorded })), `USDC ${label}`).eq(FORMAT)
      expect(await rejection(rails.priceNativeTransfer(to as never)), `pricing ${label}`).eq(FORMAT)
    }
    expect({ requests, poolChecks, recorded }).deep.eq({ requests: [], poolChecks: 0, recorded: [] })

    // A well-formed address goes past the check (to the pool check for a transfer, and on to the RPC).
    const valid = `0x${'3'.repeat(40)}` as const
    expect(await rejection(rails.priceNativeTransfer(valid))).not.eq(FORMAT)
    expect(await rejection(rails.transferNative(valid, 1n))).not.eq(FORMAT)
    expect(poolChecks).eq(1)
    expect(requests.length).gt(0)
    // Without the rails check the same client takes a missing `to` on toward signing: the check is what stops it.
    requests.length = 0
    expect(await rejection(raw.transferNative(undefined as never, 123_456n))).not.eq(FORMAT)
    expect(requests.length).gt(0)
  })
})
