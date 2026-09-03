import { create } from 'zustand'
import type { Message, ResearchDepth, ResearchRunInfo, StartStreamResult } from '@shared/types'
import { toNormalized, unwrap } from '@/api/uld'
import type { ChatStoreState } from './contracts'
import { useConversationsStore } from './conversations'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'

/** Guards openConversation against out-of-order responses when switching fast. */
let openToken = 0

function replaceOrAppend(messages: Message[], targetId: string, replacement: Message): Message[] {
  let replaced = false
  const next = messages.map((m) => {
    if (m.id === targetId) {
      replaced = true
      return replacement
    }
    return m
  })
  return replaced ? next : [...next, replacement]
}

export const useChatStore = create<ChatStoreState>()((set, get) => {
  /**
   * Re-pulls the open conversation after a generation settles so a title/model
   * the main side may have set (e.g. auto-generated title) shows in the header.
   * No-ops if the user has since switched away.
   */
  const refreshOpenConversation = (conversationId: string): void => {
    void window.uld.conversations.get(conversationId).then((res) => {
      if (res.ok && get().conversation?.id === res.data.id) {
        set({ conversation: res.data })
      }
    })
  }

  /**
   * Applies a StartStreamResult that replaces an existing assistant message.
   * No-ops when the user switched away while the IPC was in flight — main keeps
   * generating and handleStreamEvent re-adopts the placeholder on return.
   */
  const beginReplacementStream = (
    conversationId: string,
    replacedMessageId: string,
    result: StartStreamResult
  ): void => {
    set((s) =>
      s.conversation?.id === conversationId
        ? {
            messages: replaceOrAppend(s.messages, replacedMessageId, result.assistantMessage),
            streaming: {
              streamId: result.streamId,
              assistantMessageId: result.assistantMessage.id,
            },
            error: null,
          }
        : {}
    )
  }

  /** Replaces the message with the given id by `fn(message)`; others untouched. */
  const patchMessage = (id: string, fn: (m: Message) => Message): void => {
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? fn(m) : m)),
    }))
  }

  return {
    conversation: null,
    messages: [],
    streaming: null,
    loading: false,
    error: null,

    async openConversation(id) {
      const token = ++openToken
      if (id === null) {
        set({ conversation: null, messages: [], streaming: null, loading: false, error: null })
        return
      }
      set({ loading: true, error: null, streaming: null })
      try {
        const [conversation, messages] = await Promise.all([
          unwrap(window.uld.conversations.get(id)),
          unwrap(window.uld.conversations.messages(id)),
        ])
        if (token !== openToken) return
        // If a generation for this conversation is still in flight (user
        // switched away and back), the placeholder has status 'streaming'.
        // The streamId is recovered from the next arriving envelope in
        // handleStreamEvent. Reset `streaming` here so no pointer from the
        // previously open conversation lingers (which would strand the flag
        // on a message id that isn't in the freshly loaded list).
        set({ conversation, messages, streaming: null, loading: false })
      } catch (e) {
        if (token !== openToken) return
        set({ conversation: null, messages: [], loading: false, error: toNormalized(e) })
      }
    },

    async send(content, attachments, opts) {
      const { conversation, streaming } = get()
      if (!conversation) return
      // While a response streams, plain messages queue main-side (v47); the
      // Composer already blocks commands/one-shots in that state.
      const settings = useSettingsStore.getState().settings

      // "/compact" summarizes older messages now, without sending anything.
      const bare = content.trim()
      if (bare === '/compact') {
        if (streaming) return
        try {
          const result = await unwrap(window.uld.chat.compact(conversation.id))
          useUiStore
            .getState()
            .toast(
              result.compacted
                ? 'Older messages were summarized to free up context.'
                : 'Nothing to compact yet — the conversation is still short.',
              'info'
            )
          refreshOpenConversation(conversation.id)
        } catch (e) {
          set({ error: toNormalized(e) })
        }
        return
      }

      // One-shot Mixture of Agents: "/moa <prompt>" runs a single message through
      // the default preset without changing the conversation's model. "/compare
      // <prompt>" fans the same preset out side by side instead of aggregating.
      // "/research [quick|standard|deep] <question>" runs the deep-research
      // pipeline (the composer toggle does the same via opts.research).
      let outgoing = content
      let overrides:
        | { moaPresetId?: string; compare?: boolean; research?: { depth?: ResearchDepth } }
        | undefined
      const trimmed = content.trimStart()
      const researchMatch = /^\/research(?:\s+(quick|standard|deep))?\b\s*([\s\S]*)$/i.exec(
        trimmed
      )
      const slash = researchMatch
        ? undefined
        : ['/moa', '/compare'].find(
            (cmd) =>
              trimmed === cmd || trimmed.slice(0, cmd.length + 1).toLowerCase() === `${cmd} `
          )
      if (researchMatch) {
        const depth = researchMatch[1]?.toLowerCase() as ResearchDepth | undefined
        outgoing = researchMatch[2].trim()
        if (!outgoing) {
          set({
            error: {
              code: 'invalid_request',
              message:
                'Usage: /research [quick|standard|deep] <your question> — searches the web and writes a cited report.',
              retryable: false,
            },
          })
          return
        }
        overrides = { research: depth ? { depth } : {} }
      } else if (slash) {
        const presetId = settings?.defaultMoaPresetId ?? null
        if (!presetId) {
          set({
            error: {
              code: 'invalid_request',
              message:
                'No default Mixture-of-Agents preset is set. Configure one in Settings → Mixture of Agents.',
              retryable: false,
            },
          })
          return
        }
        outgoing = trimmed.slice(slash.length).trim()
        if (!outgoing) {
          set({
            error: {
              code: 'invalid_request',
              message: `Usage: ${slash} <your prompt> — runs one message through the default MoA preset.`,
              retryable: false,
            },
          })
          return
        }
        overrides = { moaPresetId: presetId, ...(slash === '/compare' ? { compare: true } : {}) }
      } else if (opts?.research) {
        overrides = { research: opts.research }
      } else if (opts?.comparePresetId) {
        overrides = { moaPresetId: opts.comparePresetId, compare: true }
      }

      // A MoA run supplies its own aggregator provider, so it doesn't need a
      // default/override single-model provider to be configured. A research
      // run does NOT — its synthesizer is the ordinary acting model.
      const usingResearch = !!overrides?.research
      const usingMoa =
        !usingResearch && (!!overrides?.moaPresetId || !!conversation.moaPresetId)
      if (!usingMoa && !settings?.defaultProviderId && !conversation.providerId) {
        set({
          error: {
            code: 'invalid_request',
            message: 'Add a provider and select a default model in Settings first.',
            retryable: false,
          },
        })
        return
      }
      set({ error: null })
      try {
        const result = await unwrap(
          window.uld.chat.send({
            conversationId: conversation.id,
            content: outgoing,
            attachments,
            ...(overrides ? { overrides } : {}),
          })
        )
        if ('queued' in result) {
          // Busy conversation: the message is persisted and runs as the next
          // turn after the current response completes. Show it immediately.
          set((s) =>
            s.conversation?.id === conversation.id
              ? { messages: [...s.messages, result.userMessage] }
              : {}
          )
          return
        }
        // main awaits model/token resolution before answering, so another
        // conversation may be open by now — never graft this stream onto it.
        set((s) =>
          s.conversation?.id === conversation.id
            ? {
                messages: [
                  ...s.messages,
                  ...(result.userMessage ? [result.userMessage] : []),
                  result.assistantMessage,
                ],
                streaming: {
                  streamId: result.streamId,
                  assistantMessageId: result.assistantMessage.id,
                },
              }
            : {}
        )
      } catch (e) {
        set({ error: toNormalized(e) })
      }
    },

    async stop() {
      const { streaming } = get()
      if (!streaming) return
      try {
        await unwrap(window.uld.chat.stop(streaming.streamId))
        // Keep streaming state; the 'done' (aborted) envelope clears it.
      } catch (e) {
        set({ error: toNormalized(e) })
      }
    },

    async pickCompareWinner(messageId, referenceIndex) {
      const { conversation, streaming } = get()
      if (!conversation || streaming) return
      try {
        const result = await unwrap(
          window.uld.chat.pickCompareWinner({
            conversationId: conversation.id,
            messageId,
            referenceIndex,
          })
        )
        // Guard against switching conversations while the IPC was in flight —
        // replaceOrAppend would otherwise append the message to the new one.
        set((s) =>
          s.conversation?.id === result.conversation.id
            ? {
                messages: replaceOrAppend(s.messages, result.message.id, result.message),
                conversation: result.conversation,
              }
            : {}
        )
      } catch (e) {
        set({ error: toNormalized(e) })
      }
    },

    async regenerate(messageId, opts) {
      const { conversation, streaming } = get()
      if (!conversation || streaming) return
      set({ error: null })
      try {
        const result = await unwrap(
          window.uld.chat.regenerate({
            conversationId: conversation.id,
            messageId,
            ...(opts?.overrides ? { overrides: opts.overrides } : {}),
            ...(opts?.mode ? { mode: opts.mode } : {}),
          })
        )
        beginReplacementStream(conversation.id, messageId, result)
      } catch (e) {
        set({ error: toNormalized(e) })
      }
    },

    async editAndRerun(messageId, newContent) {
      const { conversation, streaming } = get()
      if (!conversation || streaming) return
      set({ error: null })
      try {
        const result = await unwrap(
          window.uld.chat.editAndRerun({ conversationId: conversation.id, messageId, newContent })
        )
        set((s) => {
          if (s.conversation?.id !== conversation.id) return {}
          const idx = s.messages.findIndex((m) => m.id === messageId)
          const kept = idx >= 0 ? s.messages.slice(0, idx) : s.messages
          return {
            messages: [
              ...kept,
              ...(result.userMessage ? [result.userMessage] : []),
              result.assistantMessage,
            ],
            streaming: {
              streamId: result.streamId,
              assistantMessageId: result.assistantMessage.id,
            },
          }
        })
      } catch (e) {
        set({ error: toNormalized(e) })
      }
    },

    async updateConversation(patch) {
      const { conversation } = get()
      if (!conversation) return
      try {
        const updated = await unwrap(
          window.uld.conversations.update({ id: conversation.id, patch })
        )
        if (get().conversation?.id === conversation.id) {
          set({ conversation: updated })
        }
      } catch (e) {
        set({ error: toNormalized(e) })
      }
    },

    handleStreamEvent(envelope) {
      const { conversation } = get()
      const event = envelope.event
      if (conversation?.id !== envelope.conversationId) {
        // Foreign conversation: ignore content, but a finished generation may
        // have produced a new title/snippet — refresh the sidebar.
        if (event.type === 'done' || event.type === 'error') {
          void useConversationsStore.getState().load()
        }
        return
      }

      // Recover streaming state after switching away and back mid-generation:
      // adopt the persisted placeholder (status 'streaming') for this stream.
      let streaming = get().streaming
      if (!streaming || streaming.streamId !== envelope.streamId) {
        const placeholder = [...get().messages]
          .reverse()
          .find((m) => m.role === 'assistant' && m.status === 'streaming')
        if (placeholder) {
          streaming = { streamId: envelope.streamId, assistantMessageId: placeholder.id }
          set({ streaming })
        }
      }

      switch (event.type) {
        case 'text-delta':
        case 'reasoning-delta': {
          if (!streaming) return
          patchMessage(streaming.assistantMessageId, (m) =>
            event.type === 'text-delta'
              ? { ...m, content: m.content + event.text }
              : { ...m, reasoning: (m.reasoning ?? '') + event.text }
          )
          return
        }
        case 'usage': {
          if (!streaming) return
          patchMessage(streaming.assistantMessageId, (m) => ({ ...m, usage: event.usage }))
          return
        }
        case 'tool-call': {
          if (!streaming) return
          patchMessage(streaming.assistantMessageId, (m) => ({
            ...m,
            toolCalls: [
              ...(m.toolCalls ?? []).filter((tc) => tc.id !== event.toolCall.id),
              event.toolCall,
            ],
          }))
          return
        }
        case 'tool-output': {
          if (!streaming) return
          // Accumulate live output on the matching in-flight tool call; the
          // final 'tool-call' event (with result) replaces the record.
          patchMessage(streaming.assistantMessageId, (m) => ({
            ...m,
            toolCalls: (m.toolCalls ?? []).map((tc) =>
              tc.id === event.toolCallId
                ? { ...tc, liveOutput: (tc.liveOutput ?? '') + event.chunk }
                : tc
            ),
          }))
          return
        }
        case 'moa-reference': {
          if (!streaming) return
          patchMessage(streaming.assistantMessageId, (m) => ({
            ...m,
            moaReferences: [
              ...(m.moaReferences ?? []).filter((r) => r.index !== event.reference.index),
              event.reference,
            ].sort((a, b) => a.index - b.index),
          }))
          return
        }
        case 'attachment': {
          if (!streaming) return
          // A generated image was stored: attach it to the streaming message
          // (upsert by id; the final 'done' message carries them persisted).
          patchMessage(streaming.assistantMessageId, (m) => ({
            ...m,
            attachments: [
              ...(m.attachments ?? []).filter((a) => a.id !== event.attachment.id),
              event.attachment,
            ],
          }))
          return
        }
        case 'research-activity': {
          if (!streaming) return
          // Accumulate live activities on a transient research shell; the
          // final 'done' message replaces it with the persisted run info.
          patchMessage(streaming.assistantMessageId, (m) => {
            const research: ResearchRunInfo = m.research ?? {
              depth: 'standard',
              plan: [],
              sources: [],
              searches: 0,
              pagesRead: 0,
            }
            return {
              ...m,
              research: {
                ...research,
                activities: [
                  ...(research.activities ?? []).filter((a) => a.id !== event.activity.id),
                  event.activity,
                ],
              },
            }
          })
          return
        }
        case 'failover': {
          // Reliability failover: the placeholder was reset and re-runs on a
          // fallback model — replace it wholesale (clears the pushed partial
          // text/reasoning/toolCalls). The streaming pointer stays: same
          // streamId and assistant message id across attempts.
          set((s) => ({
            messages: replaceOrAppend(s.messages, event.message.id, event.message),
          }))
          return
        }
        case 'done':
        case 'error': {
          set((s) => ({
            messages: replaceOrAppend(s.messages, event.message.id, event.message),
            streaming:
              s.streaming?.streamId === envelope.streamId ? null : s.streaming,
            ...(event.type === 'error' ? { error: event.error } : {}),
          }))
          // Update just this conversation's sidebar row (title may have been
          // auto-generated, updatedAt/snippet changed) instead of reloading the
          // whole list on every generation.
          void useConversationsStore
            .getState()
            .syncSummary(envelope.conversationId, event.message.content)
          refreshOpenConversation(envelope.conversationId)
          return
        }
      }
    },

    handleConversationsChanged(conversationId) {
      const { conversation, streaming } = get()
      // Only the open conversation needs re-pulling, and never mid-stream: the
      // live deltas are ahead of what's persisted, and 'done' refreshes anyway.
      if (conversation?.id !== conversationId || streaming) return
      void window.uld.conversations.messages(conversationId).then((res) => {
        if (res.ok && get().conversation?.id === conversationId && !get().streaming) {
          set({ messages: res.data })
        }
      })
      refreshOpenConversation(conversationId)
    },

    clearError() {
      set({ error: null })
    },
  }
})
