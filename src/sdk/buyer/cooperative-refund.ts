import type { Erc20SwapEvmClient } from '../../bridge/evm/client'
import { baseRefundParamsFromRecord, baseResolutionAnchorFromRecord } from '../../bridge/watchtower-adapters'
import type { SettlementRecord } from '../../bridge/settlement-session'

type CooperativeRefundRails = Pick<Erc20SwapEvmClient, 'finalizedBlockNumber' | 'resolveSwapOutcome'> & {
  isSwapLocked(params: ReturnType<typeof baseRefundParamsFromRecord>, opts: { blockNumber: bigint }): Promise<boolean>
}

export type CooperativeRefundResolution =
  | { kind: 'none'; record: SettlementRecord }
  | { kind: 'refunded'; record: SettlementRecord; eventTxid: string }
  | { kind: 'claimed'; record: SettlementRecord; eventTxid: string }

const sameRecord = (a: SettlementRecord, b: SettlementRecord): boolean => JSON.stringify(a) === JSON.stringify(b)

const mayClassify = (record: SettlementRecord): boolean =>
  (record.state === 'base-locked' || record.state === 'bsv-locked' || record.state === 'refunding') &&
  !record.bsvClaimTxid && !record.bsvClaimTxHex && !record.bsvClaimBeefHex

export async function resolveCooperativeRefund(record: SettlementRecord, deps: {
  evm?: Partial<CooperativeRefundRails>
  now: () => number
  reread: (hashHex: string) => SettlementRecord | undefined
  persist: (record: SettlementRecord) => void
  assertPoolSafe: () => void | Promise<void>
}): Promise<CooperativeRefundResolution> {
  if (!mayClassify(record) || !deps.evm?.finalizedBlockNumber || !deps.evm.resolveSwapOutcome || !deps.evm.isSwapLocked) {
    return { kind: 'none', record }
  }
  try {
    const resolutionAnchor = baseResolutionAnchorFromRecord(record)
    if (!resolutionAnchor) return { kind: 'none', record }
    const finalized = await deps.evm.finalizedBlockNumber()
    if (typeof finalized !== 'bigint' || finalized <= 0n) return { kind: 'none', record }
    const params = baseRefundParamsFromRecord(record)
    if (await deps.evm.isSwapLocked(params, { blockNumber: finalized })) return { kind: 'none', record }
    const outcome = await deps.evm.resolveSwapOutcome(params, resolutionAnchor)
    if (outcome.kind === 'claimed') return { kind: 'claimed', record, eventTxid: outcome.eventTxid }
    if (outcome.kind !== 'refunded') return { kind: 'none', record }

    // A concurrent reveal/refund updater wins over this observation. The pool fence is deliberately after every read
    // and immediately before the terminal write, matching the unlanded-lock tombstone discipline.
    const current = deps.reread(record.hashHex)
    if (!current || !sameRecord(current, record) || !mayClassify(current)) return { kind: 'none', record: current ?? record }
    await deps.assertPoolSafe()
    const latest = deps.reread(record.hashHex)
    if (!latest || !sameRecord(latest, record) || !mayClassify(latest)) return { kind: 'none', record: latest ?? record }
    const at = Math.max(Math.floor(deps.now() / 1000), latest.history.at(-1)?.at ?? 0)
    const refunded: SettlementRecord = {
      ...latest,
      state: 'refunded',
      refundTxid: outcome.eventTxid,
      history: latest.state === 'refunding'
        ? [...latest.history, { state: 'refunded', at }]
        : [...latest.history, { state: 'refunding', at }, { state: 'refunded', at }],
    }
    deps.persist(refunded)
    return { kind: 'refunded', record: refunded, eventTxid: outcome.eventTxid }
  } catch {
    // Unavailable or unsafe finalized evidence is never a reason to alter the local record.
    return { kind: 'none', record }
  }
}
