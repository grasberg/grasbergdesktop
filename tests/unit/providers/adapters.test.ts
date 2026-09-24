import { describe, expect, it } from 'vitest'
import { PROVIDER_TYPES } from '@shared/catalog'
import { DeepSeekAdapter } from '../../../src/main/providers/deepseek'
import { ZhipuAdapter } from '../../../src/main/providers/zhipu'
import { MiniMaxAdapter } from '../../../src/main/providers/minimax'
import { OpenAICompatibleAdapter } from '../../../src/main/providers/openai-compatible'
import { getAdapter } from '../../../src/main/providers/registry'
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

function ctx(fetchImpl: FetchMock): AdapterContext {
  return { apiKey: 'sk-testkey-abcdef', baseUrl: 'https://api.example.com/v1', fetchImpl }
}

function req(overrides: Partial<AdapterChatRequest> = {}): AdapterChatRequest {
  return {
    modelId: 'some-model',
    messages: [{ role: 'user', content: 'Hi' }],
    params: {},
    stream: false,
    ...overrides,
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

describe('DeepSeekAdapter', () => {
  it('yields reasoning events for streamed reasoning_content and requests usage via stream_options', async () => {
    const mock = makeFetchSequence(
      makeSSEResponse([
        sse({ choices: [{ delta: { reasoning_content: 'Let me think.' } }] }),
        sse({ choices: [{ delta: { content: '42' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
        'data: [DONE]\n\n',
      ])
    )
    const adapter = new DeepSeekAdapter()
    const events = await collect(adapter.chatStream(req({ stream: true }), ctx(mock)))

    // sendStreamOptions=true -> stream_options.include_usage in the request body.
    const body = mock.requests[0].body as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })

    expect(events).toEqual([
      { type: 'reasoning', text: 'Let me think.' },
      { type: 'text', text: '42' },
      { type: 'usage', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
      { type: 'finish', reason: 'stop' },
    ])
  })

  it('does not send stream_options on non-streaming requests', async () => {
    const mock = makeFetchSequence(
      makeJsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      })
    )
    await new DeepSeekAdapter().chat(req(), ctx(mock))
    expect(mock.requests[0].body as Record<string, unknown>).not.toHaveProperty('stream_options')
  })
})

describe('listModels for providers without a /models endpoint', () => {
  it('ZhipuAdapter falls back to catalog when discovery fails', async () => {
    const mock = makeFetchSequence()
    const models = await new ZhipuAdapter().listModels(ctx(mock))
    expect(models).toEqual(PROVIDER_TYPES.zhipu.knownModels)
    expect(mock.requests).toHaveLength(1)
  })

  it('MiniMaxAdapter falls back to catalog when discovery fails', async () => {
    const mock = makeFetchSequence()
    const models = await new MiniMaxAdapter().listModels(ctx(mock))
    expect(models).toEqual(PROVIDER_TYPES.minimax.knownModels)
    expect(mock.requests).toHaveLength(1)
  })
})

describe('MiniMaxAdapter base_resp handling', () => {
  it("HTTP 200 with base_resp status_code 1004 -> ProviderError 'auth'", async () => {
    const mock = makeFetchSequence(
      makeJsonResponse(200, {
        base_resp: { status_code: 1004, status_msg: 'invalid api key' },
      })
    )
    const adapter = new MiniMaxAdapter()
    await expect(adapter.chat(req(), ctx(mock))).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'auth',
      retryable: false,
      providerType: 'minimax',
    })
    expect(mock.requests).toHaveLength(1) // auth is never retried
  })

  it('HTTP 200 with base_resp status_code 0 parses as a normal completion', async () => {
    const mock = makeFetchSequence(
      makeJsonResponse(200, {
        base_resp: { status_code: 0, status_msg: 'success' },
        choices: [{ message: { role: 'assistant', content: 'Hello from MiniMax' }, finish_reason: 'stop' }],
        usage: { total_tokens: 9 },
      })
    )
    const result = await new MiniMaxAdapter().chat(req(), ctx(mock))
    expect(result.text).toBe('Hello from MiniMax')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({
      promptTokens: undefined,
      completionTokens: undefined,
      totalTokens: 9,
    })
  })

  it('redacts the key when MiniMax echoes it in status_msg', async () => {
    const key = 'sk-supersecret1234'
    const mock = makeFetchSequence(
      makeJsonResponse(200, {
        base_resp: { status_code: 1004, status_msg: `key ${key} rejected` },
      })
    )
    const adapter = new MiniMaxAdapter()
    const err = await adapter
      .chat(req(), { apiKey: key, baseUrl: 'https://api.example.com/v1', fetchImpl: mock })
      .then(
        () => null,
        (e: unknown) => e as ProviderError
      )
    expect(err).toBeInstanceOf(ProviderError)
    expect(err!.message).not.toContain(key)
  })
})

describe('registry', () => {
  it('memoizes one adapter instance per provider type', () => {
    expect(getAdapter('deepseek')).toBe(getAdapter('deepseek'))
    expect(getAdapter('zhipu')).toBe(getAdapter('zhipu'))
    expect(getAdapter('minimax')).toBe(getAdapter('minimax'))
    expect(getAdapter('openai-compatible')).toBe(getAdapter('openai-compatible'))
  })

  it('returns the correct concrete adapter per type', () => {
    expect(getAdapter('deepseek')).toBeInstanceOf(DeepSeekAdapter)
    expect(getAdapter('zhipu')).toBeInstanceOf(ZhipuAdapter)
    expect(getAdapter('minimax')).toBeInstanceOf(MiniMaxAdapter)
    expect(getAdapter('openai-compatible')).toBeInstanceOf(OpenAICompatibleAdapter)
    expect(getAdapter('deepseek').type).toBe('deepseek')
    expect(getAdapter('openai-compatible').type).toBe('openai-compatible')
    expect(getAdapter('deepseek')).not.toBe(getAdapter('zhipu'))
  })
})
