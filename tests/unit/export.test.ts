import { describe, expect, it } from 'vitest'
import type { Conversation, Message } from '@shared/types'
import { exportFileBase, toJson, toMarkdown } from '../../src/main/services/export'

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    mode: 'chat',
    title: 'My chat',
    providerId: 'p1',
    modelId: 'deepseek-chat',
    systemPrompt: null,
    params: {},
    workspaceId: null,
    projectId: null,
    projectRef: null,
    moaPresetId: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Conversation
}

function message(patch: Partial<Message>): Message {
  return {
    id: 'm',
    conversationId: 'c1',
    role: 'user',
    content: '',
    status: 'complete',
    seq: 0,
    createdAt: 0,
    ...patch,
  }
}

describe('toMarkdown', () => {
  it('renders roles, reasoning and tool calls', () => {
    const md = toMarkdown(conversation(), [
      message({ role: 'user', content: 'Hello', seq: 0 }),
      message({
        id: 'm2',
        role: 'assistant',
        content: 'Hi!',
        reasoning: 'thinking…',
        seq: 1,
        toolCalls: [
          { id: 't1', name: 'fetch_url', arguments: '{"url":"https://x"}', status: 'done', result: 'HTTP 200' },
        ],
      }),
    ])
    expect(md).toContain('# My chat')
    expect(md).toContain('- Mode: chat')
    expect(md).toContain('- Model: deepseek-chat')
    expect(md).toContain('## User')
    expect(md).toContain('Hello')
    expect(md).toContain('## Assistant')
    expect(md).toContain('<details><summary>Reasoning</summary>')
    expect(md).toContain('thinking…')
    expect(md).toContain('**Tool call:** `fetch_url`')
    expect(md).toContain('HTTP 200')
  })

  it('skips empty system scaffolding messages', () => {
    const md = toMarkdown(conversation(), [
      message({ role: 'system', content: '   ', seq: 0 }),
      message({ id: 'm2', role: 'user', content: 'Question', seq: 1 }),
    ])
    expect(md).not.toContain('## System')
    expect(md).toContain('## User')
  })
})

describe('toJson', () => {
  it('round-trips the conversation and messages', () => {
    const msgs = [message({ role: 'user', content: 'x' })]
    const parsed = JSON.parse(toJson(conversation(), msgs))
    expect(parsed.conversation.id).toBe('c1')
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.messages[0].content).toBe('x')
  })
})

describe('exportFileBase', () => {
  it('produces a filesystem-safe base name', () => {
    expect(exportFileBase(conversation({ title: 'Hello / World: test?' }))).toBe('Hello-World-test')
    expect(exportFileBase(conversation({ title: '' }))).toBe('conversation')
  })
})
