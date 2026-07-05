/**
 * Per-mode artifact completion hook: mode side effects after each completed
 * assistant message. Code mode registers proposed file changes (nothing is
 * written to disk here); the renderer refreshes its change list when the
 * stream 'done' event arrives, so no extra push channel is needed. Write mode
 * upserts the document, Design mode stores HTML artifacts, and Cowork mode
 * saves proposed workspace items with origin 'assistant'. The generic
 * outbound webhook fires (best-effort) on every assistant message, mode
 * independent.
 */

import type { Conversation, Message } from '@shared/types'
import type { AppDatabase } from '../db/database'
import type { CodeService } from '../code/code-service'
import type { CompletionHook } from './completion-hooks'
import {
  extractDocument,
  extractHtmlArtifacts,
  extractWorkspaceItems,
} from './mode-artifacts'

export function createArtifactCompletionHook(
  db: AppDatabase,
  codeService: CodeService,
  /** Generic outbound webhook target (ImBridgeManager.onCompletion). */
  webhook: { onCompletion(conversation: Conversation, message: Message): Promise<void> }
): CompletionHook {
  return (conversation, message) => {
    if (message.role !== 'assistant' || message.content.trim().length === 0) return
    // Generic outbound webhook (best-effort) fires on every assistant message.
    void webhook.onCompletion(conversation, message)
    if (conversation.mode === 'code' && conversation.projectId) {
      codeService.registerProposedChanges(conversation.id, message.content)
      return
    }
    if (conversation.mode === 'write') {
      const doc = extractDocument(message.content)
      if (doc) db.documents.upsertDoc(conversation.id, doc.title, doc.content)
      return
    }
    if (conversation.mode === 'design') {
      for (const html of extractHtmlArtifacts(message.content)) {
        db.documents.addHtml(conversation.id, html.title, html.content)
      }
      return
    }
    if (conversation.mode === 'cowork' && conversation.workspaceId) {
      for (const item of extractWorkspaceItems(message.content)) {
        // Upsert by kind+title: re-emitting a block with the same kind and
        // title updates that item (how assistants keep plans/checklists
        // current across turns — see COWORK_SECTION in prompts.ts).
        db.workspaces.itemUpsertByKindTitle({
          workspaceId: conversation.workspaceId,
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
