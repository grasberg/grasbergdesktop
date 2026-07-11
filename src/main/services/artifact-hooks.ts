/**
 * Work-mode artifact completion hook: side effects after each completed
 * assistant message. uld-change blocks become proposed CodeChange rows
 * (nothing is written to disk here; the renderer refreshes its change list on
 * the stream 'done' event) — for a task without a folder the per-task
 * workspace is created first so non-tool models can propose files too.
 * uld-item blocks upsert workspace items (the Tasks panel), creating and
 * linking the workspace on first use. The generic outbound webhook fires
 * (best-effort) on every assistant message, mode independent.
 */

import type { Conversation, Message } from '@shared/types'
import type { AppDatabase } from '../db/database'
import type { CodeService } from '../code/code-service'
import type { CompletionHook } from './completion-hooks'
import { extractCodeChanges, extractWorkspaceItems } from './mode-artifacts'

/**
 * Creates the conversation's workspace when missing and returns its id (the
 * same first-use behavior as the update_task_list tool).
 */
export function ensureConversationWorkspace(db: AppDatabase, conversationId: string): string | null {
  const conversation = db.conversations.getById(conversationId)
  if (!conversation) return null
  if (conversation.workspaceId) return conversation.workspaceId
  const workspace = db.workspaces.create({ name: conversation.title || 'Tasks' })
  db.conversations.update(conversationId, { workspaceId: workspace.id })
  return workspace.id
}

export function createArtifactCompletionHook(
  db: AppDatabase,
  codeService: CodeService,
  /** Generic outbound webhook target (ImBridgeManager.onCompletion). */
  webhook: { onCompletion(conversation: Conversation, message: Message): Promise<void> },
  /**
   * Lazily creates + links the task's workspace folder so fenced uld-change
   * proposals work before any folder exists. Absent (tests) => proposals
   * require an already-linked folder.
   */
  ensureWorkspaceRoot?: (conversationId: string) => { projectId: string; root: string }
): CompletionHook {
  return (conversation, message) => {
    if (message.role !== 'assistant' || message.content.trim().length === 0) return
    // Generic outbound webhook (best-effort) fires on every assistant message.
    void webhook.onCompletion(conversation, message)
    if (conversation.mode !== 'work') return

    if (extractCodeChanges(message.content).length > 0) {
      if (!conversation.projectId && ensureWorkspaceRoot) {
        // Throws only on fs/db failure; a failed ensure skips the proposals
        // rather than killing the other hooks (completion-hooks isolates us).
        ensureWorkspaceRoot(conversation.id)
      }
      // Re-reads the conversation, so it sees a just-linked folder.
      codeService.registerProposedChanges(conversation.id, message.content)
    }

    const items = extractWorkspaceItems(message.content)
    if (items.length > 0) {
      const workspaceId = conversation.workspaceId ?? ensureConversationWorkspace(db, conversation.id)
      if (!workspaceId) return
      for (const item of items) {
        // Upsert by kind+title: re-emitting a block with the same kind and
        // title updates that item (how assistants keep plans/checklists
        // current across turns — see WORK_SECTION in prompts.ts).
        db.workspaces.itemUpsertByKindTitle({
          workspaceId,
          kind: item.kind,
          title: item.title,
          content: item.content,
          ...(item.status !== undefined ? { status: item.status } : {}),
          origin: 'assistant',
        })
      }
    }
  }
}
