import { describe, expect, it } from 'vitest'
import type { AdapterMessage } from '../../../src/main/providers/adapter'
import {
  AnthropicAdapter,
  anthropicStreamError,
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
    expect(body).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 4096, stream: true })
    // Prompt caching: the system prompt rides as a cache_control text block.
    expect(body.system).toEqual([
      { type: 'text', text: 'S', cache_control: { type: 'ephemeral' } },
    ])
    expect(toolsToAnthropic([{ name: 'f', description: 'd', parameters: { type: 'object' } }])[0]).toEqual({
      name: 'f',
      description: 'd',
      input_schema: { type: 'object' },
    })
  })

  it('marks the last message block with cache_control (incremental prefix caching)', () => {
    const body = buildAnthropicBody(
      {
        modelId: 'claude-sonnet-5',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second' },
        ],
        params: {},
        stream: false,
      },
      false
    )
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>
    const lastBlocks = messages[messages.length - 1].content
    expect(lastBlocks[lastBlocks.length - 1]).toMatchObject({
      type: 'text',
      text: 'second',
      cache_control: { type: 'ephemeral' },
    })
    // Earlier messages carry no cache markers (max 4 breakpoints allowed).
    expect(messages[0].content[0]).not.toHaveProperty('cache_control')
  })

  it('maps reasoningEffort to an extended-thinking budget and drops temperature', () => {
    const body = buildAnthropicBody(
      {
        modelId: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'hi' }],
        params: { reasoningEffort: 'medium', temperature: 0.2, maxTokens: 1024 },
        stream: false,
      },
      false
    )
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    // max_tokens must exceed the budget; temperature/top_p are incompatible.
    expect(body.max_tokens as number).toBeGreaterThan(8192)
    expect(body).not.toHaveProperty('temperature')
  })

  it('skips thinking when the transcript already contains assistant tool_use turns', () => {
    const body = buildAnthropicBody(
      {
        modelId: 'claude-sonnet-5',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 't1', name: 'f', arguments: '{}', status: 'done' }],
          },
          { role: 'tool', content: 'r', toolCallId: 't1' },
        ],
        params: { reasoningEffort: 'high', temperature: 0.5 },
        stream: false,
      },
      false
    )
    expect(body).not.toHaveProperty('thinking')
    expect(body.temperature).toBe(0.5)
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

describe('anthropicStreamError', () => {
  it('maps an overload event to a retryable server error carrying the provider detail', () => {
    const err = anthropicStreamError(
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      ['sk-ant-key']
    )
    expect(err.code).toBe('server')
    expect(err.retryable).toBe(true)
    expect(err.message).toContain('overloaded_error')
    expect(err.message).toContain('Overloaded')
  })

  it('maps rate limits as retryable and permanent types as non-retryable', () => {
    expect(anthropicStreamError({ type: 'error', error: { type: 'rate_limit_error' } }, [])).toMatchObject({
      code: 'rate_limit',
      retryable: true,
    })
    expect(
      anthropicStreamError({ type: 'error', error: { type: 'invalid_request_error' } }, [])
    ).toMatchObject({ code: 'invalid_request', retryable: false })
    // Unknown/absent type: keep the old conservative default.
    expect(anthropicStreamError({ type: 'error' }, [])).toMatchObject({
      code: 'server',
      retryable: false,
    })
  })

  it('redacts the api key out of the provider message', () => {
    const KEY = 'sk-ant-secret-XYZ'
    const err = anthropicStreamError(
      { type: 'error', error: { type: 'api_error', message: `key ${KEY} exploded` } },
      [KEY]
    )
    expect(err.message).not.toContain(KEY)
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
