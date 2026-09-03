import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ConvForkLineage } from '@shared/ipc'
import type { KnowledgeBase, ProviderErrorCode } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { useConversationsStore } from '@/stores/conversations'
import { usePromptsStore } from '@/stores/prompts'
import { useUiStore } from '@/stores/ui'
import { STARTER_PROMPTS } from '@/lib/starter-prompts'
import MessageItem from './MessageItem'
import BotChatHeader from './BotChatHeader'
import Composer from './Composer'
import CostBadge from './CostBadge'
import './chat.css'

const FRIENDLY_ERROR: Record<ProviderErrorCode, string> = {
  auth: 'Authentication failed — check the API key for this provider.',
  rate_limit: 'The provider is rate-limiting requests.',
  invalid_request: 'The provider rejected the request.',
  context_length: 'The conversation is too long for this model.',
  server: 'The provider had a server error.',
  network: 'Could not reach the provider — check your connection.',
  timeout: 'The request timed out.',
  aborted: 'Generation was stopped.',
  not_supported: 'This feature is not supported by the provider or model.',
  unknown: 'Something went wrong.',
}

/** How close to the bottom (px) still counts as "at the bottom". */
const BOTTOM_THRESHOLD = 60

function ConversationSettingsButton(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const updateConversation = useChatStore((s) => s.updateConversation)
  const promptTemplates = usePromptsStore((s) => s.templates)
  const loadPrompts = usePromptsStore((s) => s.load)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [budgetDraft, setBudgetDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const rootRef = useRef<HTMLDivElement>(null)

  const toggle = (): void => {
    if (!open) {
      setDraft(conversation?.systemPrompt ?? '')
      setBudgetDraft(conversation?.budgetUsd != null ? String(conversation.budgetUsd) : '')
      void loadPrompts()
      void window.uld.knowledge.list().then((res) => {
        if (res.ok) setKnowledgeBases(res.data)
      })
    }
    setOpen(!open)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Consume it: closing the popover must not also reach the global handler
        // (which would stop an in-flight generation).
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const budget = Number(budgetDraft)
      await updateConversation({
        systemPrompt: draft.trim() ? draft : null,
        budgetUsd: budgetDraft.trim() && Number.isFinite(budget) && budget > 0 ? budget : null,
      })
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="conv-settings" ref={rootRef}>
      <button
        type="button"
        className="btn-icon"
        aria-label="Conversation settings"
        aria-expanded={open}
        title="Conversation settings"
        disabled={!conversation}
        onClick={toggle}
      >
        ⚙
      </button>
      {open && (
        <div className="conv-settings-popover" role="dialog" aria-label="Conversation settings">
          <label className="conv-settings-label" htmlFor="conv-system-prompt">
            System prompt
          </label>
          {promptTemplates.length > 0 && (
            <select
              className="select conv-settings-template"
              aria-label="Use a saved prompt as the system prompt"
              value=""
              onChange={(e) => {
                const t = promptTemplates.find((x) => x.id === e.target.value)
                if (t) setDraft(t.body)
              }}
            >
              <option value="">Use a saved prompt…</option>
              {promptTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          )}
          <textarea
            id="conv-system-prompt"
            className="textarea conv-settings-textarea"
            rows={6}
            value={draft}
            placeholder="Leave empty to use the global default"
            onChange={(e) => setDraft(e.target.value)}
          />
          {knowledgeBases.length > 0 && (
            <>
              <label className="conv-settings-label" htmlFor="conv-knowledge-base">
                Knowledge base
              </label>
              <select
                id="conv-knowledge-base"
                className="select conv-settings-template"
                value={conversation?.knowledgeBaseId ?? ''}
                onChange={(e) =>
                  void updateConversation({ knowledgeBaseId: e.target.value || null })
                }
              >
                <option value="">None</option>
                {knowledgeBases.map((kb) => (
                  <option key={kb.id} value={kb.id}>
                    {kb.name} ({kb.chunkCount} chunks)
                  </option>
                ))}
              </select>
            </>
          )}
          <label className="conv-settings-label" htmlFor="conv-budget-usd">
            Monthly budget (USD)
          </label>
          <input
            id="conv-budget-usd"
            className="input"
            type="number"
            min="0.01"
            step="0.01"
            value={budgetDraft}
            placeholder="No cap"
            onChange={(e) => setBudgetDraft(e.target.value)}
          />
          <p className="field-hint">
            Generation pauses to ask once this conversation&apos;s month-to-date estimate reaches
            the cap. Estimates only — unpriced models excluded.
          </p>
          <div className="conv-settings-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Backlink chip on forked conversations: "Forked from <parent>" navigates to
 * the parent; when sibling forks exist it opens a small menu listing them.
 */
function ForkOriginChip(): ReactElement | null {
  const conversation = useChatStore((s) => s.conversation)
  const [lineage, setLineage] = useState<ConvForkLineage | null>(null)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const conversationId = conversation?.id ?? null
  const isFork = Boolean(conversation?.parentConversationId)

  useEffect(() => {
    setLineage(null)
    setOpen(false)
    if (!conversationId || !isFork) return
    let cancelled = false
    void window.uld.conversations.forkLineage(conversationId).then((res) => {
      if (!cancelled && res.ok) setLineage(res.data)
    })
    return () => {
      cancelled = true
    }
  }, [conversationId, isFork])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Consume it: closing the menu must not also reach the global handler.
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // Nothing until the lineage resolves — a placeholder chip would flash
  // "deleted conversation" on every open of a healthy fork.
  if (!conversation || !isFork || !lineage) return null

  const parent = lineage.parent
  const siblings = lineage.siblings
  const label = `⑂ Forked from ${parent?.title ?? 'a deleted conversation'}`

  if (!parent && siblings.length === 0) {
    return <span className="chat-fork-chip chat-fork-chip-inert">{label}</span>
  }

  return (
    <div className="chat-fork-origin" ref={rootRef}>
      <button
        type="button"
        className="chat-fork-chip"
        title={parent ? `Open "${parent.title}"` : undefined}
        aria-expanded={siblings.length > 0 ? open : undefined}
        onClick={() => {
          if (siblings.length > 0) {
            setOpen((o) => !o)
          } else if (parent) {
            useConversationsStore.getState().select(parent.id)
          }
        }}
      >
        {label}
      </button>
      {open && siblings.length > 0 && (
        <div className="chat-fork-menu" role="menu" aria-label="Fork lineage">
          {parent && (
            <button
              type="button"
              className="chat-fork-menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                useConversationsStore.getState().select(parent.id)
              }}
            >
              Open original: {parent.title}
            </button>
          )}
          <div className="chat-fork-menu-heading">Other forks</div>
          {siblings.map((sibling) => (
            <button
              key={sibling.id}
              type="button"
              className="chat-fork-menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                useConversationsStore.getState().select(sibling.id)
              }}
            >
              {sibling.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CompactionBanner(): ReactElement | null {
  const conversation = useChatStore((s) => s.conversation)
  const [open, setOpen] = useState(false)
  const summary = conversation?.summaryText
  if (!summary || summary.trim().length === 0) return null
  return (
    <div className="compaction-banner">
      <button
        type="button"
        className="compaction-banner-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} Earlier messages were condensed to save context
      </button>
      {open && <div className="compaction-banner-body">{summary}</div>}
    </div>
  )
}

function ErrorBanner(): ReactElement | null {
  const error = useChatStore((s) => s.error)
  const messages = useChatStore((s) => s.messages)
  const streaming = useChatStore((s) => s.streaming)
  const clearError = useChatStore((s) => s.clearError)
  const regenerate = useChatStore((s) => s.regenerate)
  const editAndRerun = useChatStore((s) => s.editAndRerun)

  if (!error) return null

  const last = messages[messages.length - 1]
  const canRetry = error.retryable && !streaming && !!last

  const retry = (): void => {
    clearError()
    if (!last) return
    if (last.role === 'assistant') {
      void regenerate(last.id)
    } else if (last.role === 'user') {
      // Re-runs the same user message without duplicating it.
      void editAndRerun(last.id, last.content)
    }
  }

  return (
    <div className="chat-error-banner" role="alert">
      <span className="badge chat-error-code">{error.code}</span>
      <div className="chat-error-text">
        <span>{FRIENDLY_ERROR[error.code]}</span>
        {error.message && error.message !== FRIENDLY_ERROR[error.code] && (
          <span className="chat-error-detail">{error.message}</span>
        )}
      </div>
      {canRetry && (
        <button type="button" className="btn chat-error-retry" onClick={retry}>
          Try again
        </button>
      )}
      <button
        type="button"
        className="btn-icon"
        aria-label="Dismiss error"
        onClick={clearError}
      >
        ×
      </button>
    </div>
  )
}

export default function ChatView(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const messages = useChatStore((s) => s.messages)
  const streaming = useChatStore((s) => s.streaming)
  const loading = useChatStore((s) => s.loading)

  const listRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  const scrollToBottom = useCallback((smooth: boolean): void => {
    const el = listRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setAtBottom(dist < BOTTOM_THRESHOLD)
  }

  // Jump to the bottom whenever a different conversation opens.
  useEffect(() => {
    setAtBottom(true)
    scrollToBottom(false)
  }, [conversation?.id, scrollToBottom])

  // Smart autoscroll: follow new content only while the user is at the bottom.
  useEffect(() => {
    if (atBottom) scrollToBottom(false)
  }, [messages, atBottom, scrollToBottom])

  // System rows are transcript plumbing (compaction notes) — except a bot
  // handoff marker (v48), which renders as a card.
  const visibleMessages = messages.filter((m) => m.role !== 'system' || m.handoff)

  return (
    <div className="chat-view">
      <header className="chat-header">
        {conversation?.agentId ? (
          <BotChatHeader agentId={conversation.agentId} fallbackTitle={conversation.title} />
        ) : (
          <h1 className="chat-title" title={conversation?.title ?? undefined}>
            {conversation ? conversation.title : 'Chat'}
          </h1>
        )}
        <ForkOriginChip />
        <div className="chat-header-actions">
          {conversation && <CostBadge conversationId={conversation.id} />}
          <ConversationSettingsButton />
        </div>
      </header>

      <ErrorBanner />
      <CompactionBanner />

      <div className="chat-body">
        <div
          className="chat-messages"
          ref={listRef}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-label="Messages"
        >
          {!conversation && !loading && (
            <div className="chat-empty">
              <div className="chat-empty-title">No conversation selected</div>
              <div className="chat-empty-hint">
                Pick a conversation from the sidebar or create a new one.
              </div>
            </div>
          )}
          {conversation && loading && visibleMessages.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty-hint">Loading…</div>
            </div>
          )}
          {conversation && !loading && visibleMessages.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty-title">Start the conversation</div>
              <div className="chat-empty-hint">
                Type a message below — or pick a starter to see what Grasberg can do.
              </div>
              <div className="chat-starters">
                {STARTER_PROMPTS[conversation.mode].map((starter) => (
                  <button
                    key={starter.id}
                    type="button"
                    className="card chat-starter"
                    onClick={() => useUiStore.getState().seedComposer(starter.prompt)}
                  >
                    <strong>{starter.title}</strong>
                    <span className="chat-starter-preview">{starter.prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {visibleMessages.map((m, i) => (
            <MessageItem key={m.id} message={m} isLast={i === visibleMessages.length - 1} />
          ))}
        </div>

        {!atBottom && visibleMessages.length > 0 && (
          <button
            type="button"
            className="chat-jump-latest"
            aria-label="Jump to latest message"
            onClick={() => {
              setAtBottom(true)
              scrollToBottom(!streaming)
            }}
          >
            ↓ Jump to latest
          </button>
        )}
      </div>

      <footer className="chat-footer">
        <Composer />
      </footer>
    </div>
  )
}
