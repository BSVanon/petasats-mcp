/** The close_kit tool: its TOOLS entry and its result mapping, kept out of server.ts to stay within its line cap. */

import { CLOSED_STOP_REASON, type CloseKitRequest, type CloseKitStep } from 'petasats/sdk'
import { requireString, success, ToolInputError } from './validate.js'

export const CLOSE_KIT_TOOL = {
  name: 'close_kit',
  title: 'Empty and close the kit',
  description: "Empty this kit into the user's own wallets, then stop it: it spends nothing more until the user runs `npx petasats-mcp resume` in a terminal. This moves funds and cannot be undone: base_address and bsv_address must be addresses the user gave you and confirmed, never this kit's own addresses. Each call takes at most one step and returns at once; call it again after call_again_after_seconds until state is 'closed'. It refuses while a swap is running, naming the swap, or while spending is already stopped for another reason. It sends USDC first, then BSV, then ETH. Only ETH dust that cannot pay its own gas (and, rarely, a BSV amount too small to send) is left behind. It never deletes, prints or sends the kit's keys file; keys_note explains that once closed. Returns state ('refused', 'in_progress' or 'closed'), sent (every send made in this close-down so far), and either reason with an optional retry_after_seconds, did and next with call_again_after_seconds, or closed_at, final and keys_note.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      base_address: { type: 'string', description: "Destination Base address in checksummed 0x form (EIP-55), supplied and confirmed by the user. Not this kit's own address." },
      bsv_address: { type: 'string', description: "Destination BSV mainnet address (P2PKH, starting with 1), supplied and confirmed by the user. Not this kit's own address." },
    },
    required: ['base_address', 'bsv_address'],
  },
}

export function parseCloseKitArgs(a: Record<string, unknown> | undefined): CloseKitRequest {
  return { baseAddress: requireString(a, 'base_address'), bsvAddress: requireString(a, 'bsv_address') }
}

/**
 * stop_spending's reason check. close_kit's own reason marks a STOP as the end of a finished close-down, so a stop made
 * through the tool may not use it: a later close_kit call would read that stop as its own.
 */
export function assertStopReason(reason: string | undefined): void {
  if (reason !== undefined && reason.length > 200) throw new ToolInputError('reason must be 200 characters or fewer')
  if (reason === CLOSED_STOP_REASON) throw new ToolInputError(`the reason '${CLOSED_STOP_REASON}' is reserved for close_kit; give another reason`)
}

/** close_kit's wire shape already matches CloseKitStep field-for-field; no renaming needed. */
export function closeKitToolResult(step: CloseKitStep): ReturnType<typeof success> {
  return success(step)
}
