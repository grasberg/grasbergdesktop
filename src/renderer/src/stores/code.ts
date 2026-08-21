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
  CheckpointLite,
  CodeChange,
  CodeProject,
  Conversation,
  FileTreeNode,
  GitStatus,
  GitHubPrInput,
} from '@shared/types'
import type { CodeChangeWithContext } from '@shared/ipc'
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
  /** Pre-edit checkpoints for the open conversation (turn-grouped undo). */
  checkpoints: CheckpointLite[]
  /** Conversation the checkpoints belong to (guards stale refreshes). */
  checkpointsConversationId: string | null
  /** Project-wide changes with conversation titles (the "All chats" scope). */
  allChanges: CodeChangeWithContext[]
  /** Changes panel scope: this conversation only, or the whole project. */
  changesScope: 'conversation' | 'all'
  /** Working-tree status for the commit bar (null = not loaded / no repo info). */
  gitStatus: GitStatus | null
  gitBusy: boolean
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
  loadCheckpoints(conversationId: string): Promise<void>
  applyChange(id: string): Promise<void>
  rejectChange(id: string): Promise<void>
  /** Restores the pre-change content of an APPLIED change (in-app undo). */
  revertChange(id: string): Promise<void>
  /** Reverts every change applied during one assistant turn (bulk undo). */
  revertTurn(conversationId: string, messageSeq: number): Promise<void>
  /**
   * Reads every selected file and converts it to an Attachment.
   * Returns null when a read failed (already toasted).
   */
  readSelectedAsAttachments(): Promise<Attachment[] | null>
  setChangesScope(scope: 'conversation' | 'all'): void
  loadAllChanges(): Promise<void>
  loadGitStatus(): Promise<void>
  /** Stages every unstaged + untracked path. */
  gitStageAll(): Promise<void>
  gitCommit(message: string): Promise<boolean>
  gitCreateBranch(name: string): Promise<boolean>
  gitFetch(): Promise<void>
  gitSetOrigin(url: string): Promise<boolean>
  gitPull(): Promise<void>
  gitPush(confirmDefaultBranch: boolean): Promise<boolean>
  gitCreatePullRequest(input: GitHubPrInput): Promise<string | null>
  /** Suggested commit message from the staged diff, or null on failure. */
  gitGenerateMessage(): Promise<string | null>
  reset(): void
}

/** Guards loadForConversation against out-of-order responses. */
let loadToken = 0
/** Guards loadCheckpoints the same way — last request wins. */
let checkpointsToken = 0

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

/**
 * One app-wide subscription to the review-queue push channel: changes made
 * by ANY conversation (or a background run) refresh the open project's panel
 * and git status live.
 */
let changesSubscribed = false
function ensureChangesSubscription(): void {
  if (changesSubscribed) return
  changesSubscribed = true
  window.uld.code.onChangesChanged(({ projectId }) => {
    const s = useCodeStore.getState()
    if (s.project?.id !== projectId) return
    void s.loadChanges()
    if (s.changesScope === 'all') void s.loadAllChanges()
    void s.loadGitStatus()
    // Applies create checkpoints — keep the turn-undo affordances current.
    if (s.checkpointsConversationId) void s.loadCheckpoints(s.checkpointsConversationId)
  })
}

export const useCodeStore = create<CodeStoreState>()((set, get) => ({
  project: null,
  tree: null,
  selectedPaths: [],
  openFile: null,
  changes: [],
  checkpoints: [],
  checkpointsConversationId: null,
  allChanges: [],
  changesScope: 'conversation',
  gitStatus: null,
  gitBusy: false,
  loadingTree: false,
  loadingChanges: false,
  busyChangeId: null,

  async openProjectViaPicker() {
    try {
      ensureChangesSubscription()
      const path = await unwrap(window.uld.app.pickFolder())
      if (!path) return null
      const project = await unwrap(window.uld.code.projectOpen(path))
      set({ project, tree: null, selectedPaths: [], openFile: null, changes: [], allChanges: [], gitStatus: null })
      await Promise.all([get().loadTree(), get().loadChanges(), get().loadGitStatus()])
      return project
    } catch (e) {
      toastError(e, 'Opening the folder')
      return null
    }
  },

  async loadForConversation(conversation) {
    const token = ++loadToken
    ensureChangesSubscription()
    if (!conversation.projectId) {
      set({ project: null, tree: null, selectedPaths: [], openFile: null, changes: [], checkpoints: [], checkpointsConversationId: null, allChanges: [], gitStatus: null })
      return
    }
    try {
      const projects = await unwrap(window.uld.code.projectsList())
      if (token !== loadToken) return
      const project = projects.find((p) => p.id === conversation.projectId) ?? null
      if (!project) {
        set({ project: null, tree: null, selectedPaths: [], openFile: null, changes: [], checkpoints: [], checkpointsConversationId: null, allChanges: [], gitStatus: null })
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
        // Another project's review queue must never stay on screen: the panel
        // would apply/reject changes belonging to a project that isn't open.
        ...(samePath ? {} : { changes: [], allChanges: [], gitStatus: null }),
        // Checkpoints are per conversation, not per project — always reload.
        ...(get().checkpointsConversationId === conversation.id
          ? {}
          : { checkpoints: [], checkpointsConversationId: null }),
      })
      await Promise.all([
        get().loadTree(),
        get().loadChanges(),
        get().loadGitStatus(),
        get().loadCheckpoints(conversation.id),
      ])
      if (get().changesScope === 'all') void get().loadAllChanges()
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

  async loadCheckpoints(conversationId) {
    const token = ++checkpointsToken
    try {
      const checkpoints = await unwrap(window.uld.code.checkpointsList(conversationId))
      // Last request wins — a slow response for a previous conversation must
      // never repopulate the store after a switch.
      if (token === checkpointsToken) {
        set({ checkpoints, checkpointsConversationId: conversationId })
      }
    } catch {
      // Background refresh — checkpoint affordances just stay hidden.
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

  async revertChange(id) {
    set({ busyChangeId: id })
    try {
      const updated = await unwrap(window.uld.code.changeRevert(id))
      set((s) => ({
        changes: s.changes.map((c) => (c.id === id ? updated : c)),
        busyChangeId: null,
      }))
      // Reverting a create removes the file (and a delete restores one).
      void get().loadTree()
      useUiStore.getState().toast(`Reverted change to ${updated.filePath}`, 'success')
    } catch (e) {
      set({ busyChangeId: null })
      toastError(e, 'Reverting the change')
    }
  },

  async revertTurn(conversationId, messageSeq) {
    try {
      const result = await unwrap(window.uld.code.revertTurn({ conversationId, messageSeq }))
      void get().loadChanges()
      void get().loadTree()
      void get().loadCheckpoints(conversationId)
      const total = result.reverted.length + result.skipped.length
      const toast = useUiStore.getState().toast
      if (result.skipped.length === 0) {
        toast(
          `Reverted ${result.reverted.length} file${result.reverted.length === 1 ? '' : 's'}.`,
          'success'
        )
      } else {
        // Honest partial outcome: say what was skipped and why.
        const detail = result.skipped
          .map((s) => `${s.filePath} skipped: ${s.reason}`)
          .join(' · ')
        toast(`Reverted ${result.reverted.length} of ${total} — ${detail}`, 'info')
      }
    } catch (e) {
      toastError(e, 'Undoing the turn')
    }
  },

  setChangesScope(scope) {
    set({ changesScope: scope })
    if (scope === 'all') void get().loadAllChanges()
  },

  async loadAllChanges() {
    const { project } = get()
    if (!project) return
    try {
      const allChanges = await unwrap(window.uld.code.changesListAll(project.id))
      if (get().project?.id === project.id) set({ allChanges })
    } catch (e) {
      if (toNormalized(e).code !== 'not_supported') toastError(e, 'Loading the review queue')
    }
  },

  async loadGitStatus() {
    const { project } = get()
    if (!project) return
    try {
      const gitStatus = await unwrap(window.uld.code.gitStatus(project.id))
      if (get().project?.id === project.id) set({ gitStatus })
    } catch {
      // No git / no repo is a normal state — the commit bar just hides.
      if (get().project?.id === project.id) set({ gitStatus: null })
    }
  },

  async gitStageAll() {
    const { project, gitStatus } = get()
    if (!project || !gitStatus) return
    const paths = [...gitStatus.unstaged.map((f) => f.path), ...gitStatus.untracked]
    if (paths.length === 0) return
    set({ gitBusy: true })
    try {
      const updated = await unwrap(window.uld.code.gitStage(project.id, paths))
      set({ gitStatus: updated, gitBusy: false })
    } catch (e) {
      set({ gitBusy: false })
      toastError(e, 'Staging files')
    }
  },

  async gitCommit(message) {
    const { project } = get()
    if (!project) return false
    set({ gitBusy: true })
    try {
      const result = await unwrap(window.uld.code.gitCommit(project.id, message))
      set({ gitBusy: false })
      useUiStore
        .getState()
        .toast(
          `Committed ${result.sha}${result.branch ? ` on '${result.branch}'` : ''}`,
          'success'
        )
      void get().loadGitStatus()
      return true
    } catch (e) {
      set({ gitBusy: false })
      toastError(e, 'Committing')
      return false
    }
  },

  async gitCreateBranch(name) {
    const { project } = get()
    if (!project) return false
    set({ gitBusy: true })
    try {
      const gitStatus = await unwrap(window.uld.code.gitCreateBranch(project.id, name))
      set({ gitStatus, gitBusy: false })
      useUiStore.getState().toast(`Switched to new branch '${name}'`, 'success')
      return true
    } catch (e) {
      set({ gitBusy: false })
      toastError(e, 'Creating the branch')
      return false
    }
  },

  async gitFetch() {
    const { project } = get()
    if (!project) return
    set({ gitBusy: true })
    try {
      const gitStatus = await unwrap(window.uld.code.gitFetch(project.id))
      set({ gitStatus, gitBusy: false })
      useUiStore.getState().toast('Fetched origin.', 'success')
    } catch (e) {
      set({ gitBusy: false })
      toastError(e, 'Fetching origin')
    }
  },

  async gitSetOrigin(url) {
    const { project } = get()
    if (!project) return false
    set({ gitBusy: true })
    try {
      const gitStatus = await unwrap(window.uld.code.gitSetOrigin(project.id, url))
      set({ gitStatus, gitBusy: false })
      useUiStore.getState().toast('Configured the origin remote.', 'success')
      return true
    } catch (e) {
      set({ gitBusy: false })
      toastError(e, 'Configuring origin')
      return false
    }
  },

  async gitPull() {
    const { project } = get()
    if (!project) return
    set({ gitBusy: true })
    try {
      const gitStatus = await unwrap(window.uld.code.gitPull(project.id))
      set({ gitStatus, gitBusy: false })
      useUiStore.getState().toast('Pulled the upstream branch.', 'success')
      void get().loadTree()
      void get().loadChanges()
    } catch (e) {
      set({ gitBusy: false })
      toastError(e, 'Pulling the upstream branch')
    }
  },

  async gitPush(confirmDefaultBranch) {
    const { project } = get()
    if (!project) return false
    set({ gitBusy: true })
    try {
      const gitStatus = await unwrap(window.uld.code.gitPush(project.id, confirmDefaultBranch))
      set({ gitStatus, gitBusy: false })
      useUiStore.getState().toast(`Pushed '${gitStatus.branch ?? 'current branch'}'.`, 'success')
      return true
    } catch (e) {
      set({ gitBusy: false })
      toastError(e, 'Pushing the branch')
      return false
    }
  },

  async gitCreatePullRequest(input) {
    const { project } = get()
    if (!project) return null
    set({ gitBusy: true })
    try {
      const result = await unwrap(window.uld.code.githubPrCreate(project.id, input))
      set({ gitBusy: false })
      useUiStore.getState().toast('GitHub pull request created.', 'success')
      return result.url
    } catch (e) {
      set({ gitBusy: false })
      toastError(e, 'Creating the GitHub pull request')
      return null
    }
  },

  async gitGenerateMessage() {
    const { project } = get()
    if (!project) return null
    set({ gitBusy: true })
    try {
      const result = await unwrap(window.uld.code.gitGenerateCommitMessage(project.id))
      set({ gitBusy: false })
      return result.message
    } catch (e) {
      set({ gitBusy: false })
      toastError(e, 'Generating a commit message')
      return null
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
      checkpoints: [],
      checkpointsConversationId: null,
      allChanges: [],
      gitStatus: null,
      gitBusy: false,
      loadingTree: false,
      loadingChanges: false,
      busyChangeId: null,
    })
  },
}))
