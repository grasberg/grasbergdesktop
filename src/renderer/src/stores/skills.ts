/**
 * Zustand store for skills: Agent-Skills-standard instruction sets (SKILL.md)
 * imported from folders/plugins or authored in Settings → Skills.
 */

import { create } from 'zustand'
import type { Skill, SkillInput, SkillPatch } from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import { useUiStore } from './ui'

export interface SkillsStoreState {
  skills: Skill[]
  loaded: boolean
  load(): Promise<void>
  /** Mutations reject with a NormalizedError on failure (callers toast). */
  create(input: SkillInput): Promise<void>
  update(id: string, patch: SkillPatch): Promise<void>
  remove(id: string): Promise<void>
  /** Imports a picked folder; resolves with the imported skills. */
  importFolder(path: string): Promise<Skill[]>
}

export const useSkillsStore = create<SkillsStoreState>()((set, get) => ({
  skills: [],
  loaded: false,

  async load() {
    try {
      const skills = await unwrap(window.uld.skills.list())
      set({ skills, loaded: true })
    } catch (e) {
      set({ loaded: true })
      useUiStore.getState().toast(`Failed to load skills: ${toNormalized(e).message}`, 'error')
    }
  },

  async create(input) {
    await unwrap(window.uld.skills.create(input))
    await get().load()
  },

  async update(id, patch) {
    await unwrap(window.uld.skills.update(id, patch))
    await get().load()
  },

  async remove(id) {
    await unwrap(window.uld.skills.delete(id))
    await get().load()
  },

  async importFolder(path) {
    const imported = await unwrap(window.uld.skills.importFolder(path))
    await get().load()
    return imported
  },
}))
