import type { StreamEvent } from '@shared/types'

type DeltaEvent = Extract<StreamEvent, { type: 'text-delta' | 'reasoning-delta' }>

const DEFAULT_FLUSH_MS = 32

/**
 * Coalesces adjacent text/reasoning stream deltas for one animation-sized
 * window. The owner flushes before non-delta events so they cannot overtake
 * buffered content.
 */
export class StreamDeltaBuffer {
  private timer: NodeJS.Timeout | null = null
  private pending: DeltaEvent[] = []

  constructor(
    private readonly emit: (event: StreamEvent) => void,
    private readonly flushMs = DEFAULT_FLUSH_MS
  ) {}

  push(event: DeltaEvent): void {
    if (!event.text) return
    const last = this.pending[this.pending.length - 1]
    if (last?.type === event.type) {
      last.text += event.text
    } else {
      this.pending.push({ ...event })
    }
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.flushMs)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending.length === 0) return
    const events = this.pending
    this.pending = []
    for (const event of events) this.emit(event)
  }
}
