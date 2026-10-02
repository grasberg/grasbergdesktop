/** Anomaly monitor (v53): refusal streaks, repeated calls and bursts pause a bot. */

import { describe, expect, it } from 'vitest'
import { AnomalyMonitor, type ObservedCall } from '../../src/main/services/anomaly'

const call = (overrides: Partial<ObservedCall> = {}): ObservedCall => ({
  agentId: 'bot-1',
  conversationId: 'c1',
  toolId: 'fetch_url',
  decision: 'auto',
  arguments: '{"url":"https://a.example.com"}',
  at: 0,
  ...overrides,
})

const thresholds = { refusalsInARow: 3, repeats: 4, burst: 6, windowMs: 60_000 }

describe('AnomalyMonitor', () => {
  it('trips on consecutive refusals, and an allowed call resets the streak', () => {
    const tripped: string[] = []
    const monitor = new AnomalyMonitor((agentId, _c, reason) => tripped.push(`${agentId}: ${reason}`), thresholds)
    monitor.observe(call({ decision: 'blocked', arguments: '1' }))
    monitor.observe(call({ decision: 'declined', arguments: '2' }))
    monitor.observe(call({ decision: 'auto', arguments: '3' }))
    monitor.observe(call({ decision: 'reviewed', arguments: '4' }))
    monitor.observe(call({ decision: 'blocked', arguments: '5' }))
    expect(tripped).toEqual([])
    expect(monitor.observe(call({ decision: 'handoff', arguments: '6' }))).toMatch(/3 tool calls in a row/)
    expect(tripped).toHaveLength(1)
  })

  it('trips on identical repeats within the window but not across it', () => {
    const tripped: string[] = []
    const monitor = new AnomalyMonitor((_a, _c, reason) => tripped.push(reason), thresholds)
    for (let i = 0; i < 3; i++) monitor.observe(call({ at: i * 1000 }))
    monitor.observe(call({ at: 120_000 })) // the first three fell out of the window
    expect(tripped).toEqual([])
    for (let i = 1; i <= 3; i++) monitor.observe(call({ at: 120_000 + i }))
    expect(tripped[0]).toMatch(/repeated the same fetch_url call/)
  })

  it('does not count looking (read / screenshot / wait) as a loop', () => {
    const tripped: string[] = []
    const monitor = new AnomalyMonitor((_a, _c, reason) => tripped.push(reason), { ...thresholds, burst: 100 })
    for (let i = 0; i < 10; i++) {
      monitor.observe(call({ toolId: 'browser', arguments: '{"action":"read"}', at: i }))
      monitor.observe(call({ toolId: 'computer', arguments: '{"action":"screenshot"}', at: i }))
    }
    expect(tripped).toEqual([])
    // Acting the same way again and again still trips.
    for (let i = 0; i < 4; i++) monitor.observe(call({ toolId: 'browser', arguments: '{"action":"click","text":"Buy"}', at: 50 + i }))
    expect(tripped[0]).toMatch(/repeated the same browser call/)
  })

  it('trips on a burst of distinct calls, per bot, and respects the switch', () => {
    const tripped: string[] = []
    let on = true
    const monitor = new AnomalyMonitor((agentId) => tripped.push(agentId), thresholds, () => on)
    for (let i = 0; i < 5; i++) {
      monitor.observe(call({ arguments: `a${i}`, at: i }))
      monitor.observe(call({ agentId: 'bot-2', arguments: `b${i}`, at: i }))
    }
    expect(tripped).toEqual([])
    monitor.observe(call({ arguments: 'a-last', at: 10 }))
    expect(tripped).toEqual(['bot-1'])
    on = false
    for (let i = 0; i < 10; i++) monitor.observe(call({ agentId: 'bot-2', decision: 'blocked', arguments: `x${i}`, at: 20 + i }))
    expect(tripped).toEqual(['bot-1'])
  })
})
