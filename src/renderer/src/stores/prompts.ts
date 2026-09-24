/**
 * Zustand store for the prompt library: reusable saved prompts the user can
 * insert into the composer or set as a conversation's system prompt.
 */

import { create } from 'zustand'
import type { PromptTemplate, PromptTemplateInput, PromptTemplatePatch } from '@shared/types'
import { createSimpleListActions, type SimpleListActions } from './simple-list'

export interface PromptsStoreState
  extends SimpleListActions<PromptTemplateInput, PromptTemplatePatch> {
  templates: PromptTemplate[]
  loaded: boolean
}

export const usePromptsStore = create<PromptsStoreState>()((set) => ({
  templates: [],
  loaded: false,

  ...createSimpleListActions<PromptTemplate, PromptTemplateInput, PromptTemplatePatch>({
    label: 'prompts',
    api: () => window.uld.prompts,
    onLoaded: (templates) => set({ templates, loaded: true }),
    onLoadFailed: () => set({ loaded: true }),
  }),
}))
