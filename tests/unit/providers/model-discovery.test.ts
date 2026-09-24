import { describe, expect, it, vi } from 'vitest'
import { discoverModels } from '../../../src/main/providers/model-discovery'
import { OpenAICodexAdapter } from '../../../src/main/providers/openai-codex'
import { PROVIDER_TYPES } from '../../../src/shared/catalog'

const json = (value: unknown) => new Response(JSON.stringify(value))
const base = { apiKey: 'test-secret', baseUrl: 'https://provider.test/v1' }

describe('model discovery', () => {
  it('includes newly released IDs, sorts release timestamps, and preserves known metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ data: [
      { id: 'gpt-4o', created: 1 }, { id: 'future-model', created: 2 },
    ] }))
    const models = await discoverModels('openai', { ...base, fetchImpl }, PROVIDER_TYPES.openai.knownModels)
    expect(models.map((m) => m.id)).toEqual(['future-model', 'gpt-4o'])
    expect(models[1].capabilities.vision).toBe(true)
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer test-secret' } })
  })

  it('paginates Anthropic on the configured host without following supplied URLs', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: [{ id: 'new-claude', display_name: 'New Claude' }], has_more: true, last_id: 'new-claude' }))
      .mockResolvedValueOnce(json({ data: [{ id: 'older-claude' }], has_more: false }))
    const models = await discoverModels('anthropic', { ...base, fetchImpl }, [])
    expect(models.map((m) => m.id)).toEqual(['new-claude', 'older-claude'])
    expect(String(fetchImpl.mock.calls[1][0])).toContain('after_id=new-claude')
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ 'x-api-key': base.apiKey, 'anthropic-version': '2023-06-01' })
  })

  it('paginates Gemini and excludes embedding-only models', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ models: [
        { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-new', displayName: 'New Gemini', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 12345 },
      ], nextPageToken: 'page2' }))
      .mockResolvedValueOnce(json({ models: [{ name: 'models/gemini-next', supportedGenerationMethods: ['generateContent'] }] }))
    const models = await discoverModels('google', { ...base, fetchImpl }, [])
    expect(models.map((m) => m.id)).toEqual(['gemini-new', 'gemini-next'])
    expect(models[0].contextLength).toBe(12345)
    expect(String(fetchImpl.mock.calls[1][0])).toContain('pageToken=page2')
  })

  it('uses the account-specific Codex list, filters hidden entries and respects priority', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ models: [
      { slug: 'hidden', visibility: 'hide' },
      { slug: 'gpt-future', visibility: 'list', priority: 1, context_window: 1000000, input_modalities: ['text', 'image'] },
      { slug: 'gpt-newest', visibility: 'list', priority: 0 },
    ] }))
    const models = await new OpenAICodexAdapter().listModels({ ...base, accountId: 'test-account', fetchImpl })
    expect(models.map((m) => m.id)).toEqual(['gpt-newest', 'gpt-future'])
    expect(models[1].capabilities.vision).toBe(true)
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/^https:\/\/chatgpt.com\/backend-api\/codex\/models\?client_version=/)
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ 'chatgpt-account-id': 'test-account' })
  })

  it('never silently substitutes a newly selected Codex model', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('data: {"type":"response.completed"}\n\n'))
    await new OpenAICodexAdapter().chat({ modelId: 'gpt-future', messages: [{ role: 'user', content: 'hi' }], params: {}, stream: false }, { ...base, fetchImpl })
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).model).toBe('gpt-future')
  })

  it('keeps the last successful list offline but isolates changed credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ data: [{ id: 'new' }] }))
      .mockRejectedValue(new Error('offline'))
    await discoverModels('openai', { ...base, fetchImpl }, [])
    expect((await discoverModels('openai', { ...base, fetchImpl }, [])).map((m) => m.id)).toEqual(['new'])
    expect(await discoverModels('openai', { ...base, apiKey: 'different-account', fetchImpl }, [])).toEqual([])
  })

  it('does not loop on repeated cursors or leak a failed body into models', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json({ data: [{ id: 'partial' }], has_more: true, last_id: 'same' }))
    expect(await discoverModels('anthropic', { ...base, fetchImpl }, [])).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
