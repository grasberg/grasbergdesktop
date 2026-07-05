/**
 * QuestionBroker — pending ask_user_question dialogs, bridging the chat tool
 * loop (main) and the user's answer click (renderer). Mirrors ApprovalBroker
 * but resolves to the chosen answer string, or null when the user dismissed
 * the dialog, it timed out, the stream was stopped, or the app quit.
 */

import { randomUUID } from 'node:crypto'
import type { UserQuestionRequest } from '@shared/types'
import { CHANNELS } from '@shared/ipc'

/** Unanswered questions resolve to null after this long. */
export const QUESTION_TIMEOUT_MS = 5 * 60_000

type Broadcast = (channel: string, payload: unknown) => void

interface PendingQuestion {
  resolve: (answer: string | null) => void
  timer: NodeJS.Timeout
  broadcast: Broadcast
  signal?: AbortSignal
  onAbort?: () => void
}

export class QuestionBroker {
  private readonly pending = new Map<string, PendingQuestion>()

  constructor(private readonly timeoutMs: number = QUESTION_TIMEOUT_MS) {}

  /**
   * Broadcasts the full UserQuestionRequest (with a fresh requestId) and
   * resolves with the user's answer — null on dismissal, timeout, stopAll()
   * or when the optional `signal` aborts. Always broadcasts
   * CHANNELS.userQuestionSettled when it settles so the renderer can dismiss.
   */
  request(
    req: Omit<UserQuestionRequest, 'requestId'>,
    broadcast: Broadcast,
    signal?: AbortSignal
  ): Promise<string | null> {
    const requestId = randomUUID()
    const fullRequest: UserQuestionRequest = { requestId, ...req }
    return new Promise<string | null>((resolve) => {
      if (signal?.aborted) {
        resolve(null)
        try {
          broadcast(CHANNELS.userQuestionSettled, requestId)
        } catch {
          // No reachable window — nothing to dismiss.
        }
        return
      }
      const timer = setTimeout(() => this.settle(requestId, null), this.timeoutMs)
      timer.unref?.()
      const onAbort = (): void => this.settle(requestId, null)
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, { resolve, timer, broadcast, signal, onAbort })
      try {
        broadcast(CHANNELS.userQuestionRequest, fullRequest)
      } catch {
        this.settle(requestId, null)
      }
    })
  }

  /** Renderer's answer (null = dismissed). Unknown requestIds are ignored. */
  respond(requestId: string, answer: string | null): void {
    this.settle(requestId, answer)
  }

  /** Called on app quit/teardown: every pending question resolves to null. */
  stopAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, null)
    }
  }

  private settle(requestId: string, answer: string | null): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    entry.resolve(answer)
    try {
      entry.broadcast(CHANNELS.userQuestionSettled, requestId)
    } catch {
      // No reachable window — nothing to dismiss.
    }
  }
}
