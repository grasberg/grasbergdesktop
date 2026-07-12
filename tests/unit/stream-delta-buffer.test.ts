import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamEvent } from '@shared/types'
import { StreamDeltaBuffer } from '../../src/main/services/stream-delta-buffer'

afterEach(() => vi.useRealTimers())

describe('StreamDeltaBuffer', () => {
  it('coalesces adjacent deltas and preserves type order', () => {
    vi.useFakeTimers()
    const events: StreamEvent[] = []
    const buffer = new StreamDeltaBuffer((event) => events.push(event))

    for (let i = 0; i < 100; i++) buffer.push({ type: 'text-delta', text: String(i % 10) })
    buffer.push({ type: 'reasoning-delta', text: 'a' })
    buffer.push({ type: 'reasoning-delta', text: 'b' })
    buffer.push({ type: 'text-delta', text: 'tail' })

    expect(events).toEqual([])
    vi.advanceTimersByTime(32)
    expect(events).toEqual([
      { type: 'text-delta', text: '0123456789'.repeat(10) },
      { type: 'reasoning-delta', text: 'ab' },
      { type: 'text-delta', text: 'tail' },
    ])
  })

  it('flushes synchronously and cancels the scheduled flush', () => {
    vi.useFakeTimers()
    const events: StreamEvent[] = []
    const buffer = new StreamDeltaBuffer((event) => events.push(event))
    buffer.push({ type: 'text-delta', text: 'complete answer' })

    buffer.flush()
    expect(events).toEqual([{ type: 'text-delta', text: 'complete answer' }])
    vi.runAllTimers()
    expect(events).toHaveLength(1)
  })
})
