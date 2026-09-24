import { create } from 'zustand'
import type { IpcResult } from '@shared/ipc'
import type { ModelInfo, OAuthStatus, ProviderConfig } from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import type { ProvidersStoreState } from './contracts'
import { toastError } from './ui'

export const useProvidersStore = create<ProvidersStoreState>()((set, get) => {
  const fetchedAt = new Map<string, number>()
  const pending = new Map<string, { provider: ProviderConfig | undefined; promise: Promise<ModelInfo[]> }>()
  const invalidate = (id: string): void => {
    fetchedAt.delete(id)
    pending.delete(id)
    set((s) => {
      const { [id]: _old, ...modelsByProvider } = s.modelsByProvider
      return { modelsByProvider }
    })
  }
  /**
   * Awaits an OAuth call, then refreshes the provider list so
   * oauthConnected / account label reflect the new session.
   */
  const oauthThenRefresh = async (call: Promise<IpcResult<OAuthStatus>>): Promise<OAuthStatus> => {
    const status = await unwrap(call)
    const providers = await unwrap(window.uld.providers.list())
    for (const provider of providers) invalidate(provider.id)
    set({ providers })
    return status
  }

  return {
    providers: [],
    types: [],
    modelsByProvider: {},
    modelsUpdatedAt: {},
    loaded: false,

    async load() {
      try {
        const [types, providers] = await Promise.all([
          unwrap(window.uld.providers.listTypes()),
          unwrap(window.uld.providers.list()),
        ])
        set({ types, providers, loaded: true })
      } catch (e) {
        set({ loaded: true })
        toastError('Failed to load providers', e)
      }
    },

    async create(input) {
      const provider = await unwrap(window.uld.providers.create(input))
      set((s) => ({ providers: [...s.providers, provider] }))
      return provider
    },

    async update(id, patch) {
      const provider = await unwrap(window.uld.providers.update(id, patch))
      set((s) => ({ providers: s.providers.map((p) => (p.id === id ? provider : p)) }))
      invalidate(id)
    },

    async remove(id) {
      await unwrap(window.uld.providers.delete(id))
      invalidate(id)
      set((s) => {
        const { [id]: _dropped, ...rest } = s.modelsByProvider
        return { providers: s.providers.filter((p) => p.id !== id), modelsByProvider: rest }
      })
    },

    async setKey(id, apiKey) {
      const provider = await unwrap(window.uld.providers.setKey(id, apiKey))
      set((s) => ({ providers: s.providers.map((p) => (p.id === id ? provider : p)) }))
      invalidate(id)
    },

    async deleteKey(id) {
      const provider = await unwrap(window.uld.providers.deleteKey(id))
      set((s) => ({ providers: s.providers.map((p) => (p.id === id ? provider : p)) }))
      invalidate(id)
    },

    async test(id) {
      try {
        return await unwrap(window.uld.providers.test(id))
      } catch (e) {
        // Transport-level failure: surface it as a failed test result rather
        // than throwing, so the settings UI has one code path.
        return { ok: false, message: toNormalized(e).message }
      }
    },

    async loadModels(id, force = false) {
      const provider = get().providers.find((p) => p.id === id)
      const inflight = pending.get(id)
      if (inflight && inflight.provider === provider) return inflight.promise
      const cached = get().modelsByProvider[id]
      if (!force && cached && Date.now() - (fetchedAt.get(id) ?? 0) < 5 * 60_000) return cached
      const promise = unwrap(window.uld.providers.listModels(id)).then((models) => {
        // A key, account, endpoint or provider may have changed during the request.
        if (provider && get().providers.find((p) => p.id === id) === provider) {
          fetchedAt.set(id, Date.now())
          set((s) => ({ modelsByProvider: { ...s.modelsByProvider, [id]: models }, modelsUpdatedAt: { ...s.modelsUpdatedAt, [id]: Date.now() } }))
        }
        return models
      }).finally(() => { if (pending.get(id)?.promise === promise) pending.delete(id) })
      pending.set(id, { provider, promise })
      return promise
    },

    async detectLocal() {
      try {
        return await unwrap(window.uld.providers.detectLocal())
      } catch {
        // Detection is best-effort decoration — never toast about it.
        return []
      }
    },

    async oauthStart(id) {
      return oauthThenRefresh(window.uld.providers.oauthStart(id))
    },

    async oauthLogout(id) {
      return oauthThenRefresh(window.uld.providers.oauthLogout(id))
    },
  }
})
