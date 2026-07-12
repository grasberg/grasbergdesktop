import { describe, expect, it, vi } from 'vitest'
import { ScheduledRunQueue } from '../../src/main/scheduling/run-queue'

describe('ScheduledRunQueue', () => {
  it('limits all scheduled job kinds to two concurrent runs', async () => {
    const queue = new ScheduledRunQueue(2)
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const run = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
    })

    const jobs = [
      queue.enqueue('task:1', run),
      queue.enqueue('workflow:1', run),
      queue.enqueue('task:2', run),
      queue.enqueue('workflow:2', run),
    ]
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4))
    releases.splice(0).forEach((release) => release())
    await Promise.all(jobs)
    expect(peak).toBe(2)
  })

  it('deduplicates an already queued key', async () => {
    const queue = new ScheduledRunQueue(1)
    const run = vi.fn(async () => 'result')
    const first = queue.enqueue('task:same', run)
    const second = queue.enqueue('task:same', run)
    expect(second).toBe(first)
    await expect(second).resolves.toBe('result')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
