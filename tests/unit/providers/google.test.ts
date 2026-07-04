import { describe, expect, it } from 'vitest'
import type { AdapterMessage, AdapterStreamEvent } from '../../../src/main/providers/adapter'
import {
  GoogleAdapter,
  buildGeminiBody,
  parseGeminiChunk,
  toGeminiTools,
} from '../../../src/main/providers/google'

/** A ReadableStream that emits the given SSE text chunks, for driving chatStream. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]))
      else controller.close()
    },
  })
}

async function collectStream(chunks: string[]): Promise<AdapterStreamEvent[]> {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    body: sseStream(chunks),
    headers: new Headers(),
  })) as unknown as typeof fetch
  const out: AdapterStreamEvent[] = []
  for await (const e of new GoogleAdapter().chatStream(
    { modelId: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }], params: {}, stream: true },
    { apiKey: 'k', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', fetchImpl }
  ))
    out.push(e)
  return out
}

describe('buildGeminiBody', () => {
  it('maps roles, systemInstruction, functionResponse (by name), tools', () => {
    const messages: AdapterMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":1}', status: 'proposed' }] },
      { role: 'tool', content: 'result', toolCallId: 'c1' },
    ]
    const body = buildGeminiBody({
      modelId: 'gemini-3.5-flash',
      messages,
      params: { temperature: 0.4, maxTokens: 100 },
      tools: [{ name: 'search', description: 'd', parameters: { type: 'object' } }],
      stream: true,
    }) as Record<string, unknown>

    expect(body.systemInstruction).toEqual({ parts: [{ text: 'S' }] })
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] })
    expect(contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'search', args: { q: 1 } } }] })
    // Tool result keyed by function NAME (looked up from the call id).
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'search', response: { result: 'result' } } }],
    })
    expect(body.generationConfig).toEqual({ temperature: 0.4, maxOutputTokens: 100 })
    expect(toGeminiTools([{ name: 'search', description: 'd', parameters: { type: 'object' } }])![0]).toHaveProperty(
      'functionDeclarations'
    )
  })
})

describe('parseGeminiChunk', () => {
  it('maps text, thought→reasoning, functionCall→tool_call, usage, finish', () => {
    const out = parseGeminiChunk({
      candidates: [
        {
          content: {
            parts: [
              { text: 'thinking...', thought: true },
              { text: 'Hello' },
              { functionCall: { name: 'run', args: { x: 2 } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
    })
    expect(out).toContainEqual({ type: 'reasoning', text: 'thinking...' })
    expect(out).toContainEqual({ type: 'text', text: 'Hello' })
    expect(out).toContainEqual({
      type: 'tool_call',
      toolCall: { id: 'run', name: 'run', arguments: '{"x":2}', status: 'proposed' },
    })
    expect(out).toContainEqual({ type: 'finish', reason: 'stop' })
    expect(out).toContainEqual({
      type: 'usage',
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    })
  })
})

describe('GoogleAdapter.chatStream', () => {
  it('overrides Gemini STOP → tool_calls when the final chunk carries a functionCall', async () => {
    // Gemini reports finishReason:"STOP" even on a turn that emits a functionCall.
    const events = await collectStream([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"run","args":{"x":2}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7}}\n\n',
    ])
    const finish = events.filter((e) => e.type === 'finish')
    expect(finish).toEqual([{ type: 'finish', reason: 'tool_calls' }])
    const toolCalls = events.filter((e) => e.type === 'tool_call')
    expect(toolCalls).toHaveLength(1)
    // The name-only call gets a unique, non-empty id assigned.
    expect(toolCalls[0].type === 'tool_call' && toolCalls[0].toolCall.id).toBeTruthy()
  })

  it('emits usage once (last-wins) despite cumulative per-chunk usageMetadata', async () => {
    // streamGenerateContent repeats cumulative usage on every chunk; summing them
    // would inflate promptTokens to 30. A plain STOP must stay 'stop'.
    const events = await collectStream([
      'data: {"candidates":[{"content":{"parts":[{"text":"He"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11}}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"llo"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12}}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}}\n\n',
    ])
    const usage = events.filter((e) => e.type === 'usage')
    expect(usage).toEqual([
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 } },
    ])
    const finish = events.filter((e) => e.type === 'finish')
    expect(finish).toEqual([{ type: 'finish', reason: 'stop' }])
  })
})

describe('GoogleAdapter error redaction', () => {
  it('never leaks the api key in a failed connection test', async () => {
    const KEY = 'AIza-secret-123'
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      text: async () => `bad key ${KEY}`,
      headers: new Headers(),
    })) as unknown as typeof fetch
    const res = await new GoogleAdapter().testConnection({
      apiKey: KEY,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      fetchImpl,
    })
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain(KEY)
  })
})
