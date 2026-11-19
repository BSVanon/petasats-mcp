export const LEGACY_COOPERATIVE_REFUND_REASON = "The counterparty declined; USDC came back through the cooperative refund."
export const COOPERATIVE_REFUND_REASON = 'The counterparty declined; USDC came back through the cooperative refund.'
export function isCooperativeRefundReason(reason: unknown): boolean {
  return reason === COOPERATIVE_REFUND_REASON || reason === LEGACY_COOPERATIVE_REFUND_REASON
}
