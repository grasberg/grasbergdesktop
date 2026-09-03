/**
 * PendingBroker (approvals + questions): the per-conversation pending check
 * the Bots roster uses for its "needs you" state (v49).
 */

import { describe, expect, it } from 'vitest'
import type { ToolApprovalRequest } from '../../src/shared/types'
import { ApprovalBroker } from '../../src/main/services/approval-broker'

function requestFor(conversationId: string): Omit<ToolApprovalRequest, 'requestId'> {
  return {
    streamId: 'stream-1',
    conversationId,
    toolCall: { id: 'call-1', name: 'run_shell_command', arguments: '{}', status: 'proposed' },
    risk: 'dangerous',
  }
}

describe('PendingBroker.hasPendingFor', () => {
  it('is true only while a request from that conversation awaits an answer', async () => {
    const broker = new ApprovalBroker(60_000)
    const sent: Array<{ channel: string; payload: unknown }> = []
    const answer = broker.request(requestFor('c1'), (channel, payload) => {
      sent.push({ channel, payload })
    })
    expect(broker.hasPendingFor('c1')).toBe(true)
    expect(broker.hasPendingFor('c2')).toBe(false)

    const requestId = (sent[0].payload as { requestId: string }).requestId
    broker.respond(requestId, { approved: true, scope: 'once' })
    expect(await answer).toEqual({ approved: true, scope: 'once' })
    expect(broker.hasPendingFor('c1')).toBe(false)
  })

  it('clears on stopAll and never matches a request the window could not receive', async () => {
    const broker = new ApprovalBroker(60_000)
    const pending = broker.request(requestFor('c1'), () => undefined)
    expect(broker.hasPendingFor('c1')).toBe(true)
    broker.stopAll()
    await pending
    expect(broker.hasPendingFor('c1')).toBe(false)

    // A broadcast that throws settles immediately: nothing stays pending.
    const dead = broker.request(requestFor('c3'), () => {
      throw new Error('no window')
    })
    expect(broker.hasPendingFor('c3')).toBe(false)
    expect((await dead).approved).toBe(false)
  })
})
