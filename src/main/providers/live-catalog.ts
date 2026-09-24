import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { resolveModelCatalog, type ProviderCatalogRef, type ProviderModelCatalog } from '@shared/catalog'
import type { ModelInfo } from '@shared/types'
import { readBytesCapped } from './http'

const modelSchema = z.object({
  id: z.string().min(1).max(512), name: z.string().optional(),
  release_date: z.string().optional(), status: z.string().optional(),
  tool_call: z.boolean().optional(), reasoning: z.boolean().optional(),
  modalities: z.object({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() }).optional(),
  limit: z.object({ context: z.number().nonnegative().optional(), output: z.number().nonnegative().optional() }).optional(),
})
const catalogSchema = z.record(z.string(), z.object({ models: z.record(z.string(), z.unknown()).optional() }))
type Catalog = z.infer<typeof catalogSchema>
const MAX_BYTES = 12 * 1024 * 1024
const SIX_HOURS = 6 * 60 * 60 * 1000
const sources: Record<string, string> = {
  deepseek: 'deepseek', zhipu: 'zhipuai', 'zai-coding': 'zai-coding-plan',
  minimax: 'minimax', openai: 'openai', anthropic: 'anthropic', google: 'google', bedrock: 'amazon-bedrock',
}

/** Public metadata only. Endpoint and credentials always remain owned by the user's provider config. */
export class LiveModelCatalog {
  private data: Catalog = {}
  private nextRefresh = 0
  private pending?: Promise<void>
  private loadedDisk = false

  constructor(private cachePath: string, private fetchImpl: typeof fetch = fetch) {}

  private async refresh(): Promise<void> {
    if (this.pending) return this.pending
    if (Date.now() < this.nextRefresh) return
    this.pending = (async () => {
      if (!this.loadedDisk) {
        this.loadedDisk = true
        try {
          if ((await stat(this.cachePath)).size <= MAX_BYTES) {
            const cached = z.object({ fetchedAt: z.number(), data: catalogSchema })
              .parse(JSON.parse(await readFile(this.cachePath, 'utf8')))
            this.data = cached.data
            this.nextRefresh = Math.min(cached.fetchedAt + SIX_HOURS, Date.now() + SIX_HOURS)
          }
        } catch { /* First run or invalid cache: use the bundled catalog. */ }
      }
      if (Date.now() < this.nextRefresh) return
      this.nextRefresh = Date.now() + 60_000
      try {
        const response = await this.fetchImpl('https://models.dev/api.json', {
          signal: AbortSignal.timeout(8000), redirect: 'error',
        })
        if (!response.ok) return
        const bytes = await readBytesCapped(response, MAX_BYTES)
        if (!bytes) return
        const data = catalogSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
        if (!Object.keys(data).length) return
        this.data = data
        const fetchedAt = Date.now()
        this.nextRefresh = fetchedAt + SIX_HOURS
        await mkdir(dirname(this.cachePath), { recursive: true })
        await writeFile(this.cachePath, JSON.stringify({ fetchedAt, data }), 'utf8')
      } catch { /* Offline: retain the last successful catalog. No provider secrets are involved. */ }
    })().finally(() => { this.pending = undefined })
    return this.pending
  }

  async resolve(provider: ProviderCatalogRef): Promise<ProviderModelCatalog> {
    const bundled = resolveModelCatalog(provider)
    const source = provider.presetId ?? sources[provider.type]
    if (!source) return bundled // Custom/local endpoints discover their own models.
    await this.refresh()
    const entries = Object.values(this.data[source]?.models ?? {})
      .flatMap((value) => { const parsed = modelSchema.safeParse(value); return parsed.success ? [parsed.data] : [] })
      .filter((m) => m.status !== 'deprecated' && (!m.modalities?.output || m.modalities.output.includes('text')))
      .sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? '') || a.id.localeCompare(b.id))
    const models: ModelInfo[] = entries.map((m) => ({
      id: m.id, label: m.name ?? m.id, contextLength: m.limit?.context,
      maxOutputTokens: m.limit?.output, fromCatalog: true,
      capabilities: { streaming: true, tools: m.tool_call ?? false,
        vision: m.modalities?.input?.includes('image') ?? false, reasoning: m.reasoning ?? false },
    }))
    return models.length ? { ...bundled, knownModels: models } : bundled
  }
}
