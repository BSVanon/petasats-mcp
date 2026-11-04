import type { SettlementState } from '../../bridge/settlement-session'
import type { BuyerExecutor, BuyerQuote, BuyerSwapRecord, BuyerSwapStage, DoorClient, SettlementMode, SettlementModeUsed, SettlementSpeed, StartSwapRequest } from './types'

type WriteRecord = (record: BuyerSwapRecord, stage: BuyerSwapStage, extra?: Partial<BuyerSwapRecord>) => Promise<BuyerSwapRecord>

export function requestedSettlementSpeed(input: StartSwapRequest): SettlementSpeed {
  // An explicitly undefined floor counts as absent (the MCP server always passes the key).
  if (input.minBsvOut !== undefined && (typeof input.minBsvOut !== 'bigint' || input.minBsvOut <= 0n)) throw new Error('min_bsv_out must be a positive number of satoshis; nothing was locked')
  if (input.speed !== undefined && input.speed !== 'standard' && input.speed !== 'fast') throw new Error('speed must be standard or fast; nothing was locked')
  return input.speed ?? 'standard'
}

export function requestedSettlementMode(record: BuyerSwapRecord): SettlementMode {
  return record.requestedSpeed === 'fast' && record.fastSettlementAllowedSnapshot !== false && record.quote.doorProtocolVersion === 2 && record.quote.fastOffered === true && (record.quote.fastCapUsdcBaseUnits ?? 0n) >= BigInt(record.amountIn) ? 'fast' : 'confirmed'
}

export function initialSettlementMode(record: { requestedSpeed: 'standard' | 'fast'; fastSettlementAllowedSnapshot: boolean; quote: BuyerQuote; amountIn: bigint }): { eligible: boolean; downgradeReason?: string } {
  const eligible = record.requestedSpeed === 'fast' && record.fastSettlementAllowedSnapshot && record.quote.doorProtocolVersion === 2 && record.quote.fastOffered === true && (record.quote.fastCapUsdcBaseUnits ?? 0n) >= record.amountIn
  const downgradeReason = record.requestedSpeed !== 'fast' ? undefined : !record.fastSettlementAllowedSnapshot ? 'fast settlement is disabled by limits.json' : record.quote.doorProtocolVersion !== 2 ? 'market maker supports the confirmed v1 protocol only' : !record.quote.fastOffered || (record.quote.fastCapUsdcBaseUnits ?? 0n) < record.amountIn ? 'market maker did not offer fast settlement for this amount' : undefined
  return { eligible, downgradeReason }
}

export function createInitialSettlementRecord(input: { request: StartSwapRequest; retained?: BuyerQuote; quote: BuyerQuote; requestedSpeed: SettlementSpeed; fastSettlementAllowedSnapshot: boolean; now: number; swapId: string; requestId: string }): BuyerSwapRecord {
  const floor = input.request.minBsvOut ?? (input.retained ? input.retained.bsvSats * 99n / 100n : undefined)
  if (floor !== undefined && input.quote.bsvSats < floor) throw new Error('price moved below the permitted BSV amount; nothing was locked')
  const settlement = initialSettlementMode({ requestedSpeed: input.requestedSpeed, fastSettlementAllowedSnapshot: input.fastSettlementAllowedSnapshot, quote: input.quote, amountIn: input.request.amountIn })
  return { schemaVersion: 3, swapId: input.swapId, requestId: input.requestId, stage: 'quoted', amountIn: input.request.amountIn.toString(), quote: input.quote, deliverTo: input.request.deliverTo, requestedSpeed: input.requestedSpeed, agreedSettlementMode: settlement.eligible ? 'pending' : 'confirmed', settlementModeUsed: 'pending', fastSettlementAllowedSnapshot: input.fastSettlementAllowedSnapshot, settlementModeDowngradeReason: settlement.downgradeReason, createdAtMs: input.now, updatedAtMs: input.now }
}

export async function negotiateSettlementMode(record: BuyerSwapRecord, deps: { door: DoorClient; now: () => number; write: WriteRecord }): Promise<{ record: BuyerSwapRecord; admission: Awaited<ReturnType<DoorClient['admit']>>; admittedMode: SettlementMode; admittedCap: string; downgradeReason?: string } | undefined> {
  // The admission request is intentionally persisted before the executor can lock USDC.
  const requestedMode = requestedSettlementMode(record)
  const admission = await deps.door.admit(record.quote.doorQuoteId, BigInt(record.amountIn), record.requestId, requestedMode)
  if (admission.handshakeDeadlineMs <= deps.now()) throw new Error('market maker admission expired before the handshake began')
  const admittedMode = admission.settlementMode ?? 'confirmed'
  const admittedCap = admission.fastCapUsdcBaseUnits ?? '0'
  const downgradeReason = admittedMode === 'confirmed' && requestedMode === 'fast' ? 'market maker did not agree to fast settlement' : record.settlementModeDowngradeReason
  record = await deps.write(record, 'admitted', { swapNamespace: admission.swapNamespace, handshakeDeadlineMs: admission.handshakeDeadlineMs, agreedSettlementMode: admittedMode, agreedFastCapUsdcBaseUnits: admittedCap, settlementModeDowngradeReason: downgradeReason })
  return { record, admission, admittedMode, admittedCap, downgradeReason }
}

export async function executeNegotiatedSettlement(record: BuyerSwapRecord, negotiation: NonNullable<Awaited<ReturnType<typeof negotiateSettlementMode>>>, deps: { executor: BuyerExecutor; write: WriteRecord; setRecord: (record: BuyerSwapRecord) => void; onSettlement: Parameters<BuyerExecutor['execute']>[0]['onSettlement'] }): Promise<{ record: BuyerSwapRecord; result: Awaited<ReturnType<BuyerExecutor['execute']>> }> {
  const result = await deps.executor.execute({
    swapId: record.swapId, quote: record.quote, swapNamespace: negotiation.admission.swapNamespace, handshakeDeadlineMs: negotiation.admission.handshakeDeadlineMs, agreedSettlementMode: negotiation.admittedMode, fastCapUsdcBaseUnits: negotiation.admittedCap,
    // This is deliberately awaited by the initiator before it creates its settlement record.  A restart can now
    // distinguish a linked-but-not-created checkpoint from an unlinked pre-admission row.
    onSettlementLink: async (hashHex) => { record = await deps.write(record, 'admitted', { settlementHashHex: hashHex, settlementRecordCreated: false }); deps.setRecord(record) },
    onSettlement: deps.onSettlement,
  })
  return { record, result }
}

export function makeSettlementAttachment(deps: { getRecord: () => BuyerSwapRecord; setRecord: (record: BuyerSwapRecord) => void; write: WriteRecord; stageForSettlement: (state: SettlementState) => BuyerSwapStage; log: (message: string) => void }): (settlement: { hashHex: string; state: SettlementState; settlementModeUsed?: SettlementModeUsed; settlementModeDowngradeReason?: string }) => void {
  return (settlement) => {
    // The initiator invokes this immediately after its durable write-ahead record and before `evm.lock`.  Do not
    // await here: its callback is synchronous by design, and a cosmetic kit-store error must never reject the
    // money path.  The settlement record remains the crash-recovery source of truth.
    let record: BuyerSwapRecord = { ...deps.getRecord(), settlementHashHex: settlement.hashHex, settlementState: settlement.state, settlementRecordCreated: true, ...(settlement.settlementModeUsed ? { settlementModeUsed: settlement.settlementModeUsed } : {}), ...(settlement.settlementModeDowngradeReason ? { settlementModeDowngradeReason: settlement.settlementModeDowngradeReason } : {}) }
    deps.setRecord(record)
    void deps.write(record, deps.stageForSettlement(settlement.state), { settlementHashHex: settlement.hashHex, settlementState: settlement.state, settlementRecordCreated: true, ...(settlement.settlementModeUsed ? { settlementModeUsed: settlement.settlementModeUsed } : {}), ...(settlement.settlementModeDowngradeReason ? { settlementModeDowngradeReason: settlement.settlementModeDowngradeReason } : {}) })
      .then((saved) => { record = saved; deps.setRecord(saved) })
      .catch((error) => deps.log(`could not persist settlement link for ${record.swapId}; recovery remains in the settlement store: ${error instanceof Error ? error.message : String(error)}`))
  }
}
