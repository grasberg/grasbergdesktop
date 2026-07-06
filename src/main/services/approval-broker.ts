/**
 * ApprovalBroker — pending tool-approval requests, bridging the chat tool
 * loop (main) and the user's approve/decline click (renderer).
 *
 * request() broadcasts a ToolApprovalRequest on CHANNELS.toolApprovalRequest
 * and returns a promise that resolves when the renderer answers via the
 * tools:approval:respond IPC (routed to respond()). The answer carries the
 * approval scope: 'once' (this call only) or 'conversation' (also
 * auto-approve future calls of the same tool in the same conversation). A
 * request that is never answered resolves to declined after five minutes,
 * and stopAll() (app quit / teardown) resolves everything still pending to
 * declined — the promise can never dangle, so a tool call can never run
 * without an explicit approval.
 */

import type { ToolApprovalAnswer, ToolApprovalRequest } from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { PendingBroker } from './pending-broker'

/** Unanswered approvals resolve to declined after this long. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000

/** Fallback on timeout/abort/teardown: declined, no wider scope. */
export const APPROVAL_DECLINED: ToolApprovalAnswer = { approved: false, scope: 'once' }

export class ApprovalBroker extends PendingBroker<ToolApprovalRequest, ToolApprovalAnswer> {
  constructor(timeoutMs: number = APPROVAL_TIMEOUT_MS) {
    super(
      CHANNELS.toolApprovalRequest,
      CHANNELS.toolApprovalSettled,
      APPROVAL_DECLINED,
      timeoutMs
    )
  }
}
