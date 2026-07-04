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

import { randomUUID } from 'node:crypto'
import type { ToolApprovalRequest } from '@shared/types'
import { CHANNELS } from '@shared/ipc'

/** Unanswered approvals resolve to false (declined) after this long. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000

type Broadcast = (channel: string, payload: unknown) => void

interface PendingApproval {
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
  broadcast: Broadcast
  signal?: AbortSignal
  onAbort?: () => void
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(private readonly timeoutMs: number = APPROVAL_TIMEOUT_MS) {}

  /**
   * Broadcasts the full ToolApprovalRequest (with a fresh requestId) to the
   * renderer and resolves with the user's answer — false on timeout, on
   * stopAll(), when the broadcast itself fails (no window to ask), or when the
   * optional `signal` aborts (the owning stream was stopped). Whenever the
   * request settles for ANY reason it broadcasts CHANNELS.toolApprovalSettled
   * with the requestId so the renderer can dismiss its dialog.
   */
  request(
    req: Omit<ToolApprovalRequest, 'requestId'>,
    broadcast: Broadcast,
    signal?: AbortSignal
  ): Promise<boolean> {
    const requestId = randomUUID()
    const fullRequest: ToolApprovalRequest = { requestId, ...req }
    return new Promise<boolean>((resolve) => {
      // The stream was already aborted before we could ask — decline at once.
      if (signal?.aborted) {
        resolve(false)
        try {
          broadcast(CHANNELS.toolApprovalSettled, requestId)
        } catch {
          // No reachable window — nothing to dismiss.
        }
        return
      }
      const timer = setTimeout(() => this.settle(requestId, false), this.timeoutMs)
      // Never keep the process alive just for an unanswered dialog.
      timer.unref?.()
      const onAbort = (): void => this.settle(requestId, false)
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, { resolve, timer, broadcast, signal, onAbort })
      try {
        broadcast(CHANNELS.toolApprovalRequest, fullRequest)
      } catch {
        // No reachable window — treat as declined right away.
        this.settle(requestId, false)
      }
    })
  }

  /** Renderer's answer. Unknown (expired/duplicate) requestIds are ignored. */
  respond(requestId: string, approved: boolean): void {
    this.settle(requestId, approved)
  }

  /** True while `requestId` is still awaiting an answer. */
  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  /** Called on app quit/teardown: every pending request resolves to false. */
  stopAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, false)
    }
  }

  private settle(requestId: string, approved: boolean): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    entry.resolve(approved)
    // Tell the renderer the dialog is resolved (respond/timeout/abort/stopAll).
    try {
      entry.broadcast(CHANNELS.toolApprovalSettled, requestId)
    } catch {
      // No reachable window — nothing to dismiss.
    }
  }
}
