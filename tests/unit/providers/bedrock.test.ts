import { describe, expect, it } from 'vitest'
import type { AdapterMessage } from '../../../src/main/providers/adapter'
import {
  BedrockAdapter,
  buildConverseBody,
  mapConverseResult,
  toConverseMessages,
} from '../../../src/main/providers/bedrock'

describe('toConverseMessages / buildConverseBody', () => {
  it('maps system/content blocks + toolConfig with json input schema', () => {
    const messages: AdapterMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok', toolCalls: [{ id: 'u1', name: 'f', arguments: '{"a":1}', status: 'proposed' }] },
      { role: 'tool', content: 'res', toolCallId: 'u1' },
    ]
    const { system, messages: out } = toConverseMessages(messages)
    expect(system).toEqual([{ text: 'S' }])
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [{ text: 'ok' }, { toolUse: { toolUseId: 'u1', name: 'f', input: { a: 1 } } }],
    })
    expect(out[2]).toEqual({
      role: 'user',
      content: [{ toolResult: { toolUseId: 'u1', content: [{ text: 'res' }] } }],
    })

    const body = buildConverseBody({
      modelId: 'us.anthropic.claude-sonnet-5',
      messages,
      params: { maxTokens: 64 },
      tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }],
      stream: false,
    }) as Record<string, unknown>
    expect(body.inferenceConfig).toEqual({ maxTokens: 64 })
    expect(body.toolConfig).toEqual({
      tools: [{ toolSpec: { name: 'f', description: 'd', inputSchema: { json: { type: 'object' } } } }],
    })
  })
})

describe('mapConverseResult', () => {
  it('extracts text, toolUse, stopReason, usage', () => {
    const r = mapConverseResult({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Hello' }, { toolUse: { toolUseId: 'x', name: 'run', input: { a: 1 } } }],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
    })
    expect(r.text).toBe('Hello')
    expect(r.toolCalls).toEqual([{ id: 'x', name: 'run', arguments: '{"a":1}', status: 'proposed' }])
    expect(r.finishReason).toBe('tool_calls')
    expect(r.usage).toEqual({ promptTokens: 3, completionTokens: 7, totalTokens: 10 })
  })
})

describe('BedrockAdapter', () => {
  it('chatStream yields once in order: text → tool_call → usage → finish', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          output: { message: { content: [{ text: 'Hi' }, { toolUse: { toolUseId: 't', name: 'f', input: {} } }] } },
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        }),
      headers: new Headers(),
    })) as unknown as typeof fetch
    const events = []
    for await (const e of new BedrockAdapter().chatStream(
      { modelId: 'us.anthropic.claude-sonnet-5', messages: [{ role: 'user', content: 'x' }], params: {}, stream: true },
      { apiKey: 'k', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', fetchImpl }
    )) {
      events.push(e)
    }
    expect(events.map((e) => e.type)).toEqual(['text', 'tool_call', 'usage', 'finish'])
  })

  it('never leaks the bearer token on a 403', async () => {
    const KEY = 'bedrock-bearer-SECRET'
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      text: async () => `forbidden token ${KEY}`,
      headers: new Headers(),
    })) as unknown as typeof fetch
    const res = await new BedrockAdapter().testConnection({
      apiKey: KEY,
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      fetchImpl,
    })
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain(KEY)
  })
})
