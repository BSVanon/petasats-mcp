/**
 * Buyer-visible text names the other side "the counterparty". Decline reasons from an older counterparty build, and
 * reasons stored by an older kit, can still carry the old wording; this rewrites them for display only, never on disk
 * or on the wire. The capacity decline is matched by its shape, so no internal name has to appear in exported source.
 */
export function sanitizeCounterpartyReason(reason: string): string {
  return reason
    .replace(/\blargest amount \S+ can fund right now\b/g, 'largest amount the counterparty can fund right now')
    .replace(/\b(?:the\s+)?market[ -]maker\b/gi, (match) => (/^[A-Z]/.test(match) ? 'The counterparty' : 'the counterparty'))
}
