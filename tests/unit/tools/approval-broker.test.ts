/**
 * ApprovalBroker: pending tool approvals resolve via respond(), time out to
 * false, ignore unknown ids, and broadcast a well-formed ToolApprovalRequest.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolApprovalRequest } from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import {
  APPROVAL_TIMEOUT_MS,
  ApprovalBroker,
} from '../../../src/main/services/approval-broker'

function baseRequest(): Omit<ToolApprovalRequest, 'requestId'> {
  return {
    streamId: 'stream-1',
    conversationId: 'conv-1',
    toolCall: {
      id: 'tc-1',
      name: 'file_search',
      arguments: '{"query":"needle"}',
      status: 'proposed',
    },
    risk: 'sensitive',
  }
}

interface CapturedBroadcast {
  channel: string
  payload: ToolApprovalRequest
}

function capture(): { broadcasts: CapturedBroadcast[]; broadcast: (c: string, p: unknown) => void } {
  const broadcasts: CapturedBroadcast[] = []
  return {
    broadcasts,
    broadcast: (channel, payload) =>
      broadcasts.push({ channel, payload: payload as ToolApprovalRequest }),
  }
}

/** Observes settlement without awaiting (the promise may stay pending). */
function settlement(promise: Promise<boolean>): Promise<string> {
  return Promise.race([
    promise.then((v) => `settled:${v}`),
    // One macro/micro tick is enough — settle wins the race if it happened.
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0)),
  ])
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ApprovalBroker', () => {
  it('resolves true when the renderer approves', async () => {
    const broker = new ApprovalBroker()
    const { broadcasts, broadcast } = capture()
    const promise = broker.request(baseRequest(), broadcast)

    expect(broadcasts).toHaveLength(1)
    broker.respond(broadcasts[0].payload.requestId, true)
    await expect(promise).resolves.toBe(true)
  })

  it('resolves false when the renderer declines', async () => {
    const broker = new ApprovalBroker()
    const { broadcasts, broadcast } = capture()
    const promise = broker.request(baseRequest(), broadcast)

    broker.respond(broadcasts[0].payload.requestId, false)
    await expect(promise).resolves.toBe(false)
  })

  it('broadcasts the full ToolApprovalRequest on the approval push channel', async () => {
    const broker = new ApprovalBroker()
    const { broadcasts, broadcast } = capture()
    const promise = broker.request(baseRequest(), broadcast)

    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].channel).toBe(CHANNELS.toolApprovalRequest)
    const sent = broadcasts[0].payload
    expect(sent).toMatchObject({
      streamId: 'stream-1',
      conversationId: 'conv-1',
      risk: 'sensitive',
      toolCall: {
        id: 'tc-1',
        name: 'file_search',
        arguments: '{"query":"needle"}',
        status: 'proposed',
      },
    })
    expect(typeof sent.requestId).toBe('string')
    expect(sent.requestId.length).toBeGreaterThan(0)

    // Two concurrent requests get distinct ids.
    const second = broker.request(baseRequest(), broadcast)
    expect(broadcasts[1].payload.requestId).not.toBe(sent.requestId)
    broker.stopAll()
    await expect(promise).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
  })

  it('times out to false after five minutes, and a late respond is ignored', async () => {
    vi.useFakeTimers()
    const broker = new ApprovalBroker()
    const { broadcasts, broadcast } = capture()
    const promise = broker.request(baseRequest(), broadcast)
    const requestId = broadcasts[0].payload.requestId

    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS - 1)
    expect(broker.has(requestId)).toBe(true)
    vi.advanceTimersByTime(1)
    await expect(promise).resolves.toBe(false)
    expect(broker.has(requestId)).toBe(false)

    // Late/duplicate answer: no throw, and the settled value stays false.
    expect(() => broker.respond(requestId, true)).not.toThrow()
    await expect(promise).resolves.toBe(false)
  })

  it('ignores unknown requestIds and leaves pending requests untouched', async () => {
    const broker = new ApprovalBroker()
    const { broadcasts, broadcast } = capture()
    const promise = broker.request(baseRequest(), broadcast)

    expect(() => broker.respond('not-a-real-id', true)).not.toThrow()
    expect(await settlement(promise)).toBe('pending')

    broker.respond(broadcasts[0].payload.requestId, true)
    await expect(promise).resolves.toBe(true)
  })

  it('stopAll resolves every pending request to false (quit safety)', async () => {
    const broker = new ApprovalBroker()
    const { broadcast } = capture()
    const first = broker.request(baseRequest(), broadcast)
    const second = broker.request(baseRequest(), broadcast)

    broker.stopAll()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
  })

  it('resolves false immediately when the broadcast itself throws', async () => {
    const broker = new ApprovalBroker()
    const promise = broker.request(baseRequest(), () => {
      throw new Error('window destroyed')
    })
    await expect(promise).resolves.toBe(false)
  })
})
