import { describe, it } from 'mocha'
import { expect } from 'chai'
import { Beef, MerklePath, Peer, PrivateKey, Transaction, P2PKH, UnlockingScript, type AuthMessage, type Transport } from '@bsv/sdk'
import { makeIdentityOnlyWallet } from '../../src/sdk/buyer/runtime/identity-wallet'
import { makeBuyerBsvRails } from '../../src/sdk/buyer/runtime/bsv-rails'
import { guardBuyerEvmWrites, makeBuyerEvmRails } from '../../src/sdk/buyer/runtime/evm-rails'
import { clearTaalApiKey, setAnvilNode, setTaalApiKey } from '../../src/wallet/broadcast'
import { buildEarlySweepTx, buildSweepTx, BUYER_SWEEP_DUST_SATS } from '../../src/sdk/buyer/runtime/sweep'
import { makeQuorumChainTracker } from '../../src/wallet/quorum-chaintracks'

class MemoryTransport implements Transport {
  private callback?: (message: AuthMessage) => Promise<void>
  peer?: MemoryTransport
  async send(message: AuthMessage): Promise<void> {
    // Peer may send its response while the initiator is still awaiting this
    // transport send. Deliver on the next turn, as a real transport does.
    queueMicrotask(() => { void this.peer?.callback?.(structuredClone(message)) })
  }
  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> { this.callback = callback }
}

function pair(): [MemoryTransport, MemoryTransport] {
  const a = new MemoryTransport(); const b = new MemoryTransport(); a.peer = b; b.peer = a
  return [a, b]
}

function response(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json' } })
}

async function rejects(work: () => Promise<unknown>, pattern: RegExp | string): Promise<void> {
  let thrown: unknown
  try { await work() } catch (error) { thrown = error }
  expect(thrown).to.be.instanceOf(Error)
  expect((thrown as Error).message).to.match(typeof pattern === 'string' ? new RegExp(pattern) : pattern)
}

function rpcFetch(state: Record<string, { chain?: string; hash?: string; latest?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/\/$/, '')
    const request = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: unknown[] }
    const s = state[url] ?? {}
    if (request.method === 'eth_chainId') return response(request.id, s.chain ?? '0x2105')
    if (request.method === 'eth_blockNumber') return response(request.id, s.latest ?? '0x202')
    if (request.method === 'eth_getBlockByNumber') {
      if (request.params[0] === 'safe') return response(request.id, { number: '0x200', hash: s.hash ?? `0x${'a'.repeat(64)}` })
      if (request.params[0] === 'finalized') return response(request.id, { number: '0x200', hash: s.hash ?? `0x${'a'.repeat(64)}` })
      return response(request.id, { number: '0x202', hash: s.hash ?? `0x${'a'.repeat(64)}` })
    }
    if (request.method === 'eth_getLogs') return response(request.id, [])
    if (request.method === 'eth_getTransactionReceipt') return response(request.id, { transactionHash: `0x${'c'.repeat(64)}` })
    return response(request.id, null)
  }) as typeof fetch
}

describe('buyer runtime rails', () => {
  it('keeps live reads lenient while strict recovery reads report a rate limit as unknown', async () => {
    const calls: string[] = []
    const rails = makeBuyerBsvRails({
      anvilBaseUrl: 'https://buyer-anvil.invalid',
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return new Response('rate limited', { status: 429 })
      }) as typeof fetch,
    })
    await rejects(() => rails.txConfirmationsStrict('ab'.repeat(32)), /buyer BSV chain read unavailable.*HTTP 429/)
    // Polling is the retry loop: one attempt at each proof source, not three
    // nested retries at every 15-second confirmation poll.
    expect(calls).to.have.length(3)
    await rejects(() => rails.resolveSpenderStrict('ab'.repeat(32), 0), /spender read failed: HTTP 429/)
    await rejects(() => rails.fetchTxStrict('ab'.repeat(32)), /buyer BSV chain read unavailable.*HTTP 429/)
    await rejects(() => rails.fetchBeefStrict('ab'.repeat(32)), /buyer BSV chain read unavailable.*HTTP 429/)
    expect(await rails.resolveSpender('ab'.repeat(32), 0)).to.equal(null)
    expect(await rails.fetchTx('ab'.repeat(32))).to.equal(null)
  })

  it('retains zero as the deterministic not-mined/not-indexed answer needed for true eviction recovery', async () => {
    const rails = makeBuyerBsvRails({
      anvilBaseUrl: 'https://buyer-anvil.invalid',
      fetchImpl: (async () => new Response('not found', { status: 404 })) as typeof fetch,
    })
    expect(await rails.txConfirmations('cd'.repeat(32))).to.equal(0)
    expect(await rails.fetchTx('cd'.repeat(32))).to.equal(null)
    expect(await rails.fetchBeef!('cd'.repeat(32))).to.equal(null)
    expect(await rails.resolveSpender('cd'.repeat(32), 0)).to.equal(null)
    expect(await rails.txConfirmationsStrict('cd'.repeat(32))).to.equal(0)
    expect(await rails.fetchTxStrict('cd'.repeat(32))).to.equal(null)
    expect(await rails.fetchBeefStrict('cd'.repeat(32))).to.equal(null)
    expect(await rails.resolveSpenderStrict('cd'.repeat(32), 0)).to.equal(null)
  })

  it('keeps a live confirmation height read failure lenient but exposes it to recovery', async () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1 })
    const txid = tx.id('hex')
    tx.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: txid, txid: true }]])
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const rails = makeBuyerBsvRails({
      anvilBaseUrl: 'https://buyer-anvil.invalid',
      fetchImpl: (async (input: RequestInfo | URL) => String(input).includes(`/tx/${txid}/beef`)
        ? new Response(new Uint8Array(beef.toBinary() as number[]))
        : new Response('rate limited', { status: 429 })) as typeof fetch,
    })
    expect(await rails.txConfirmations(txid)).to.equal(0)
    await rejects(() => rails.txConfirmationsStrict(txid), /confirmation height is unavailable/)
  })

  it('keeps the executor fetchTx on the raw reader so it finds an unmined lock', async () => {
    const lock = new Transaction()
    lock.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 10_000 })
    const calls: string[] = []
    const rails = makeBuyerBsvRails({
      anvilBaseUrl: 'https://buyer-anvil.invalid',
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input); calls.push(url)
        return url.includes('/hex') ? new Response(lock.toHex()) : new Response('not found', { status: 404 })
      }) as typeof fetch,
    })
    const fetched = await rails.fetchTx(lock.id('hex'))
    expect(fetched?.id('hex')).to.equal(lock.id('hex'))
    expect(fetched?.merklePath).to.equal(undefined)
    expect(calls.some((url) => url.includes('/hex'))).to.equal(true)
  })

  it('identity wallet completes a BRC-31 Peer handshake over an in-memory transport', async () => {
    const [at, bt] = pair()
    const a = new Peer(makeIdentityOnlyWallet(PrivateKey.fromRandom()), at)
    const bWallet = makeIdentityOnlyWallet(PrivateKey.fromRandom())
    const b = new Peer(bWallet, bt)
    let received: number[] | undefined
    b.listenForGeneralMessages((_from, message) => { received = message })
    const bId = (await bWallet.getPublicKey({ identityKey: true })).publicKey
    await a.toPeer([1, 2, 3], bId)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(received).to.deep.equal([1, 2, 3])
  })

  it('identity wallet rejects every non-cryptographic wallet operation without exposing a key', async () => {
    const key = PrivateKey.fromRandom(); const wallet = makeIdentityOnlyWallet(key) as any
    for (const method of ['createAction', 'signAction', 'abortAction', 'listActions', 'internalizeAction', 'listOutputs', 'relinquishOutput', 'acquireCertificate', 'listCertificates', 'proveCertificate', 'relinquishCertificate', 'discoverByIdentityKey', 'discoverByAttributes', 'isAuthenticated', 'waitForAuthentication', 'getHeight', 'getHeaderForHeight', 'getNetwork', 'getVersion']) {
      await rejects(() => wallet[method]({}), 'not supported by the buyer kit identity wallet')
    }
  })

  it('keyless BSV ladder clears an inherited TAAL credential and attaches neither Authorization nor API-key headers', async () => {
    const saved = globalThis.fetch
    const seen: HeadersInit[] = []
    setTaalApiKey('credential-from-an-earlier-embedding-client')
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.headers ?? {})
      const url = String(input)
      if (url.includes('whatsonchain.com')) return new Response(`"${'ab'.repeat(32)}"`, { headers: { 'content-type': 'application/json' } })
      // Force the ARC tier to fail. Before the buyer clears TAAL this causes a
      // TAAL request carrying the inherited bearer credential.
      return new Response(JSON.stringify({}), { status: 500, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const rails = makeBuyerBsvRails({ fetchImpl: globalThis.fetch })
      await rails.broadcast('01000000000000000000')
      expect(seen.some((headers) => JSON.stringify(headers).toLowerCase().includes('authorization') || JSON.stringify(headers).toLowerCase().includes('api-key'))).eq(false)
    } finally { clearTaalApiKey(); globalThis.fetch = saved }
  })

  it('keeps a TAAL key set after construction out of buyer broadcasts', async () => {
    const saved = globalThis.fetch; const seen: Array<{ url: string; headers: HeadersInit }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); seen.push({ url, headers: init?.headers ?? {} })
      if (url.includes('whatsonchain.com')) return new Response(`"${'ab'.repeat(32)}"`)
      return new Response(JSON.stringify({}), { status: 500, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const rails = makeBuyerBsvRails({ anvilBaseUrl: 'https://buyer-anvil.invalid', fetchImpl: globalThis.fetch })
      setTaalApiKey('synthetic-key')
      setAnvilNode('https://other-anvil.invalid', 'synthetic-anvil-token')
      await rails.broadcast('01000000000000000000')
      expect(seen.some(({ url }) => url.includes('arc.taal.com'))).eq(false)
      expect(seen.some(({ headers }) => JSON.stringify(headers).includes('synthetic-key'))).eq(false)
      expect(seen.some(({ headers }) => JSON.stringify(headers).includes('synthetic-anvil-token'))).eq(false)
      expect(seen.some(({ url }) => url.startsWith('https://other-anvil.invalid'))).eq(false)
      expect(seen.some(({ url }) => url.startsWith('https://buyer-anvil.invalid/'))).eq(true)
    } finally { clearTaalApiKey(); setAnvilNode('https://buyer-anvil.invalid'); globalThis.fetch = saved }
  })

  it('submits ordinary BEEF to GorillaPool ARC from the buyer-kit broadcast path', async () => {
    const rawTx = '01000000000000000000'
    const atomicBeefHex = Transaction.fromHex(rawTx).toHexAtomicBEEF()
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const saved = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); requests.push({ url, init })
      if (url.includes('buyer-anvil.invalid/broadcast')) {
        return new Response('{}', { status: 422, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('arc.gorillapool.io/v1/tx')) {
        return new Response(JSON.stringify({ txid: 'ef'.repeat(32), txStatus: 'SEEN_ON_NETWORK' }), { headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const rails = makeBuyerBsvRails({ anvilBaseUrl: 'https://buyer-anvil.invalid', fetchImpl: globalThis.fetch })
      expect(await rails.broadcast(rawTx, atomicBeefHex)).to.equal('ef'.repeat(32))

      const arc = requests.find(({ url }) => url === 'https://arc.gorillapool.io/v1/tx')
      expect(arc).to.not.equal(undefined)
      expect(arc!.init?.method).to.equal('POST')
      expect(arc!.init?.headers).to.deep.equal({ 'Content-Type': 'application/json' })
      expect(arc!.init?.body).to.equal(JSON.stringify({ rawTx: Transaction.fromHex(rawTx).toHexBEEF() }))
    } finally { clearTaalApiKey(); setAnvilNode(''); globalThis.fetch = saved }
  })

  it('rechecks Base pool safety at each approval and lock write boundary', async () => {
    let safe = true; const writes: string[] = []; const checks: string[] = []
    const raw = {
      approve: async () => { writes.push('approve'); return { hash: '0xapprove', status: 'success' as const } },
      lock: async () => { writes.push('lock'); return { hash: '0xlock', status: 'success' as const } },
    } as any
    const guarded = guardBuyerEvmWrites(raw, () => { checks.push('check'); if (!safe) throw new Error('pool became split') })
    await guarded.approve(('0x' + '1'.repeat(40)) as `0x${string}`, 1n)
    safe = false
    await rejects(() => guarded.lock({} as any), /pool became split/)
    expect(checks).deep.eq(['check', 'check']); expect(writes).deep.eq(['approve'])
  })

  it('GATE: a nonce burn is also refused on a split Base pool', async () => {
    const writes: string[] = []
    const raw = { consumeNonce: async () => { writes.push('burn'); return '0xburn' } } as any
    const guarded = guardBuyerEvmWrites(raw, () => { throw new Error('pool became split') })
    await rejects(() => (guarded as any).consumeNonce(4), /pool became split/)
    expect(writes).deep.eq([])
  })

  it('header quorum refuses disagreement and a down source', async () => {
    const good = { currentHeight: async () => 10, isValidRootForHeight: async () => true }
    const bad = { currentHeight: async () => 10, isValidRootForHeight: async () => false }
    const down = { currentHeight: async () => { throw new Error('down') }, isValidRootForHeight: async () => { throw new Error('down') } }
    expect(await makeQuorumChainTracker([good, bad] as any, 2).isValidRootForHeight('x', 1)).eq(false)
    expect(await makeQuorumChainTracker([good, down] as any, 2).isValidRootForHeight('x', 1)).eq(false)
  })

  it('EVM factory re-probes and rejects a primary endpoint that forks or lags after startup', async () => {
    const key = (`0x${'11'.repeat(32)}`) as `0x${string}`; const swap = (`0x${'22'.repeat(20)}`) as `0x${string}`
    await rejects(() => makeBuyerEvmRails({ privateKey: key, swapAddress: swap, usdcTokenAddress: swap, rpcUrls: ['http://wrong.test'], fetchImpl: rpcFetch({ 'http://wrong.test': { chain: '0x1' } }) }), /no endpoint|chain mismatch/)
    const state: Record<string, { hash?: string; latest?: string }> = { 'http://one.test': {}, 'http://two.test': {} }
    const rails = await makeBuyerEvmRails({ privateKey: key, swapAddress: swap, usdcTokenAddress: swap, rpcUrls: ['http://one.test', 'http://two.test'], fetchImpl: rpcFetch(state) })
    state['http://two.test'].hash = `0x${'b'.repeat(64)}`
    await rejects(() => rails.assertSafeForNewLock(), /split or unverified/)
    state['http://two.test'].hash = `0x${'a'.repeat(64)}`
    state['http://one.test'].latest = '0x100'
    await rejects(() => rails.assertSafeForNewLock(), /split or unverified/)
  })

  it('buildSweepTx spends exactly requested confirmed coins, charges a fee, and refuses unsafe input', async () => {
    const key = PrivateKey.fromRandom(); const from = key.toPublicKey().toAddress(); const to = PrivateKey.fromRandom().toPublicKey().toAddress()
    const parent = new Transaction(); parent.addOutput({ lockingScript: new P2PKH().lock(from), satoshis: 10_000 })
    const coin = { tx_hash: parent.id('hex') as string, tx_pos: 0, value: 10_000, height: 1, confirmations: 1, sourceTx: parent }
    const result = await buildSweepTx({ coins: [coin], toAddress: to, key, feeRate: 100 })
    expect(result.tx.inputs).to.have.length(1); expect(result.tx.outputs).to.have.length(1); expect(result.fee).gt(0)
    await rejects(() => buildSweepTx({ coins: [{ ...coin, confirmations: 0 }], toAddress: to, key, feeRate: 100 }), /fewer than 1/)
    await rejects(() => buildSweepTx({ coins: [coin], toAddress: 'not-an-address', key, feeRate: 100 }), /valid BSV P2PKH/)
    const dustParent = new Transaction(); dustParent.addOutput({ lockingScript: new P2PKH().lock(from), satoshis: BUYER_SWEEP_DUST_SATS + 1 })
    await rejects(() => buildSweepTx({ coins: [{ ...coin, tx_hash: dustParent.id('hex') as string, value: BUYER_SWEEP_DUST_SATS + 1, sourceTx: dustParent }], toAddress: to, key, feeRate: 100 }), /dust/)
  })

  it('F3: the early sweep spends only claim outputs paying the kit and skips a claim with none', async () => {
    const key = PrivateKey.fromRandom(); const kit = key.toPublicKey().toAddress(); const external = PrivateKey.fromRandom().toPublicKey().toAddress(); const to = PrivateKey.fromRandom().toPublicKey().toAddress()
    const lock = new Transaction(); lock.addOutput({ lockingScript: new P2PKH().lock(external), satoshis: 30_000 }); lock.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: lock.id('hex'), txid: true }, { offset: 1, duplicate: true }]])
    const claim = new Transaction(); claim.addInput({ sourceTXID: lock.id('hex') as string, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() }); claim.inputs[0].sourceTransaction = lock
    claim.addOutput({ lockingScript: new P2PKH().lock(kit), satoshis: 12_000 }); claim.addOutput({ lockingScript: new P2PKH().lock(external), satoshis: 12_000 }); claim.addOutput({ lockingScript: new P2PKH().lock(kit), satoshis: 5_000 })
    const built = await buildEarlySweepTx({ claim, claimTxid: claim.id('hex') as string, toAddress: to, key, feeRate: 100, chainTracker: { currentHeight: async () => 800_000, isValidRootForHeight: async () => true } as any })
    expect(built.tx.inputs.map((input) => input.sourceOutputIndex)).deep.eq([0, 2])
    const noKit = Transaction.fromHex(claim.toHex()); noKit.inputs[0].sourceTransaction = lock; noKit.outputs.forEach((output) => { output.lockingScript = new P2PKH().lock(external) })
    await rejects(() => buildEarlySweepTx({ claim: noKit, claimTxid: noKit.id('hex') as string, toAddress: to, key, feeRate: 100, chainTracker: { currentHeight: async () => 800_000, isValidRootForHeight: async () => true } as any }), /no kit P2PKH/)
  })

  it('F4: the early sweep fails closed without a valid lock merkle proof', async () => {
    const key = PrivateKey.fromRandom(); const kit = key.toPublicKey().toAddress(); const to = PrivateKey.fromRandom().toPublicKey().toAddress()
    const lock = new Transaction(); lock.addOutput({ lockingScript: new P2PKH().lock(kit), satoshis: 30_000 })
    const claim = new Transaction(); claim.addInput({ sourceTXID: lock.id('hex') as string, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() }); claim.inputs[0].sourceTransaction = lock; claim.addOutput({ lockingScript: new P2PKH().lock(kit), satoshis: 20_000 })
    const options = { claim, claimTxid: claim.id('hex') as string, toAddress: to, key, feeRate: 100 }
    await rejects(() => buildEarlySweepTx({ ...options, chainTracker: {} as any }), /no merkle proof/)
    lock.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: lock.id('hex'), txid: true }, { offset: 1, duplicate: true }]])
    await rejects(() => buildEarlySweepTx({ ...options, chainTracker: { currentHeight: async () => 800_000, isValidRootForHeight: async () => false } as any }), /merkle proof failed/)
  })

  it('F11: the early sweep Atomic BEEF carries the unmined claim and merkle-proven lock, spends kit outputs, and pays deliverTo', async () => {
    const key = PrivateKey.fromRandom(); const kit = key.toPublicKey().toAddress(); const deliverTo = PrivateKey.fromRandom().toPublicKey().toAddress()
    const lock = new Transaction(); lock.addOutput({ lockingScript: new P2PKH().lock(kit), satoshis: 30_000 }); lock.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: lock.id('hex'), txid: true }, { offset: 1, duplicate: true }]])
    // A locally signed P2PKH spend stands in for the production covenant claim.
    const claim = new Transaction(); claim.addInput({ sourceTransaction: lock, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key, 'all', false) })
    claim.addOutput({ lockingScript: new P2PKH().lock(kit), satoshis: 15_000 }); claim.addOutput({ lockingScript: new P2PKH().lock(kit), satoshis: 10_000 })
    await claim.sign()
    const built = await buildEarlySweepTx({ claim, claimTxid: claim.id('hex') as string, toAddress: deliverTo, key, feeRate: 100, chainTracker: { currentHeight: async () => 800_000, isValidRootForHeight: async () => true } as any })
    const outbox = { rawTx: built.rawTx, atomicBeefHex: built.atomicBeefHex, txid: built.tx.id('hex') as string }
    const decoded = Transaction.fromAtomicBEEF(Array.from(Buffer.from(built.atomicBeefHex, 'hex')))
    expect(Transaction.fromHex(outbox.rawTx).id('hex')).eq(outbox.txid); expect(decoded.id('hex')).eq(outbox.txid); expect(decoded.inputs).to.have.length(2); expect(decoded.outputs[0].lockingScript.toHex()).eq(new P2PKH().lock(deliverTo).toHex())
    expect(decoded.inputs.every((input) => input.sourceTransaction?.id('hex') === claim.id('hex'))).eq(true)
    expect(decoded.inputs[0].sourceTransaction?.inputs[0].sourceTransaction?.merklePath).not.eq(undefined)
  })

  it('never includes a private key or WIF in buyer-rail errors', async () => {
    const key = PrivateKey.fromRandom(); const wif = key.toWif(); const hex = key.toString('hex')
    let error: unknown
    try { await buildSweepTx({ coins: [], toAddress: 'bad', key, feeRate: 1 }) } catch (caught) { error = caught }
    const message = (error as Error).message
    expect(message).not.to.include(wif); expect(message).not.to.include(hex)
  })
})
