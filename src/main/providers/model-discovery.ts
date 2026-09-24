import { z } from 'zod'
import type { ModelInfo, ProviderType } from '@shared/types'
import { UNKNOWN_MODEL_CAPS, PROVIDER_TYPES } from '@shared/catalog'
import type { AdapterContext } from './adapter'
import { checkedFetch, joinUrl, readBytesCapped } from './http'
import { version } from '../../../package.json'
import { createHash } from 'node:crypto'

// Account/configuration scoped; a failed refresh must not erase a previously discovered list.
const lastLists = new WeakMap<typeof fetch, Map<string, ModelInfo[]>>()

const id = z.string().min(1).max(512)
const tokens = z.number().int().nonnegative().nullish()
const entry = z.object({
  id: id.optional(), name: id.optional(), slug: id.optional(),
  display_name: z.string().optional(), displayName: z.string().optional(),
  created: z.number().optional(), created_at: z.string().optional(),
  context_window: tokens, max_input_tokens: tokens, max_tokens: tokens,
  inputTokenLimit: tokens, outputTokenLimit: tokens,
  visibility: z.string().optional(), priority: z.number().optional(),
  supportedGenerationMethods: z.array(z.string()).optional(),
  input_modalities: z.array(z.string()).optional(),
  supported_reasoning_levels: z.array(z.unknown()).optional(),
})
const page = z.object({
  data: z.array(entry).max(10000).optional(), models: z.array(entry).max(10000).optional(),
  has_more: z.boolean().optional(), last_id: id.nullish(), nextPageToken: id.optional(),
})

/** Bounded, authenticated model discovery. Only pagination cursors, never server URLs, are followed. */
export async function discoverModels(
  type: ProviderType | 'codex', ctx: AdapterContext, fallback: ModelInfo[]
): Promise<ModelInfo[]> {
  if (!ctx.apiKey) return fallback
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch
  let cache = lastLists.get(fetchImpl)
  if (!cache) { cache = new Map(); lastLists.set(fetchImpl, cache) }
  const cacheKey = createHash('sha256').update(JSON.stringify([type, ctx.baseUrl, ctx.apiKey, ctx.accountId])).digest('hex')
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, AbortSignal.timeout(8000)])
    : AbortSignal.timeout(8000)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (type === 'anthropic') {
    headers['x-api-key'] = ctx.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (type === 'google') headers['x-goog-api-key'] = ctx.apiKey
  else headers.Authorization = `Bearer ${ctx.apiKey}`
  if (type === 'codex') {
    headers.originator = 'codex_cli_rs'
    if (ctx.accountId) headers['chatgpt-account-id'] = ctx.accountId
  }
  const base = type === 'codex'
    ? `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`
    : joinUrl(ctx.baseUrl, '/models')
  try {
    let cursor: string | undefined
    const seen = new Set<string>()
    const models = new Map<string, ModelInfo>()
    for (let n = 0; n < 20; n++) {
      const url = new URL(base)
      if (type === 'anthropic') {
        url.searchParams.set('limit', '1000')
        if (cursor) url.searchParams.set('after_id', cursor)
      } else if (type === 'google') {
        url.searchParams.set('pageSize', '1000')
        if (cursor) url.searchParams.set('pageToken', cursor)
      }
      const res = await checkedFetch(url.toString(), {
        method: 'GET', redirect: 'error', headers, signal, providerType: type === 'codex' ? 'openai' : type,
        secrets: [ctx.apiKey, ctx.accountId ?? ''], fetchImpl: ctx.fetchImpl,
      })
      const bytes = await readBytesCapped(res, 4 * 1024 * 1024)
      if (!bytes) throw new Error('Model list too large')
      const parsed = page.parse(JSON.parse(new TextDecoder().decode(bytes)))
      const entries = parsed.data ?? parsed.models
      if (!entries) throw new Error('Missing model list')
      entries.sort((a, b) => type === 'codex'
        ? (a.priority ?? 999) - (b.priority ?? 999)
        : (b.created ?? (Date.parse(b.created_at ?? '') || 0)) - (a.created ?? (Date.parse(a.created_at ?? '') || 0)))
      for (const m of entries) {
        if (type === 'google' && !m.supportedGenerationMethods?.includes('generateContent')) continue
        if (type === 'codex' && m.visibility && m.visibility !== 'list') continue
        const modelId = type === 'google' ? m.name?.replace(/^models\//, '') : m.slug ?? m.id
        if (!modelId) continue
        const known = fallback.find((item) => item.id === modelId)
        models.set(modelId, {
          ...known, id: modelId, label: m.display_name ?? m.displayName ?? known?.label ?? modelId,
          contextLength: m.context_window ?? m.max_input_tokens ?? m.inputTokenLimit ?? known?.contextLength,
          maxOutputTokens: m.max_tokens ?? m.outputTokenLimit ?? known?.maxOutputTokens,
          capabilities: known?.capabilities ?? {
            ...UNKNOWN_MODEL_CAPS,
            ...(type === 'codex' ? {
              vision: m.input_modalities?.includes('image') ?? false,
              reasoning: !!m.supported_reasoning_levels?.length,
            } : {}),
          },
          fromCatalog: false,
        })
      }
      const next = type === 'google' ? parsed.nextPageToken
        : type === 'anthropic' && parsed.has_more ? parsed.last_id : undefined
      if (!next) {
        const result = [...models.values()]
        cache.delete(cacheKey)
        cache.set(cacheKey, result)
        if (cache.size > 128) cache.delete(cache.keys().next().value!)
        return result
      }
      if (seen.has(next)) throw new Error('Repeated model cursor')
      seen.add(next)
      cursor = next
    }
    throw new Error('Too many model pages')
  } catch (error) {
    if (ctx.signal?.aborted) throw error
    return cache.get(cacheKey) ?? fallback
  }
}

export function discoverNativeModels(type: ProviderType, ctx: AdapterContext): Promise<ModelInfo[]> {
  return discoverModels(type, ctx, ctx.modelCatalog?.knownModels ?? PROVIDER_TYPES[type].knownModels)
}
