import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../../src/shared/types'
vi.mock('@/stores/ui', () => ({ toastError: vi.fn() }))
import { useProvidersStore } from '../../src/renderer/src/stores/providers'

const listModels = vi.fn()
const update = vi.fn()
let provider: ProviderConfig
beforeEach(() => {
  provider = { id: crypto.randomUUID(), type: 'openai', enabled: true } as ProviderConfig
  useProvidersStore.setState({ providers: [provider], modelsByProvider: {} })
  listModels.mockReset(); update.mockReset()
  vi.stubGlobal('window', { uld: { providers: { listModels, update } } })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('deduplicates requests, expires lists after five minutes, and permits explicit refresh', async () => {
  vi.useFakeTimers()
  listModels.mockResolvedValue({ ok: true, data: [{ id: 'new-model' }] })
  const store = useProvidersStore.getState()
  await Promise.all([store.loadModels(provider.id), store.loadModels(provider.id)])
  await store.loadModels(provider.id)
  expect(listModels).toHaveBeenCalledTimes(1)
  vi.setSystemTime(Date.now() + 5 * 60_000)
  await store.loadModels(provider.id)
  await store.loadModels(provider.id, true)
  expect(listModels).toHaveBeenCalledTimes(3)
})

it('does not overwrite a changed provider with an old in-flight list', async () => {
  let resolve!: (value: unknown) => void
  listModels.mockReturnValue(new Promise((r) => { resolve = r }))
  const pending = useProvidersStore.getState().loadModels(provider.id)
  update.mockResolvedValue({ ok: true, data: { ...provider, baseUrl: 'https://changed.test' } })
  await useProvidersStore.getState().update(provider.id, { baseUrl: 'https://changed.test' })
  resolve({ ok: true, data: [{ id: 'old-account-model' }] })
  await pending
  expect(useProvidersStore.getState().modelsByProvider[provider.id]).toBeUndefined()
})

it('retains the previous model list when IPC refresh fails', async () => {
  listModels.mockResolvedValueOnce({ ok: true, data: [{ id: 'new-model' }] })
  await useProvidersStore.getState().loadModels(provider.id)
  listModels.mockRejectedValue(new Error('offline'))
  await expect(useProvidersStore.getState().loadModels(provider.id, true)).rejects.toThrow('offline')
  expect(useProvidersStore.getState().modelsByProvider[provider.id]).toEqual([{ id: 'new-model' }])
})
