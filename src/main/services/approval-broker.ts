/**
 * ApprovalBroker — pending tool-approval requests, bridging the chat tool
 * loop (main) and the user's approve/decline click (renderer).
 *
 * request() broadcasts a ToolApprovalRequest on CHANNELS.toolApprovalRequest
 * and returns a promise that resolves when the renderer answers via the
 * tools:approval:respond IPC (routed to respond()). A request that is never
 * answered resolves to false after five minutes, and stopAll() (app quit /
 * teardown) resolves everything still pending to false — the promise can
 * never dangle, so a tool call can never run without an explicit approval.
 */

import type { ToolApprovalRequest } from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { PendingBroker } from './pending-broker'

/** Unanswered approvals resolve to false (declined) after this long. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000

export class ApprovalBroker extends PendingBroker<ToolApprovalRequest, boolean> {
  constructor(timeoutMs: number = APPROVAL_TIMEOUT_MS) {
    super(CHANNELS.toolApprovalRequest, CHANNELS.toolApprovalSettled, false, timeoutMs)
  }
}
