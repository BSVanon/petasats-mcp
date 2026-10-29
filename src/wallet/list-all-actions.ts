import type { ListActionsArgs, WalletAction, WalletInterface } from '@bsv/sdk'

export const LIST_ACTIONS_PAGE_SIZE = 10_000

/**
 * Exhaustively list a filtered action set. Wallet-toolbox pages oldest first, so callers that need to find a
 * possibly-stranded recent action must not inspect just the first page.
 */
export async function listAllActions(
  wallet: Pick<WalletInterface, 'listActions'>,
  args: Omit<ListActionsArgs, 'limit' | 'offset'>,
  /** Test seam; production always uses the SDK maximum. */
  pageSize = LIST_ACTIONS_PAGE_SIZE,
): Promise<WalletAction[]> {
  const actions: WalletAction[] = []
  const txids = new Set<string>()
  let expectedTotal: number | undefined
  let spansMultiplePages = false
  let offset = 0

  for (;;) {
    const page = await wallet.listActions({ ...args, limit: pageSize, offset })
    const total = page.totalActions
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new Error(`listAllActions: wallet returned an invalid totalActions (${String(total)})`)
    }
    if (expectedTotal === undefined) {
      expectedTotal = total
      // The first page is the only point at which we can decide whether the listing is atomic.
      spansMultiplePages = total > page.actions.length
    }
    else if (total !== expectedTotal) {
      throw new Error(`listAllActions: totalActions changed between pages (${expectedTotal} -> ${total})`)
    }

    const pageActions = page.actions
    if (actions.length + pageActions.length > expectedTotal) {
      throw new Error(`listAllActions: wallet returned more actions than totalActions (${expectedTotal})`)
    }
    // An empty txid is toolbox's unsigned sentinel, not an identity, so it is safe only in a one-page listing.
    if (spansMultiplePages && pageActions.some((action) => action.txid === '')) {
      throw new Error('listAllActions: cannot verify the identity of a txid-less action across pages')
    }
    for (const action of pageActions) {
      // toolbox represents every never-signed action with txid ''. It is a sentinel, not an action identity.
      if (action.txid !== '') {
        if (txids.has(action.txid)) throw new Error(`listAllActions: repeated txid across pages (${action.txid})`)
        txids.add(action.txid)
      }
      actions.push(action)
    }
    if (actions.length === expectedTotal) return actions
    if (pageActions.length === 0) {
      throw new Error(`listAllActions: wallet returned an empty page before totalActions (${actions.length}/${expectedTotal})`)
    }
    offset += pageActions.length
  }
}
