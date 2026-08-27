/**
 * In-process pub/sub for main-side push events.
 *
 * Everything the renderer receives as a push (stream events, approval requests,
 * workflow notifications, …) flows through the `broadcast` function wired into
 * the services. That function used to loop over BrowserWindows directly, which
 * left remote consumers (the phone tunnel) with no way to see the same events.
 * Publishing here instead keeps a single source: the window forwarder in
 * index.ts subscribes, and so does the remote service — both see exactly what
 * the desktop renderer sees, in the same order.
 *
 * Synchronous, in-memory, best-effort: a subscriber that throws must never
 * break the others or the sender.
 */

export type MainEventListener = (channel: string, payload: unknown) => void

const subscribers = new Set<MainEventListener>()

/** Notify every subscriber about one push event. */
export function publishMainEvent(channel: string, payload: unknown): void {
  for (const listener of [...subscribers]) {
    try {
      listener(channel, payload)
    } catch {
      // One broken subscriber must not swallow the event for the rest.
    }
  }
}

/** Subscribe to every push event; returns an unsubscribe function. */
export function subscribeMainEvents(listener: MainEventListener): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}
