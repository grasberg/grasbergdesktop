import { describe, expect, it } from 'vitest'
import type { AdapterMessage } from '../../../src/main/providers/adapter'
import {
  OpenAICodexAdapter,
  buildResponsesBody,
  messagesToResponses,
  parseResponsesEvent,
  toolsToResponses,
} from '../../../src/main/providers/openai-codex'
import { OpenAICodexAdapter as CodexClass } from '../../../src/main/providers/openai-codex'
import { resolveAdapter } from '../../../src/main/providers/registry'

describe('messagesToResponses', () => {
  it('routes system → instructions and maps roles into input items', () => {
    const messages: AdapterMessage[] = [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'calling',
        toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":1}', status: 'proposed' }],
      },
      { role: 'tool', content: 'result text', toolCallId: 'c1' },
    ]
    const { instructions, input } = messagesToResponses(messages)
    expect(instructions).toContain('Be terse.')
    expect(input[0]).toEqual({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] })
    expect(input[1]).toEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] })
    expect(input[2]).toEqual({ type: 'function_call', call_id: 'c1', name: 'search', arguments: '{"q":1}' })
    expect(input[3]).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'result text' })
  })

  it('maps user image parts to input_image', () => {
    const { input } = messagesToResponses([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ])
    expect(input[0]).toMatchObject({
      content: [
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
      ],
    })
  })
})

describe('toolsToResponses + buildResponsesBody', () => {
  it('uses the flat function shape and sets tool_choice when tools exist', () => {
    const tools = toolsToResponses([{ name: 'get', description: 'd', parameters: { type: 'object' } }])
    expect(tools[0]).toEqual({
      type: 'function',
      name: 'get',
      description: 'd',
      parameters: { type: 'object' },
      strict: false,
    })
    const body = buildResponsesBody(
      {
        modelId: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        params: { maxTokens: 42, temperature: 0.5 },
        tools: [{ name: 'get', description: 'd', parameters: { type: 'object' } }],
        stream: true,
      },
      true
    )
    expect(body).toMatchObject({
      model: 'gpt-5',
      stream: true,
      store: false,
      max_output_tokens: 42,
      temperature: 0.5,
      tool_choice: 'auto',
    })
    expect(Array.isArray(body.input)).toBe(true)
  })
})

describe('parseResponsesEvent', () => {
  it('maps text, reasoning, tool call, and usage events', () => {
    expect(parseResponsesEvent({ type: 'response.output_text.delta', delta: 'Hi' })).toEqual([
      { type: 'text', text: 'Hi' },
    ])
    expect(parseResponsesEvent({ type: 'response.reasoning_text.delta', delta: 'think' })).toEqual([
      { type: 'reasoning', text: 'think' },
    ])
    const toolEv = parseResponsesEvent({
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'c9', name: 'run', arguments: '{}' },
    })
    expect(toolEv).toEqual([
      { type: 'tool_call', toolCall: { id: 'c9', name: 'run', arguments: '{}', status: 'proposed' } },
    ])
    expect(
      parseResponsesEvent({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 7 } } })
    ).toEqual([{ type: 'usage', usage: { promptTokens: 3, completionTokens: 7, totalTokens: 10 } }])
  })

  it('ignores unknown / malformed events', () => {
    expect(parseResponsesEvent({ type: 'response.created' })).toEqual([])
    expect(parseResponsesEvent(null)).toEqual([])
  })
})

describe('registry.resolveAdapter for OpenAI auth modes', () => {
  it('selects the Codex/Responses adapter only for chatgpt_oauth', () => {
    const oauth = resolveAdapter('openai', 'chatgpt_oauth')
    const apiKey = resolveAdapter('openai', 'api_key')
    expect(oauth).toBeInstanceOf(CodexClass)
    expect(apiKey).not.toBeInstanceOf(CodexClass)
    // Both report type 'openai'.
    expect(new OpenAICodexAdapter().type).toBe('openai')
  })
})
