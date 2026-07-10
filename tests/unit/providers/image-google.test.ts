/**
 * GoogleAdapter.generateImage: Gemini image models via :generateContent with
 * responseModalities IMAGE (inlineData parts), imagen-* ids via :predict,
 * safety-block normalization, auth header placement and key redaction.
 */

import { describe, expect, it } from 'vitest'
import { GoogleAdapter, mapGeminiAspectRatio } from '../../../src/main/providers/google'
import { ProviderError } from '../../../src/main/providers/errors'
import type { AdapterContext } from '../../../src/main/providers/adapter'
import { makeFetchSequence, makeJsonResponse } from '../../helpers/mock-fetch'

const KEY = 'goog-image-secret-9'

function ctx(fetchImpl: AdapterContext['fetchImpl']): AdapterContext {
  return { apiKey: KEY, baseUrl: 'https://gemini.example/v1beta', fetchImpl }
}

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('mapGeminiAspectRatio', () => {
  it('maps abstract sizes and omits auto', () => {
    expect(mapGeminiAspectRatio('square')).toBe('1:1')
    expect(mapGeminiAspectRatio('landscape')).toBe('16:9')
    expect(mapGeminiAspectRatio('portrait')).toBe('9:16')
    expect(mapGeminiAspectRatio('auto')).toBeUndefined()
  })
})

describe('GoogleAdapter.generateImage — Gemini image models', () => {
  it('posts :generateContent with responseModalities and collects inlineData parts', async () => {
    const fetchImpl = makeFetchSequence(
      makeJsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Here you go' },
                { inlineData: { mimeType: 'image/png', data: PNG_B64 } },
              ],
            },
          },
        ],
      })
    )
    const adapter = new GoogleAdapter()
    const images = await adapter.generateImage(
      { modelId: 'gemini-3.1-flash-image', prompt: 'a red fox', count: 1, size: 'landscape' },
      ctx(fetchImpl)
    )

    expect(fetchImpl.requests[0].url).toBe(
      'https://gemini.example/v1beta/models/gemini-3.1-flash-image:generateContent'
    )
    // Auth travels as the x-goog-api-key header, never in the URL.
    const headers = (fetchImpl.requests[0].init?.headers ?? {}) as Record<string, string>
    expect(headers['x-goog-api-key']).toBe(KEY)
    expect(fetchImpl.requests[0].url).not.toContain(KEY)

    const body = fetchImpl.requests[0].body as {
      contents: Array<{ parts: Array<{ text?: string }> }>
      generationConfig: { responseModalities: string[]; imageConfig?: { aspectRatio: string } }
    }
    expect(body.contents[0].parts[0].text).toBe('a red fox')
    expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE'])
    expect(body.generationConfig.imageConfig?.aspectRatio).toBe('16:9')

    expect(images).toHaveLength(1)
    expect(images[0].mimeType).toBe('image/png')
  })

  it('normalizes a safety block to invalid_request', async () => {
    const fetchImpl = makeFetchSequence(
      makeJsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] })
    )
    const adapter = new GoogleAdapter()
    let thrown: unknown
    try {
      await adapter.generateImage(
        { modelId: 'gemini-3.1-flash-image', prompt: 'x', count: 1 },
        ctx(fetchImpl)
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ProviderError)
    expect((thrown as ProviderError).code).toBe('invalid_request')
    expect((thrown as ProviderError).message).toContain('SAFETY')
  })

  it('never leaks the key from an HTTP error body', async () => {
    const fetchImpl = makeFetchSequence(
      makeJsonResponse(403, { error: { message: `denied for ${KEY}` } })
    )
    const adapter = new GoogleAdapter()
    let thrown: unknown
    try {
      await adapter.generateImage(
        { modelId: 'gemini-3.1-flash-image', prompt: 'x', count: 1 },
        ctx(fetchImpl)
      )
    } catch (e) {
      thrown = e
    }
    expect((thrown as ProviderError).message).not.toContain(KEY)
  })
})

describe('GoogleAdapter.generateImage — imagen-* ids', () => {
  it('posts :predict with instances/parameters and decodes predictions', async () => {
    const fetchImpl = makeFetchSequence(
      makeJsonResponse(200, {
        predictions: [
          { bytesBase64Encoded: PNG_B64, mimeType: 'image/png' },
          { bytesBase64Encoded: PNG_B64, mimeType: 'image/png' },
        ],
      })
    )
    const adapter = new GoogleAdapter()
    const images = await adapter.generateImage(
      { modelId: 'imagen-4.0-generate-001', prompt: 'a lake', count: 2, size: 'square' },
      ctx(fetchImpl)
    )

    expect(fetchImpl.requests[0].url).toBe(
      'https://gemini.example/v1beta/models/imagen-4.0-generate-001:predict'
    )
    const body = fetchImpl.requests[0].body as {
      instances: Array<{ prompt: string }>
      parameters: { sampleCount: number; aspectRatio?: string }
    }
    expect(body.instances[0].prompt).toBe('a lake')
    expect(body.parameters.sampleCount).toBe(2)
    expect(body.parameters.aspectRatio).toBe('1:1')
    expect(images).toHaveLength(2)
  })

  it('throws when imagen returns no predictions', async () => {
    const fetchImpl = makeFetchSequence(makeJsonResponse(200, { predictions: [] }))
    const adapter = new GoogleAdapter()
    await expect(
      adapter.generateImage({ modelId: 'imagen-4.0-generate-001', prompt: 'x', count: 1 }, ctx(fetchImpl))
    ).rejects.toThrow(/no image/i)
  })
})
