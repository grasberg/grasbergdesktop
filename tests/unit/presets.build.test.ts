import { describe, expect, it } from 'vitest'
import {
  buildPresetCatalog,
  decodeModel,
  decodePricing,
  type ModelsDevApi,
} from '../../src/shared/presets.build'

const API: ModelsDevApi = {
  // OpenAI-compatible, no `api` → uses the SDK-default base URL map.
  groq: {
    id: 'groq',
    name: 'Groq',
    npm: '@ai-sdk/groq',
    doc: 'https://groq.com/docs',
    env: ['GROQ_API_KEY'],
    models: {
      'llama-3.1': {
        id: 'llama-3.1',
        name: 'Llama 3.1',
        tool_call: true,
        release_date: '2024-07-01',
        limit: { context: 128000, output: 8192 },
        cost: { input: 0.05, output: 0.08, cache_read: 0.01 },
      },
      'llama-3.3': {
        id: 'llama-3.3',
        name: 'Llama 3.3',
        reasoning: true,
        release_date: '2024-12-01',
      },
    },
  },
  // Explicit api + a vision model with no cost block (unknown pricing).
  foorouter: {
    id: 'foorouter',
    name: 'FooRouter',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.foorouter.ai/v1',
    env: ['FOO_API_KEY'],
    models: { vmodel: { id: 'vmodel', attachment: true } },
  },
  // Excluded: native dialect.
  anthropic: { id: 'anthropic', npm: '@ai-sdk/anthropic', models: { c: { id: 'c' } } },
  // Excluded: azure.
  azure: { id: 'azure', npm: '@ai-sdk/azure', models: { a: { id: 'a' } } },
  // Excluded: first-class family id.
  openai: { id: 'openai', npm: '@ai-sdk/openai', models: { g: { id: 'g' } } },
  // Skipped: no api and no SDK-default mapping.
  weirdcloud: { id: 'weirdcloud', npm: '@ai-sdk/whatever', models: { m: { id: 'm' } } },
}

describe('buildPresetCatalog', () => {
  const built = buildPresetCatalog(API)

  it('includes OpenAI-compatible providers, excludes native/azure/first-class', () => {
    const ids = built.meta.map((m) => m.id)
    expect(ids).toContain('groq')
    expect(ids).toContain('foorouter')
    expect(ids).not.toContain('anthropic')
    expect(ids).not.toContain('azure')
    expect(ids).not.toContain('openai')
  })

  it('skips providers with no resolvable base URL (and reports them)', () => {
    expect(built.meta.map((m) => m.id)).not.toContain('weirdcloud')
    expect(built.skipped).toContain('weirdcloud')
  })

  it('resolves base URL from SDK defaults + preset key label', () => {
    const groq = built.meta.find((m) => m.id === 'groq')!
    expect(groq.baseUrl).toBe('https://api.groq.com/openai/v1')
    expect(groq.keyLabel).toBe('API key (GROQ_API_KEY)')
    expect(groq.docsUrl).toBe('https://groq.com/docs')
  })

  it('picks the newest model by release_date as default', () => {
    expect(built.meta.find((m) => m.id === 'groq')!.defaultModelId).toBe('llama-3.3')
  })

  it('is deterministic: providers + models sorted by id', () => {
    expect(built.meta.map((m) => m.id)).toEqual([...built.meta.map((m) => m.id)].sort())
    expect(built.models.groq.map((t) => t[0])).toEqual(['llama-3.1', 'llama-3.3'])
  })

  it('maps caps + pricing; encodes unknown cost as -1', () => {
    const m = built.models.groq.find((t) => t[0] === 'llama-3.1')!
    // [id,label,ctx,out,tools,vision,reasoning,in$,out$,cache$]
    expect(m).toEqual(['llama-3.1', 'Llama 3.1', 128000, 8192, 1, 0, 0, 0.05, 0.08, 0.01])
    const v = built.models.foorouter.find((t) => t[0] === 'vmodel')!
    expect(v).toEqual(['vmodel', 'vmodel', 0, 0, 0, 1, 0, -1, -1, -1]) // no cost block
  })
})

describe('decoders', () => {
  it('decodeModel round-trips a tuple to ModelInfo', () => {
    const info = decodeModel(['x', 'X', 1000, 500, 1, 1, 0, 1, 2, 0.5])
    expect(info).toEqual({
      id: 'x',
      label: 'X',
      contextLength: 1000,
      maxOutputTokens: 500,
      capabilities: { streaming: true, tools: true, vision: true, reasoning: false },
      fromCatalog: true,
    })
  })

  it('decodePricing returns undefined for unknown cost, else USD/1M', () => {
    expect(decodePricing(['x', 'X', 0, 0, 0, 0, 0, -1, -1, -1])).toBeUndefined()
    expect(decodePricing(['x', 'X', 0, 0, 0, 0, 0, 1, 2, 0.5])).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 2,
      cachedInputPerMTok: 0.5,
    })
  })

  // Unknown cache pricing must NOT decode as free: estimateCost then falls back
  // to the input rate. Older generated tuples encode a missing cache_read as 0.
  it('leaves cached input unknown for an absent or zero cache price', () => {
    expect(decodePricing(['x', 'X', 0, 0, 0, 0, 0, 5, 15, -1])).toEqual({
      inputPerMTok: 5,
      outputPerMTok: 15,
    })
    expect(decodePricing(['x', 'X', 0, 0, 0, 0, 0, 5, 15, 0])).toEqual({
      inputPerMTok: 5,
      outputPerMTok: 15,
    })
  })

  it('encodes a missing cache_read as unknown even when input/output are priced', () => {
    const built = buildPresetCatalog({
      cachey: {
        id: 'cachey',
        api: 'https://api.cachey.ai/v1',
        models: { m: { id: 'm', cost: { input: 5, output: 15 } } },
      },
    })
    expect(built.models.cachey[0][9]).toBe(-1)
  })
})
