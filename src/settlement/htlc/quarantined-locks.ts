import type { WalletAction, WalletInterface } from '@bsv/sdk'
import { listAllActions } from '../../wallet/list-all-actions'

/** The only wallet-action states that retain a lock reservation and therefore require quarantine. */
export const QUARANTINED_LOCK_STATUSES = new Set(['sending', 'nosend', 'unsigned', 'unprocessed'])
/** Label stamped on every wallet HTLC-lock FUND action so restart reconciliation (`reconcilePendingLockFunds`) can
 *  find and quarantine a noSend lock stranded by a crash between funding and `commit`. */
export const HTLC_LOCK_FUND_LABEL = 'petasats-htlc-lock-fund'

/** A toolbox draft left before funding failed; it never reserved an output and must not quarantine restocks. */
export function isInertLockDraft(action: WalletAction): boolean {
  return action.status === 'unsigned' && action.txid === ''
    && Array.isArray(action.inputs) && action.inputs.length === 0
    && Array.isArray(action.outputs) && action.outputs.length === 0
}

/**
 * Lists current quarantine candidates with their input/output evidence. Resolved evidence is intentionally not considered here: it is
 * verified during reconcile, then supplied by the caller because the resolved-locks file is immutable while the
 * signer owns the wallet-instance lock.
 */
export async function quarantinedLockActions(wallet: WalletInterface): Promise<WalletAction[]> {
  const actions = await listAllActions(wallet, {
    labels: [HTLC_LOCK_FUND_LABEL], labelQueryMode: 'any', includeLabels: false, includeInputs: true, includeOutputs: true, seekPermission: false,
  })
  // Count/action consumers must retain every txid-less unsigned action; a Set<string> collapses them into one.
  return actions.filter((action) => QUARANTINED_LOCK_STATUSES.has(action.status) && !isInertLockDraft(action))
}
