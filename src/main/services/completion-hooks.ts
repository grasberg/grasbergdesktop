/**
 * Small dispatcher run by the chat service after an assistant message has
 * been persisted with status 'complete'. Hooks power the mode side effects
 * (Code mode change proposals, Cowork workspace items) without the chat
 * service knowing about them.
 */

import type { Conversation, Message } from '@shared/types'
import { withoutInvocationPolicy } from '../invocation-context'

export type CompletionHook = (
  conversation: Conversation,
  assistantMessage: Message
) => void | Promise<void>

const hooks: CompletionHook[] = []

export function registerCompletionHook(hook: CompletionHook): void {
  hooks.push(hook)
}

/** Test helper — the app never unregisters hooks at runtime. */
export function clearCompletionHooks(): void {
  hooks.length = 0
}

/**
 * Runs every hook in registration order. Each hook is isolated in its own
 * try/catch: a failing hook is logged (message only — never raw payloads or
 * secrets) and must never break stream completion or other hooks.
 */
export async function runCompletionHooks(
  conversation: Conversation,
  assistantMessage: Message
): Promise<void> {
  for (const hook of hooks) {
    try {
      // Hooks start follow-up work (bot deliveries, routed replies) that must
      // not inherit the finished turn's invocation policy.
      await withoutInvocationPolicy(() => hook(conversation, assistantMessage))
    } catch (e) {
      console.error(
        '[completion-hook] hook failed:',
        e instanceof Error ? e.message : 'Unknown error'
      )
    }
  }
}
