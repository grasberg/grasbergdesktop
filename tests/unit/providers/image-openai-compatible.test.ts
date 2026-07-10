/**
 * generateImage on the OpenAI-compatible base (and the Zhipu/CogView
 * subclass): request shaping per model family, b64 + URL-download result
 * paths, https enforcement, size mapping, error normalization and proof that
 * the API key never leaks into thrown errors.
 */

import { describe, expect, it } from 'vitest'
import { ProviderError } from '../../../src/main/providers/errors'
import {
  GENERATED_IMAGE_MAX_BYTES,
  OpenAICompatibleAdapter,
  mapOpenAiImageSize,
} from '../../../src/main/providers/openai-compatible'
import { ZhipuAdapter, mapCogViewSize } from '../../../src/main/providers/zhipu'
import type { AdapterContext } from '../../../src/main/providers/adapter'
import { makeFetchSequence, makeJsonResponse } from '../../helpers/mock-fetch'

const KEY = 'sk-image-secret-123'

function ctx(fetchImpl: AdapterContext['fetchImpl']): AdapterContext {
  return { apiKey: KEY, baseUrl: 'https://api.example/v1', fetchImpl }
}

/** 1x1 PNG bytes, as base64. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('mapOpenAiImageSize / mapCogViewSize', () => {
  it('maps per family and omits auto', () => {
    expect(mapOpenAiImageSize('gpt-image-2', 'landscape')).toBe('1536x1024')
    expect(mapOpenAiImageSize('gpt-image-1', 'portrait')).toBe('1024x1536')
    expect(mapOpenAiImageSize('dall-e-3', 'landscape')).toBe('1792x1024')
    expect(mapOpenAiImageSize('dall-e-3', 'auto')).toBeUndefined()
    expect(mapOpenAiImageSize('some-model', 'square')).toBe('1024x1024')
    expect(mapOpenAiImageSize('some-model', 'landscape')).toBeUndefined()
    expect(mapCogViewSize('landscape')).toBe('1344x768')
    expect(mapCogViewSize(undefined)).toBeUndefined()
  })
})

describe('OpenAICompatibleAdapter.generateImage', () => {
  it('posts to /images/generations and decodes a b64 result (gpt-image: no response_format)', async () => {
    const fetchImpl = makeFetchSequence(
      makeJsonResponse(200, { created: 1, data: [{ b64_json: PNG_B64, revised_prompt: 'a fox, digital art' }] })
    )
    const adapter = new OpenAICompatibleAdapter()
    const images = await adapter.generateImage(
      { modelId: 'gpt-image-2', prompt: 'a fox', count: 1, size: 'square' },
      ctx(fetchImpl)
    )

    expect(fetchImpl.requests).toHaveLength(1)
    expect(fetchImpl.requests[0].url).toBe('https://api.example/v1/images/generations')
    const body = fetchImpl.requests[0].body as Record<string, unknown>
    expect(body.model).toBe('gpt-image-2')
    expect(body.prompt).toBe('a fox')
    expect(body.size).toBe('1024x1024')
    expect(body.n).toBeUndefined() // count 1 stays off the wire
    expect(body.response_format).toBeUndefined() // gpt-image rejects it

    expect(images).toHaveLength(1)
    expect(images[0].mimeType).toBe('image/png')
    expect(images[0].bytes.byteLength).toBeGreaterThan(0)
    expect(images[0].revisedPrompt).toBe('a fox, digital art')
  })

  it('requests b64_json for non-gpt-image models and sends n for count > 1', async () => {
    const fetchImpl = makeFetchSequence(
      makeJsonResponse(200, { data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }] })
    )
    const adapter = new OpenAICompatibleAdapter()
    const images = await adapter.generateImage(
      { modelId: 'dall-e-3', prompt: 'two cats', count: 2 },
      ctx(fetchImpl)
    )
    const body = fetchImpl.requests[0].body as Record<string, unknown>
    expect(body.response_format).toBe('b64_json')
    expect(body.n).toBe(2)
    expect(images).toHaveLength(2)
  })

  it('downloads https result URLs and refuses http ones', async () => {
    const bytes = Buffer.from(PNG_B64, 'base64')
    const ok = makeFetchSequence(
      makeJsonResponse(200, { data: [{ url: 'https://cdn.example/img.png' }] }),
      new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    )
    const adapter = new OpenAICompatibleAdapter()
    const images = await adapter.generateImage(
      { modelId: 'dall-e-3', prompt: 'x', count: 1 },
      ctx(ok)
    )
    expect(ok.requests[1].url).toBe('https://cdn.example/img.png')
    // The download must not carry the Authorization header (pre-signed URL).
    const headers = (ok.requests[1].init?.headers ?? {}) as Record<string, string>
    expect(JSON.stringify(headers)).not.toContain(KEY)
    expect(images[0].mimeType).toBe('image/png')

    const insecure = makeFetchSequence(
      makeJsonResponse(200, { data: [{ url: 'http://cdn.example/img.png' }] })
    )
    await expect(
      adapter.generateImage({ modelId: 'dall-e-3', prompt: 'x', count: 1 }, ctx(insecure))
    ).rejects.toThrow(/non-https/i)
  })

  it('normalizes HTTP errors and never leaks the API key', async () => {
    const fetchImpl = makeFetchSequence(
      makeJsonResponse(401, { error: { message: `bad key ${KEY} rejected` } })
    )
    const adapter = new OpenAICompatibleAdapter()
    let thrown: unknown
    try {
      await adapter.generateImage({ modelId: 'gpt-image-2', prompt: 'x', count: 1 }, ctx(fetchImpl))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ProviderError)
    const err = thrown as ProviderError
    expect(err.code).toBe('auth')
    expect(err.message).not.toContain(KEY)
  })

  it('rejects empty data and oversized images', async () => {
    const adapter = new OpenAICompatibleAdapter()
    const empty = makeFetchSequence(makeJsonResponse(200, { data: [{}] }))
    await expect(
      adapter.generateImage({ modelId: 'gpt-image-2', prompt: 'x', count: 1 }, ctx(empty))
    ).rejects.toThrow(/no image/i)

    const huge = makeFetchSequence(
      makeJsonResponse(200, {
        data: [{ b64_json: Buffer.alloc(GENERATED_IMAGE_MAX_BYTES + 1).toString('base64') }],
      })
    )
    await expect(
      adapter.generateImage({ modelId: 'gpt-image-2', prompt: 'x', count: 1 }, ctx(huge))
    ).rejects.toThrow(/too large/i)
  })
})

describe('ZhipuAdapter.generateImage (CogView)', () => {
  it('prunes n/response_format, uses CogView sizes and downloads the result URL', async () => {
    const bytes = Buffer.from(PNG_B64, 'base64')
    const fetchImpl = makeFetchSequence(
      makeJsonResponse(200, { data: [{ url: 'https://zhipu.example/out.png' }] }),
      new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    )
    const adapter = new ZhipuAdapter()
    const images = await adapter.generateImage(
      { modelId: 'cogview-4-250304', prompt: 'a lake', count: 3, size: 'portrait' },
      ctx(fetchImpl)
    )
    const body = fetchImpl.requests[0].body as Record<string, unknown>
    expect(body).toEqual({ model: 'cogview-4-250304', prompt: 'a lake', size: '768x1344' })
    expect(images).toHaveLength(1)
  })
})
