import { create } from 'zustand'
import type { IpcResult } from '@shared/ipc'
import type { OAuthStatus } from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import type { ProvidersStoreState } from './contracts'
import { toastError } from './ui'

export const useProvidersStore = create<ProvidersStoreState>()((set) => {
  /**
   * Awaits an OAuth call, then refreshes the provider list so
   * oauthConnected / account label reflect the new session.
   */
  const oauthThenRefresh = async (call: Promise<IpcResult<OAuthStatus>>): Promise<OAuthStatus> => {
    const status = await unwrap(call)
    const providers = await unwrap(window.uld.providers.list())
    set({ providers })
    return status
  }

  return {
    providers: [],
    types: [],
    modelsByProvider: {},
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
    },

    async remove(id) {
      await unwrap(window.uld.providers.delete(id))
      set((s) => {
        const { [id]: _dropped, ...rest } = s.modelsByProvider
        return { providers: s.providers.filter((p) => p.id !== id), modelsByProvider: rest }
      })
    },

    async setKey(id, apiKey) {
      const provider = await unwrap(window.uld.providers.setKey(id, apiKey))
      set((s) => ({ providers: s.providers.map((p) => (p.id === id ? provider : p)) }))
    },

    async deleteKey(id) {
      const provider = await unwrap(window.uld.providers.deleteKey(id))
      set((s) => ({ providers: s.providers.map((p) => (p.id === id ? provider : p)) }))
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

    async loadModels(id) {
      const models = await unwrap(window.uld.providers.listModels(id))
      set((s) => ({ modelsByProvider: { ...s.modelsByProvider, [id]: models } }))
      return models
    },

    async oauthStart(id) {
      return oauthThenRefresh(window.uld.providers.oauthStart(id))
    },

    async oauthLogout(id) {
      return oauthThenRefresh(window.uld.providers.oauthLogout(id))
    },
  }
})
