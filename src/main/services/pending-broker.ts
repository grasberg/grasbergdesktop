/**
 * PendingBroker — generic base for the pending-request brokers that bridge
 * the chat tool loop (main) and the user's click in the renderer
 * (ApprovalBroker, QuestionBroker).
 *
 * request() broadcasts the full request (with a fresh requestId) on
 * `requestChannel` and returns a promise that resolves when the renderer
 * answers via respond(). A request that is never answered resolves to the
 * fallback answer after `timeoutMs`, and stopAll() (app quit / teardown)
 * resolves everything still pending to the fallback — the promise can never
 * dangle. Whenever a request settles for ANY reason the broker broadcasts
 * `settledChannel` with the requestId so the renderer can dismiss its dialog.
 *
 * setHooks() adds SIDE channels next to the renderer: a desktop notification,
 * and (for approvals) the paired Telegram chat, so a request can be answered
 * from a phone. Side channels never replace the renderer broadcast — both are
 * live at once and the first answer wins, since respond() ignores a requestId
 * that already settled.
 */

import { randomUUID } from 'node:crypto'

type Broadcast = (channel: string, payload: unknown) => void

export interface BrokerHooks<TRequest, TAnswer> {
  /** A request is now pending. Fired after the renderer broadcast succeeded. */
  onRequest?: (request: TRequest) => void
  /** The request settled (answered, timed out, aborted, torn down). */
  onSettled?: (requestId: string, answer: TAnswer) => void
}

interface PendingEntry<TAnswer> {
  resolve: (answer: TAnswer) => void
  timer: NodeJS.Timeout
  broadcast: Broadcast
  signal?: AbortSignal
  onAbort?: () => void
}

export abstract class PendingBroker<TRequest extends { requestId: string }, TAnswer> {
  private readonly pending = new Map<string, PendingEntry<TAnswer>>()
  private hooks: BrokerHooks<TRequest, TAnswer> = {}

  protected constructor(
    private readonly requestChannel: string,
    private readonly settledChannel: string,
    /** Answer used on timeout, abort, broadcast failure and stopAll(). */
    private readonly fallback: TAnswer,
    private readonly timeoutMs: number
  ) {}

  /**
   * Broadcasts the full request (with a fresh requestId) to the renderer and
   * resolves with the user's answer — the fallback on timeout, on stopAll(),
   * when the broadcast itself fails (no window to ask), or when the optional
   * `signal` aborts (the owning stream was stopped). Whenever the request
   * settles for ANY reason it broadcasts `settledChannel` with the requestId
   * so the renderer can dismiss its dialog.
   */
  request(
    req: Omit<TRequest, 'requestId'>,
    broadcast: Broadcast,
    signal?: AbortSignal
  ): Promise<TAnswer> {
    const requestId = randomUUID()
    const fullRequest = { requestId, ...req } as TRequest
    return new Promise<TAnswer>((resolve) => {
      // The stream was already aborted before we could ask — fall back at once.
      if (signal?.aborted) {
        resolve(this.fallback)
        try {
          broadcast(this.settledChannel, requestId)
        } catch {
          // No reachable window — nothing to dismiss.
        }
        return
      }
      const timer = setTimeout(() => this.settle(requestId, this.fallback), this.timeoutMs)
      // Never keep the process alive just for an unanswered dialog.
      timer.unref?.()
      const onAbort = (): void => this.settle(requestId, this.fallback)
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, { resolve, timer, broadcast, signal, onAbort })
      try {
        broadcast(this.requestChannel, fullRequest)
      } catch {
        // No reachable window — settle to the fallback right away.
        this.settle(requestId, this.fallback)
        return
      }
      // Side channels only for a request that is genuinely still pending.
      if (this.pending.has(requestId)) {
        try {
          this.hooks.onRequest?.(fullRequest)
        } catch {
          // A failing side channel must not strand the request.
        }
      }
    })
  }

  /**
   * Attaches the side channels (notifications, remote approval). Wired once at
   * startup, after the services they call have been constructed. A hook that
   * throws is swallowed: a broken notifier must never strand a tool call.
   */
  setHooks(hooks: BrokerHooks<TRequest, TAnswer>): void {
    this.hooks = hooks
  }

  /** Renderer's answer. Unknown (expired/duplicate) requestIds are ignored. */
  respond(requestId: string, answer: TAnswer): void {
    this.settle(requestId, answer)
  }

  /** True while `requestId` is still awaiting an answer. */
  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  /** Called on app quit/teardown: every pending request resolves to the fallback. */
  stopAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, this.fallback)
    }
  }

  private settle(requestId: string, answer: TAnswer): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    entry.resolve(answer)
    // Tell the renderer the dialog is resolved (respond/timeout/abort/stopAll).
    try {
      entry.broadcast(this.settledChannel, requestId)
    } catch {
      // No reachable window — nothing to dismiss.
    }
    try {
      this.hooks.onSettled?.(requestId, answer)
    } catch {
      // Side-channel cleanup is best-effort.
    }
  }
}
