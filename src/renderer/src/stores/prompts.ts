/**
 * Zustand store for the prompt library: reusable saved prompts the user can
 * insert into the composer or set as a conversation's system prompt.
 */

import { create } from 'zustand'
import type { PromptTemplate, PromptTemplateInput, PromptTemplatePatch } from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import { useUiStore } from './ui'

export interface PromptsStoreState {
  templates: PromptTemplate[]
  loaded: boolean
  load(): Promise<void>
  /** Mutations reject with a NormalizedError on failure (callers toast). */
  create(input: PromptTemplateInput): Promise<void>
  update(id: string, patch: PromptTemplatePatch): Promise<void>
  remove(id: string): Promise<void>
}

export const usePromptsStore = create<PromptsStoreState>()((set, get) => ({
  templates: [],
  loaded: false,

  async load() {
    try {
      const templates = await unwrap(window.uld.prompts.list())
      set({ templates, loaded: true })
    } catch (e) {
      set({ loaded: true })
      useUiStore.getState().toast(`Failed to load prompts: ${toNormalized(e).message}`, 'error')
    }
  },

  async create(input) {
    await unwrap(window.uld.prompts.create(input))
    await get().load()
  },

  async update(id, patch) {
    await unwrap(window.uld.prompts.update(id, patch))
    await get().load()
  },

  async remove(id) {
    await unwrap(window.uld.prompts.delete(id))
    await get().load()
  },
}))
