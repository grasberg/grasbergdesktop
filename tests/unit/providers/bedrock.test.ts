import { describe, expect, it } from 'vitest'
import type { AdapterMessage, AdapterStreamEvent } from '../../../src/main/providers/adapter'
import {
  BedrockAdapter,
  EventStreamParser,
  buildConverseBody,
  mapConverseResult,
  toConverseMessages,
} from '../../../src/main/providers/bedrock'
import { makeSSEResponse } from '../../helpers/mock-fetch'

/**
 * Builds one binary application/vnd.amazon.eventstream frame: prelude
 * (total length, headers length, CRC), string headers (type 7), JSON payload,
 * message CRC. CRCs are zeroed — the parser deliberately ignores them.
 */
function frame(headers: Record<string, string>, payload: unknown): Uint8Array {
  const enc = new TextEncoder()
  const payloadBytes = enc.encode(typeof payload === 'string' ? payload : JSON.stringify(payload))
  const headerParts: number[] = []
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = enc.encode(name)
    const valueBytes = enc.encode(value)
    headerParts.push(nameBytes.length, ...nameBytes, 7)
    headerParts.push((valueBytes.length >> 8) & 0xff, valueBytes.length & 0xff, ...valueBytes)
  }
  const headerBytes = new Uint8Array(headerParts)
  const totalLength = 12 + headerBytes.length + payloadBytes.length + 4
  const out = new Uint8Array(totalLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, totalLength)
  view.setUint32(4, headerBytes.length)
  out.set(headerBytes, 12)
  out.set(payloadBytes, 12 + headerBytes.length)
  return out
}

function concat(frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((n, f) => n + f.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const f of frames) {
    out.set(f, off)
    off += f.length
  }
  return out
}

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

describe('EventStreamParser', () => {
  it('reassembles frames split at arbitrary chunk boundaries', () => {
    const bytes = concat([
      frame({ ':message-type': 'event', ':event-type': 'a' }, { n: 1 }),
      frame({ ':message-type': 'event', ':event-type': 'b' }, { n: 2 }),
    ])
    const parser = new EventStreamParser()
    const got: string[] = []
    // Feed 7 bytes at a time — every frame is split mid-prelude/header/payload.
    for (let i = 0; i < bytes.length; i += 7) {
      for (const msg of parser.push(bytes.subarray(i, i + 7))) {
        got.push(`${msg.headers[':event-type']}:${msg.payload}`)
      }
    }
    expect(got).toEqual(['a:{"n":1}', 'b:{"n":2}'])
  })
})

describe('BedrockAdapter', () => {
  it('chatStream streams ConverseStream frames: text deltas, assembled tool call, usage, finish', async () => {
    const frames = [
      frame({ ':message-type': 'event', ':event-type': 'messageStart' }, { role: 'assistant' }),
      frame(
        { ':message-type': 'event', ':event-type': 'contentBlockDelta' },
        { contentBlockIndex: 0, delta: { text: 'Hel' } }
      ),
      frame(
        { ':message-type': 'event', ':event-type': 'contentBlockDelta' },
        { contentBlockIndex: 0, delta: { text: 'lo' } }
      ),
      frame({ ':message-type': 'event', ':event-type': 'contentBlockStop' }, { contentBlockIndex: 0 }),
      frame(
        { ':message-type': 'event', ':event-type': 'contentBlockStart' },
        { contentBlockIndex: 1, start: { toolUse: { toolUseId: 't1', name: 'f' } } }
      ),
      frame(
        { ':message-type': 'event', ':event-type': 'contentBlockDelta' },
        { contentBlockIndex: 1, delta: { toolUse: { input: '{"a":' } } }
      ),
      frame(
        { ':message-type': 'event', ':event-type': 'contentBlockDelta' },
        { contentBlockIndex: 1, delta: { toolUse: { input: '1}' } } }
      ),
      frame({ ':message-type': 'event', ':event-type': 'contentBlockStop' }, { contentBlockIndex: 1 }),
      frame({ ':message-type': 'event', ':event-type': 'messageStop' }, { stopReason: 'tool_use' }),
      frame(
        { ':message-type': 'event', ':event-type': 'metadata' },
        { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
      ),
    ]
    // One byte-blob split into 11-byte chunks: proves incremental reassembly
    // straight through the adapter's read loop.
    const bytes = concat(frames)
    const chunks: Uint8Array[] = []
    for (let i = 0; i < bytes.length; i += 11) chunks.push(bytes.subarray(i, i + 11))

    let requestedUrl = ''
    const fetchImpl = (async (url: string | URL | Request) => {
      requestedUrl = String(url)
      return makeSSEResponse(chunks)
    }) as unknown as typeof fetch

    const events: AdapterStreamEvent[] = []
    for await (const e of new BedrockAdapter().chatStream(
      { modelId: 'us.anthropic.claude-sonnet-5', messages: [{ role: 'user', content: 'x' }], params: {}, stream: true },
      { apiKey: 'k', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', fetchImpl }
    )) {
      events.push(e)
    }
    expect(requestedUrl).toContain('/converse-stream')
    expect(events.map((e) => e.type)).toEqual(['text', 'text', 'tool_call', 'usage', 'finish'])
    expect(events[0]).toEqual({ type: 'text', text: 'Hel' })
    expect(events[2]).toMatchObject({
      toolCall: { id: 't1', name: 'f', arguments: '{"a":1}', status: 'proposed' },
    })
    expect(events[3]).toMatchObject({ usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } })
    expect(events[4]).toEqual({ type: 'finish', reason: 'tool_calls' })
  })

  it('surfaces an exception frame as a ProviderError without wedging the stream', async () => {
    const chunks = [
      frame(
        { ':message-type': 'exception', ':exception-type': 'throttlingException' },
        { message: 'Too many requests' }
      ),
    ]
    const fetchImpl = (async () => makeSSEResponse(chunks)) as unknown as typeof fetch
    const iterate = async (): Promise<void> => {
      for await (const _e of new BedrockAdapter().chatStream(
        { modelId: 'm', messages: [{ role: 'user', content: 'x' }], params: {}, stream: true },
        { apiKey: 'k', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', fetchImpl }
      )) {
        // drain
      }
    }
    await expect(iterate()).rejects.toThrow(/throttlingException.*Too many requests/)
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
