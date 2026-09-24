import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { LiveModelCatalog } from '../../../src/main/providers/live-catalog'

const dirs: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
const path = async () => { const dir = await mkdtemp(join(tmpdir(), 'grasberg-models-')); dirs.push(dir); return join(dir, 'catalog.json') }
const model = (id: string, release_date: string) => ({ id, release_date, name: id, tool_call: true, modalities: { output: ['text'] } })

it('refreshes subscription and preset catalogs without a release and never sends credentials', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    'zai-coding-plan': { models: { old: model('old', '2020-01-01'), new: model('new', '2030-01-01') } },
    zai: { models: { unrelated: model('general-plan-only', '2030-01-01') } },
    groq: { models: { future: model('future', '2030-01-01') } },
  })))
  const catalog = new LiveModelCatalog(await path(), fetchImpl)
  const [coding, preset] = await Promise.all([
    catalog.resolve({ type: 'zai-coding' }), catalog.resolve({ type: 'openai-compatible', presetId: 'groq' }),
  ])
  expect(coding.knownModels.map((m) => m.id)).toEqual(['new', 'old'])
  expect(preset.knownModels[0].id).toBe('future')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('headers')
})

it('loads a persisted catalog after restart and retains it through a failed refresh', async () => {
  const cachePath = await path()
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    minimax: { models: { new: model('new-minimax', '2030-01-01') } },
  })))
  await new LiveModelCatalog(cachePath, fetchImpl).resolve({ type: 'minimax' })
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000)
  const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
  const models = await new LiveModelCatalog(cachePath, offline).resolve({ type: 'minimax' })
  expect(models.knownModels[0].id).toBe('new-minimax')
  expect(offline).toHaveBeenCalledTimes(1)
})

it('skips malformed and non-chat models without discarding valid additions', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    google: { models: { good: model('new-gemini', '2030-01-01'), bad: { id: 12 },
      image: { id: 'image-only', modalities: { output: ['image'] } } } },
  })))
  const models = await new LiveModelCatalog(await path(), fetchImpl).resolve({ type: 'google' })
  expect(models.knownModels.map((m) => m.id)).toEqual(['new-gemini'])
})

it('does not download a public catalog for custom local providers', async () => {
  const fetchImpl = vi.fn<typeof fetch>()
  await new LiveModelCatalog(await path(), fetchImpl).resolve({ type: 'openai-compatible' })
  expect(fetchImpl).not.toHaveBeenCalled()
})
