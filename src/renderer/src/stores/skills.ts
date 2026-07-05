/**
 * Zustand store for skills: Agent-Skills-standard instruction sets (SKILL.md)
 * imported from folders/plugins or authored in Settings → Skills.
 */

import { create } from 'zustand'
import type { Skill, SkillInput, SkillPatch } from '@shared/types'
import { unwrap } from '@/api/uld'
import { createSimpleListActions, type SimpleListActions } from './simple-list'

export interface SkillsStoreState extends SimpleListActions<SkillInput, SkillPatch> {
  skills: Skill[]
  loaded: boolean
  /** Imports a picked folder; resolves with the imported skills. */
  importFolder(path: string): Promise<Skill[]>
}

export const useSkillsStore = create<SkillsStoreState>()((set, get) => ({
  skills: [],
  loaded: false,

  ...createSimpleListActions<Skill, SkillInput, SkillPatch>({
    label: 'skills',
    api: window.uld.skills,
    onLoaded: (skills) => set({ skills, loaded: true }),
    onLoadFailed: () => set({ loaded: true }),
  }),

  async importFolder(path) {
    const imported = await unwrap(window.uld.skills.importFolder(path))
    await get().load()
    return imported
  },
}))
