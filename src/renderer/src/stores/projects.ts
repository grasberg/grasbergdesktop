/**
 * Per-mode organizational projects for the sidebar. Holds the project list for
 * the currently viewed mode; the sidebar reloads it whenever the mode changes.
 * Also owns the sidebar tree's collapse state (which project groups are folded),
 * persisted to localStorage so it survives reloads. Mutations go through
 * window.uld.projects; failures surface as toasts.
 */

import { create } from 'zustand'
import type { ConversationMode, Project } from '@shared/types'
import { unwrap } from '@/api/uld'
import type { ProjectsStoreState } from './contracts'
import { toastError } from './ui'

/** Guards load() against out-of-order responses when switching modes fast. */
let loadToken = 0

const COLLAPSED_KEY = 'uld.sidebar.collapsedGroups'

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function writeCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
  } catch {
    // Non-fatal: persistence is a nice-to-have, not required for correctness.
  }
}

export const useProjectsStore = create<ProjectsStoreState>()((set, get) => ({
  projects: [],
  mode: null,
  loaded: false,
  collapsed: readCollapsed(),

  async load(mode) {
    const token = ++loadToken
    try {
      const projects = await unwrap(window.uld.projects.list({ mode }))
      if (token !== loadToken) return
      set({ projects, mode, loaded: true })
    } catch (e) {
      if (token === loadToken) set({ mode, loaded: true })
      toastError('Failed to load projects', e)
    }
  },

  async create(mode, name) {
    const project = await unwrap(window.uld.projects.create({ mode, name }))
    // Only merge into the visible list when it's for the mode on screen.
    if (get().mode === mode) {
      set((s) => ({ projects: [project, ...s.projects.filter((p) => p.id !== project.id)] }))
    }
    return project
  },

  async rename(id, name) {
    const updated = await unwrap(window.uld.projects.update(id, { name }))
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? updated : p)) }))
  },

  async remove(id) {
    await unwrap(window.uld.projects.delete(id))
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
  },

  toggleCollapsed(id) {
    set((s) => {
      const next = new Set(s.collapsed)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeCollapsed(next)
      return { collapsed: next }
    })
  },

  expand(id) {
    set((s) => {
      if (!s.collapsed.has(id)) return s
      const next = new Set(s.collapsed)
      next.delete(id)
      writeCollapsed(next)
      return { collapsed: next }
    })
  },
}))
