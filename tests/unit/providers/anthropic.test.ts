import { describe, expect, it } from 'vitest'
import type { AdapterMessage } from '../../../src/main/providers/adapter'
import {
  AnthropicAdapter,
  buildAnthropicBody,
  newAnthropicState,
  parseAnthropicEvent,
  toAnthropicMessages,
  toolsToAnthropic,
} from '../../../src/main/providers/anthropic'

describe('toAnthropicMessages', () => {
  it('hoists system, maps blocks, coalesces adjacent tool results', () => {
    const messages: AdapterMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok', toolCalls: [{ id: 't1', name: 'f', arguments: '{"a":1}', status: 'proposed' }] },
      { role: 'tool', content: 'r1', toolCallId: 't1' },
      { role: 'tool', content: 'r2', toolCallId: 't2' },
    ]
    const { system, messages: out } = toAnthropicMessages(messages)
    expect(system).toBe('Be brief.')
    expect(out[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }],
    })
    // Two tool results coalesced into ONE user turn (alternating-role rule).
    expect(out[2].role).toBe('user')
    expect((out[2].content as unknown[]).length).toBe(2)
  })
})

describe('buildAnthropicBody', () => {
  it('defaults max_tokens and includes system + tools', () => {
    const body = buildAnthropicBody(
      {
        modelId: 'claude-sonnet-5',
        messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }],
        params: {},
        tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }],
        stream: true,
      },
      true
    )
    expect(body).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 4096, system: 'S', stream: true })
    expect(toolsToAnthropic([{ name: 'f', description: 'd', parameters: { type: 'object' } }])[0]).toEqual({
      name: 'f',
      description: 'd',
      input_schema: { type: 'object' },
    })
  })
})

describe('parseAnthropicEvent', () => {
  it('maps a full message stream: usage, text, tool_use assembly, finish', () => {
    const state = newAnthropicState()
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 12 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'search' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    ].flatMap((e) => parseAnthropicEvent(e, state))

    expect(events).toContainEqual({ type: 'usage', usage: { promptTokens: 12 } })
    expect(events).toContainEqual({ type: 'text', text: 'Hi' })
    expect(events).toContainEqual({
      type: 'tool_call',
      toolCall: { id: 'tu1', name: 'search', arguments: '{"q":1}', status: 'proposed' },
    })
    expect(events).toContainEqual({ type: 'usage', usage: { completionTokens: 5 } })
    expect(events).toContainEqual({ type: 'finish', reason: 'tool_calls' })
  })
})

describe('AnthropicAdapter error redaction', () => {
  it('never leaks the api key in a failed connection test', async () => {
    const KEY = 'sk-ant-secret-XYZ'
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      text: async () => `unauthorized: key ${KEY} invalid`,
      headers: new Headers(),
    })) as unknown as typeof fetch
    const res = await new AnthropicAdapter().testConnection({
      apiKey: KEY,
      baseUrl: 'https://api.anthropic.com/v1',
      fetchImpl,
    })
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain(KEY)
  })
})
