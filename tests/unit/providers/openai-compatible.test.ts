import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleAdapter } from '../../../src/main/providers/openai-compatible'
import { ProviderError } from '../../../src/main/providers/errors'
import type {
  AdapterChatRequest,
  AdapterContext,
  AdapterStreamEvent,
} from '../../../src/main/providers/adapter'
import {
  makeFetchSequence,
  makeJsonResponse,
  makeSSEResponse,
  type FetchMock,
} from '../../helpers/mock-fetch'

const API_KEY = 'sk-supersecret1234'
const BASE_URL = 'https://api.example.com/v1'

const adapter = new OpenAICompatibleAdapter()

function ctx(fetchImpl: FetchMock, overrides: Partial<AdapterContext> = {}): AdapterContext {
  return { apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl, ...overrides }
}

function req(overrides: Partial<AdapterChatRequest> = {}): AdapterChatRequest {
  return {
    modelId: 'test-model',
    messages: [{ role: 'user', content: 'Hi' }],
    params: {},
    stream: false,
    ...overrides,
  }
}

function completionBody(text: string): Record<string, unknown> {
  return {
    id: 'cmpl-1',
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
  }
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

async function collect(gen: AsyncGenerator<AdapterStreamEvent>): Promise<AdapterStreamEvent[]> {
  const events: AdapterStreamEvent[] = []
  for await (const ev of gen) events.push(ev)
  return events
}

/**
 * Runs chat() under fake timers so retry backoff sleeps complete instantly,
 * and returns the eventual rejection (retryable codes get retried by chat()).
 */
async function chatFailure(mock: FetchMock): Promise<ProviderError> {
  vi.useFakeTimers()
  try {
    const settled = adapter.chat(req(), ctx(mock)).then(
      () => {
        throw new Error('expected chat() to reject')
      },
      (e: unknown) => e as ProviderError
    )
    await vi.runAllTimersAsync()
    return await settled
  } finally {
    vi.useRealTimers()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('OpenAICompatibleAdapter.chat (non-streaming)', () => {
  it('POSTs to {baseUrl}/chat/completions regardless of trailing slash', async () => {
    const mock1 = makeFetchSequence(makeJsonResponse(200, completionBody('a')))
    await adapter.chat(req(), ctx(mock1, { baseUrl: 'https://api.example.com/v1' }))
    const mock2 = makeFetchSequence(makeJsonResponse(200, completionBody('b')))
    await adapter.chat(req(), ctx(mock2, { baseUrl: 'https://api.example.com/v1/' }))

    expect(mock1.requests[0].url).toBe('https://api.example.com/v1/chat/completions')
    expect(mock2.requests[0].url).toBe('https://api.example.com/v1/chat/completions')
    expect(mock1.requests[0].init?.method).toBe('POST')
  })

  it('sends Authorization header and maps params, omitting the unset ones', async () => {
    const mock = makeFetchSequence(makeJsonResponse(200, completionBody('ok')))
    await adapter.chat(
      req({ params: { temperature: 0.7, maxTokens: 100, topP: 0.9 } }),
      ctx(mock)
    )

    const { init, body } = mock.requests[0]
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`)
    expect(headers['Content-Type']).toBe('application/json')

    const parsed = body as Record<string, unknown>
    expect(parsed.model).toBe('test-model')
    expect(parsed.messages).toEqual([{ role: 'user', content: 'Hi' }])
    expect(parsed.stream).toBe(false)
    expect(parsed.temperature).toBe(0.7)
    expect(parsed.max_tokens).toBe(100)
    expect(parsed.top_p).toBe(0.9)
    expect(parsed).not.toHaveProperty('frequency_penalty')
    expect(parsed).not.toHaveProperty('presence_penalty')
    expect(parsed).not.toHaveProperty('tools')
  })

  it('maps the response into text, usage and finishReason', async () => {
    const mock = makeFetchSequence(makeJsonResponse(200, completionBody('Hello!')))
    const result = await adapter.chat(req(), ctx(mock))

    expect(result.text).toBe('Hello!')
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 5, totalTokens: 8 })
    expect(result.finishReason).toBe('stop')
    expect(result.toolCalls).toEqual([])
  })

  it("prefers 'tool_calls' when a quirky server returns tool calls with finish_reason 'stop'", async () => {
    const mock = makeFetchSequence(
      makeJsonResponse(200, {
        id: 'cmpl-1',
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      })
    )
    const result = await adapter.chat(req(), ctx(mock))
    expect(result.toolCalls).toHaveLength(1)
    expect(result.finishReason).toBe('tool_calls')
  })
})

describe('OpenAICompatibleAdapter.chatStream', () => {
  it('parses SSE across chunk boundaries, incl. a split data: line and a split multi-byte char', async () => {
    const full =
      sse({ choices: [{ delta: { content: 'Hello' } }] }) +
      sse({ choices: [{ delta: { content: ' wörld' } }] }) +
      sse({ choices: [{ delta: { reasoning_content: 'thinking…' } }] }) +
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
      sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }) +
      'data: [DONE]\n\n'
    const bytes = new TextEncoder().encode(full)
    // Everything before the ö is ASCII, so char index == byte index here.
    const midDataLine = full.indexOf('"Hello"') + 3
    const oIndex = bytes.indexOf(0xc3) // first byte of the two-byte 'ö'
    expect(midDataLine).toBeGreaterThan(0)
    expect(oIndex).toBeGreaterThan(midDataLine)
    const chunks = [
      bytes.slice(0, midDataLine),
      bytes.slice(midDataLine, oIndex + 1),
      bytes.slice(oIndex + 1),
    ]

    const mock = makeFetchSequence(makeSSEResponse(chunks))
    const events = await collect(adapter.chatStream(req({ stream: true }), ctx(mock)))

    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' wörld' },
      { type: 'reasoning', text: 'thinking…' },
      { type: 'usage', usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } },
      { type: 'finish', reason: 'stop' },
    ])
    expect((mock.requests[0].body as Record<string, unknown>).stream).toBe(true)
  })

  it('stops at [DONE] and ignores anything after it', async () => {
    const mock = makeFetchSequence(
      makeSSEResponse([
        sse({ choices: [{ delta: { content: 'first' } }] }),
        'data: [DONE]\n\n',
        sse({ choices: [{ delta: { content: 'never' } }] }),
      ])
    )
    const events = await collect(adapter.chatStream(req({ stream: true }), ctx(mock)))
    expect(events).toEqual([
      { type: 'text', text: 'first' },
      { type: 'finish', reason: 'stop' },
    ])
  })

  it('assembles tool_call deltas split across chunks into one event', async () => {
    const mock = makeFetchSequence(
      makeSSEResponse([
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '' },
                  },
                ],
              },
            },
          ],
        }),
        sse({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }],
        }),
        sse({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] } },
          ],
        }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ])
    )
    const events = await collect(adapter.chatStream(req({ stream: true }), ctx(mock)))

    expect(events).toEqual([
      {
        type: 'tool_call',
        toolCall: {
          id: 'call_abc',
          name: 'get_weather',
          arguments: '{"city":"Oslo"}',
          status: 'proposed',
        },
      },
      { type: 'finish', reason: 'tool_calls' },
    ])
  })

  it("finishes as 'tool_calls' when tool calls stream in but finish_reason is 'stop'", async () => {
    const mock = makeFetchSequence(
      makeSSEResponse([
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_x', type: 'function', function: { name: 'f', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ])
    )
    const events = await collect(adapter.chatStream(req({ stream: true }), ctx(mock)))
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' })
  })

  it("maps finish_reason 'length'", async () => {
    const mock = makeFetchSequence(
      makeSSEResponse([
        sse({ choices: [{ delta: { content: 'cut' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'length' }] }),
        'data: [DONE]\n\n',
      ])
    )
    const events = await collect(adapter.chatStream(req({ stream: true }), ctx(mock)))
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'length' })
  })

  it("aborting mid-stream throws an 'aborted' ProviderError", async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse({ choices: [{ delta: { content: 'Hel' } }] })))
      },
      pull() {
        return new Promise<never>(() => {}) // hang forever; only abort can end it
      },
    })
    const mock = makeFetchSequence(new Response(body, { status: 200 }))
    const controller = new AbortController()

    const events: AdapterStreamEvent[] = []
    let thrown: unknown = null
    try {
      for await (const ev of adapter.chatStream(
        req({ stream: true }),
        ctx(mock, { signal: controller.signal })
      )) {
        events.push(ev)
        controller.abort()
      }
    } catch (e) {
      thrown = e
    }

    expect(events).toEqual([{ type: 'text', text: 'Hel' }])
    expect(thrown).toBeInstanceOf(ProviderError)
    expect((thrown as ProviderError).code).toBe('aborted')
  })
})

describe('error normalization', () => {
  it("401 -> 'auth', non-retryable, exactly one fetch call", async () => {
    const mock = makeFetchSequence(
      makeJsonResponse(401, { error: { message: 'Invalid Authentication' } })
    )
    const err = await chatFailure(mock)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.code).toBe('auth')
    expect(err.retryable).toBe(false)
    expect(err.status).toBe(401)
    expect(mock.requests).toHaveLength(1)
  })

  it("429 with Retry-After: 7 -> 'rate_limit', retryable, retryAfterSec 7", async () => {
    const rateLimited = (): Response =>
      makeJsonResponse(429, { error: { message: 'Too many requests' } }, { 'retry-after': '7' })
    // Retryable: chat() retries twice before surfacing the error.
    const mock = makeFetchSequence(rateLimited, rateLimited, rateLimited)
    const err = await chatFailure(mock)
    expect(err.code).toBe('rate_limit')
    expect(err.retryable).toBe(true)
    expect(err.retryAfterSec).toBe(7)
    expect(err.status).toBe(429)
    expect(mock.requests).toHaveLength(3)
  })

  it("400 with OpenAI error body -> 'invalid_request' including the provider message", async () => {
    const mock = makeFetchSequence(
      makeJsonResponse(400, { error: { message: "model 'gpt-x' does not exist" } })
    )
    const err = await chatFailure(mock)
    expect(err.code).toBe('invalid_request')
    expect(err.retryable).toBe(false)
    expect(err.message).toContain("model 'gpt-x' does not exist")
  })

  it("500 -> 'server', retryable", async () => {
    const boom = (): Response => makeJsonResponse(500, { error: { message: 'internal' } })
    const mock = makeFetchSequence(boom, boom, boom)
    const err = await chatFailure(mock)
    expect(err.code).toBe('server')
    expect(err.retryable).toBe(true)
    expect(err.status).toBe(500)
  })

  it('keeps Retry-After on retryable 5xx/408 so the backoff honors it', async () => {
    const unavailable = (): Response =>
      makeJsonResponse(503, { error: { message: 'overloaded' } }, { 'retry-after': '10' })
    const err = await chatFailure(makeFetchSequence(unavailable, unavailable, unavailable))
    expect(err.code).toBe('server')
    expect(err.retryAfterSec).toBe(10)

    const timedOut = (): Response =>
      makeJsonResponse(408, { error: { message: 'too slow' } }, { 'retry-after': '3' })
    const err408 = await chatFailure(makeFetchSequence(timedOut, timedOut, timedOut))
    expect(err408.code).toBe('timeout')
    expect(err408.retryAfterSec).toBe(3)
  })

  it("network TypeError -> 'network'", async () => {
    const mock = makeFetchSequence(
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      new TypeError('fetch failed')
    )
    const err = await chatFailure(mock)
    expect(err.code).toBe('network')
    expect(err.retryable).toBe(true)
  })
})

describe('retry behavior through chat()', () => {
  it('succeeds after a retryable 500 (two fetch calls)', async () => {
    const mock = makeFetchSequence(
      makeJsonResponse(500, 'temporary'),
      makeJsonResponse(200, completionBody('recovered'))
    )
    vi.useFakeTimers()
    const settled = adapter.chat(req(), ctx(mock))
    const guarded = settled.then((r) => r)
    await vi.runAllTimersAsync()
    const result = await guarded
    vi.useRealTimers()

    expect(result.text).toBe('recovered')
    expect(mock.requests).toHaveLength(2)
  })

  it('never retries a 401 (single fetch call)', async () => {
    const mock = makeFetchSequence(makeJsonResponse(401, { error: { message: 'nope' } }))
    const err = await chatFailure(mock)
    expect(err.code).toBe('auth')
    expect(mock.requests).toHaveLength(1)
  })
})

describe('SECURITY: the API key never leaks into error messages', () => {
  const scenarios: Array<{ name: string; make: () => FetchMock }> = [
    {
      name: '401 auth error echoing the key',
      make: () =>
        makeFetchSequence(makeJsonResponse(401, { error: { message: `bad key ${API_KEY}` } })),
    },
    {
      name: '429 rate limit echoing the key',
      make: () => {
        const r = (): Response =>
          makeJsonResponse(429, { error: { message: `slow down ${API_KEY}` } }, { 'retry-after': '1' })
        return makeFetchSequence(r, r, r)
      },
    },
    {
      name: '400 invalid request echoing the key',
      make: () =>
        makeFetchSequence(
          makeJsonResponse(400, { error: { message: `invalid request from ${API_KEY}` } })
        ),
    },
    {
      name: '500 server error echoing the key',
      make: () => {
        const r = (): Response =>
          makeJsonResponse(500, { error: { message: `crashed handling ${API_KEY}` } })
        return makeFetchSequence(r, r, r)
      },
    },
    {
      name: 'network TypeError containing the key',
      make: () => {
        const e = (): TypeError => new TypeError(`connect failed for key ${API_KEY}`)
        return makeFetchSequence(e(), e(), e())
      },
    },
  ]

  for (const { name, make } of scenarios) {
    it(name, async () => {
      const err = await chatFailure(make())
      expect(err).toBeInstanceOf(ProviderError)
      expect(err.message.length).toBeGreaterThan(0)
      expect(err.message).not.toContain(API_KEY)
    })
  }
})
