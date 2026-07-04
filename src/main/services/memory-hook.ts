/**
 * Memory completion hook: persists ```uld-memory directives from every
 * completed assistant message, in EVERY conversation mode (unlike the per-mode
 * artifact hook). Gated on settings.memoryEnabled, read at run time so the
 * Settings toggle takes effect immediately.
 */

import type { AppDatabase } from '../db/database'
import type { CompletionHook } from './completion-hooks'
import { extractMemoryDirectives } from './mode-artifacts'

export function createMemoryCompletionHook(db: AppDatabase): CompletionHook {
  return (conversation, message) => {
    if (message.role !== 'assistant' || message.content.trim().length === 0) return
    if (!db.settings.get().memoryEnabled) return
    for (const directive of extractMemoryDirectives(message.content)) {
      if (directive.action === 'forget') {
        db.memories.removeByTitle(directive.title)
      } else {
        db.memories.upsertByTitle({
          title: directive.title,
          content: directive.content,
          sourceConversationId: conversation.id,
        })
      }
    }
  }
}
