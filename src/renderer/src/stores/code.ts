/**
 * Zustand store for Code mode: the granted project, its file tree, the file
 * selection used as chat context, the file preview, and proposed changes.
 *
 * Defensive by design: any window.uld.code.* call may return a normalized
 * 'not_supported' error on builds where the main-process code service is not
 * implemented yet — those surface as a single graceful toast (or are swallowed
 * for background refreshes) instead of breaking the UI.
 */

import { create } from 'zustand'
import type {
  Attachment,
  CodeChange,
  CodeProject,
  Conversation,
  FileTreeNode,
} from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import { useUiStore } from './ui'

export interface OpenFilePreview {
  relPath: string
  content: string
  truncated: boolean
  sizeBytes: number
}

export interface CodeStoreState {
  /** Project granted for the open conversation (null = no access granted). */
  project: CodeProject | null
  tree: FileTreeNode | null
  /** relPaths of files checked in the tree (chat context selection). */
  selectedPaths: string[]
  openFile: OpenFilePreview | null
  changes: CodeChange[]
  loadingTree: boolean
  loadingChanges: boolean
  /** Change id currently being applied/rejected (disables its buttons). */
  busyChangeId: string | null

  /** Folder picker -> code.projectOpen -> tree + changes. Null when cancelled/failed. */
  openProjectViaPicker(): Promise<CodeProject | null>
  /** Resolves the project referenced by conversation.projectId and loads tree + changes. */
  loadForConversation(conversation: Conversation): Promise<void>
  loadTree(): Promise<void>
  toggleSelect(relPath: string): void
  clearSelection(): void
  openFilePreview(relPath: string): Promise<void>
  closePreview(): void
  loadChanges(): Promise<void>
  applyChange(id: string): Promise<void>
  rejectChange(id: string): Promise<void>
  /**
   * Reads every selected file and converts it to an Attachment.
   * Returns null when a read failed (already toasted).
   */
  readSelectedAsAttachments(): Promise<Attachment[] | null>
  reset(): void
}

/** Guards loadForConversation against out-of-order responses. */
let loadToken = 0

function friendlyMessage(e: unknown, what: string): string {
  const n = toNormalized(e)
  if (n.code === 'not_supported') {
    return `${what} is not available in this build yet.`
  }
  return n.message || `${what} failed.`
}

function toastError(e: unknown, what: string): void {
  useUiStore.getState().toast(friendlyMessage(e, what), 'error')
}

export const useCodeStore = create<CodeStoreState>()((set, get) => ({
  project: null,
  tree: null,
  selectedPaths: [],
  openFile: null,
  changes: [],
  loadingTree: false,
  loadingChanges: false,
  busyChangeId: null,

  async openProjectViaPicker() {
    try {
      const path = await unwrap(window.uld.app.pickFolder())
      if (!path) return null
      const project = await unwrap(window.uld.code.projectOpen(path))
      set({ project, tree: null, selectedPaths: [], openFile: null, changes: [] })
      await Promise.all([get().loadTree(), get().loadChanges()])
      return project
    } catch (e) {
      toastError(e, 'Opening the folder')
      return null
    }
  },

  async loadForConversation(conversation) {
    const token = ++loadToken
    if (!conversation.projectId) {
      set({ project: null, tree: null, selectedPaths: [], openFile: null, changes: [] })
      return
    }
    try {
      const projects = await unwrap(window.uld.code.projectsList())
      if (token !== loadToken) return
      const project = projects.find((p) => p.id === conversation.projectId) ?? null
      if (!project) {
        set({ project: null, tree: null, selectedPaths: [], openFile: null, changes: [] })
        useUiStore
          .getState()
          .toast('The folder linked to this conversation is no longer registered.', 'info')
        return
      }
      const samePath = get().project?.id === project.id
      set({
        project,
        // Keep the tree when re-entering the same project; clear otherwise.
        tree: samePath ? get().tree : null,
        selectedPaths: samePath ? get().selectedPaths : [],
        openFile: null,
      })
      await Promise.all([get().loadTree(), get().loadChanges()])
    } catch (e) {
      if (token !== loadToken) return
      toastError(e, 'Loading the project')
    }
  },

  async loadTree() {
    const { project } = get()
    if (!project) return
    set({ loadingTree: true })
    try {
      const tree = await unwrap(window.uld.code.fileTree(project.id))
      // Only apply if the project has not changed while loading.
      if (get().project?.id === project.id) set({ tree, loadingTree: false })
      else set({ loadingTree: false })
    } catch (e) {
      set({ loadingTree: false })
      toastError(e, 'Reading the file tree')
    }
  },

  toggleSelect(relPath) {
    set((s) => ({
      selectedPaths: s.selectedPaths.includes(relPath)
        ? s.selectedPaths.filter((p) => p !== relPath)
        : [...s.selectedPaths, relPath],
    }))
  },

  clearSelection() {
    set({ selectedPaths: [] })
  },

  async openFilePreview(relPath) {
    const { project } = get()
    if (!project) return
    try {
      const file = await unwrap(window.uld.code.readFile({ projectId: project.id, relPath }))
      set({
        openFile: {
          relPath: file.relPath,
          content: file.content,
          truncated: file.truncated,
          sizeBytes: file.sizeBytes,
        },
      })
    } catch (e) {
      toastError(e, `Reading ${relPath}`)
    }
  },

  closePreview() {
    set({ openFile: null })
  },

  async loadChanges() {
    const { project } = get()
    if (!project) return
    set({ loadingChanges: true })
    try {
      const changes = await unwrap(window.uld.code.changesList(project.id))
      if (get().project?.id === project.id) set({ changes, loadingChanges: false })
      else set({ loadingChanges: false })
    } catch (e) {
      set({ loadingChanges: false })
      // Background refresh (runs after every finished stream) — stay quiet on
      // builds without the code service instead of toasting repeatedly.
      if (toNormalized(e).code !== 'not_supported') toastError(e, 'Loading proposed changes')
    }
  },

  async applyChange(id) {
    set({ busyChangeId: id })
    try {
      const updated = await unwrap(window.uld.code.changeApply(id))
      set((s) => ({
        changes: s.changes.map((c) => (c.id === id ? updated : c)),
        busyChangeId: null,
      }))
      // A create/delete changes the tree structure; refresh so the new (or
      // removed) file shows without re-opening the project.
      void get().loadTree()
      const verb = updated.changeType === 'delete' ? 'Deleted' : 'Wrote'
      useUiStore.getState().toast(`${verb} ${updated.filePath}`, 'success')
    } catch (e) {
      set({ busyChangeId: null })
      toastError(e, 'Applying the change')
    }
  },

  async rejectChange(id) {
    set({ busyChangeId: id })
    try {
      const updated = await unwrap(window.uld.code.changeReject(id))
      set((s) => ({
        changes: s.changes.map((c) => (c.id === id ? updated : c)),
        busyChangeId: null,
      }))
      useUiStore.getState().toast(`Rejected change to ${updated.filePath}`, 'info')
    } catch (e) {
      set({ busyChangeId: null })
      toastError(e, 'Rejecting the change')
    }
  },

  async readSelectedAsAttachments() {
    const { project, selectedPaths } = get()
    if (!project || selectedPaths.length === 0) return []
    const attachments: Attachment[] = []
    for (const relPath of selectedPaths) {
      try {
        const file = await unwrap(window.uld.code.readFile({ projectId: project.id, relPath }))
        attachments.push({
          id: crypto.randomUUID(),
          name: file.relPath,
          mimeType: 'text/plain',
          sizeBytes: file.sizeBytes,
          textContent: file.content,
        })
      } catch (e) {
        toastError(e, `Reading ${relPath}`)
        return null
      }
    }
    return attachments
  },

  reset() {
    loadToken += 1
    set({
      project: null,
      tree: null,
      selectedPaths: [],
      openFile: null,
      changes: [],
      loadingTree: false,
      loadingChanges: false,
      busyChangeId: null,
    })
  },
}))
