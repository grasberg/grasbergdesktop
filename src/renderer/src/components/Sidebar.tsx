import { useEffect, useRef, useState } from 'react'
import type { ConversationMode, ConversationSummary } from '@shared/types'
import { toNormalized } from '@/api/uld'
import { useConversationsStore } from '@/stores/conversations'
import { useUiStore } from '@/stores/ui'
import appIcon from '@/assets/icon.png'

const MODE_TABS: ReadonlyArray<{ key: ConversationMode | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'chat', label: 'Chat' },
  { key: 'cowork', label: 'Cowork' },
  { key: 'code', label: 'Code' },
  { key: 'write', label: 'Write' },
  { key: 'design', label: 'Design' },
]

/** The real app icon (same asset as the packaged exe/dock icon). */
function Logo({ size = 22 }: { size?: number }): React.JSX.Element {
  return (
    <img
      src={appIcon}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: 'block' }}
    />
  )
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(ts).toLocaleDateString()
}

function modKey(): string {
  return navigator.platform.toLowerCase().includes('mac') ? 'Cmd' : 'Ctrl'
}

interface RowProps {
  summary: ConversationSummary
  active: boolean
}

function ConversationRow({ summary, active }: RowProps): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(summary.title)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  const commitRename = (): void => {
    setRenaming(false)
    const next = title.trim()
    if (!next || next === summary.title) {
      setTitle(summary.title)
      return
    }
    useConversationsStore
      .getState()
      .rename(summary.id, next)
      .catch((e: unknown) => {
        setTitle(summary.title)
        useUiStore.getState().toast(`Rename failed: ${toNormalized(e).message}`, 'error')
      })
  }

  const doDelete = (): void => {
    setConfirmingDelete(false)
    useConversationsStore
      .getState()
      .remove(summary.id)
      .catch((e: unknown) => {
        useUiStore.getState().toast(`Delete failed: ${toNormalized(e).message}`, 'error')
      })
  }

  return (
    <li className={`conv-item${active ? ' active' : ''}`}>
      {renaming ? (
        <input
          ref={inputRef}
          className="input conv-rename-input"
          value={title}
          aria-label="Conversation title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitRename()
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              setTitle(summary.title)
              setRenaming(false)
            }
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="conv-item-main"
            onClick={() => useConversationsStore.getState().select(summary.id)}
            aria-current={active ? 'true' : undefined}
          >
            <span className="conv-item-top">
              <span className="conv-title">{summary.title}</span>
              <span className="conv-time">{relativeTime(summary.updatedAt)}</span>
            </span>
            {summary.snippet ? <span className="conv-snippet">{summary.snippet}</span> : null}
          </button>
          {confirmingDelete ? (
            <span className="conv-confirm" role="alert">
              <span className="conv-confirm-label">Delete?</span>
              <button type="button" className="btn btn-danger conv-confirm-btn" onClick={doDelete}>
                Yes
              </button>
              <button
                type="button"
                className="btn btn-ghost conv-confirm-btn"
                onClick={() => setConfirmingDelete(false)}
              >
                No
              </button>
            </span>
          ) : (
            <span className="conv-actions">
              <button
                type="button"
                className="btn-icon"
                aria-label={`Rename conversation ${summary.title}`}
                title="Rename"
                onClick={() => {
                  setTitle(summary.title)
                  setRenaming(true)
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M11.3 1.7a1.7 1.7 0 0 1 2.4 2.4l-8.2 8.2-3.2.8.8-3.2 8.2-8.2Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="btn-icon"
                aria-label={`Delete conversation ${summary.title}`}
                title="Delete"
                onClick={() => setConfirmingDelete(true)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.5 6.8v4M9.5 6.8v4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </span>
          )}
        </>
      )}
    </li>
  )
}

export default function Sidebar(): React.JSX.Element {
  const summaries = useConversationsStore((s) => s.summaries)
  const activeId = useConversationsStore((s) => s.activeId)
  const modeFilter = useConversationsStore((s) => s.modeFilter)
  const loaded = useConversationsStore((s) => s.loaded)
  const [query, setQuery] = useState(useConversationsStore.getState().search)

  // Debounced search -> store + reload.
  useEffect(() => {
    const timer = setTimeout(() => {
      const store = useConversationsStore.getState()
      if (store.search !== query) {
        store.setSearch(query)
        void store.load()
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)

  // Close the new-conversation menu on outside click / Escape.
  useEffect(() => {
    if (!newMenuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setNewMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [newMenuOpen])

  const newConversation = (mode: ConversationMode): void => {
    setNewMenuOpen(false)
    useConversationsStore
      .getState()
      .create(mode)
      .catch((e: unknown) => {
        useUiStore
          .getState()
          .toast(`Could not create conversation: ${toNormalized(e).message}`, 'error')
      })
  }

  const searching = query.trim().length > 0

  return (
    <nav className="sidebar" aria-label="Conversations">
      <div className="sidebar-brand">
        <Logo />
        <span className="sidebar-wordmark">Grasberg Desktop</span>
      </div>

      <div className="sidebar-controls">
        <div className="sidebar-new-split" ref={newMenuRef}>
          <button
            type="button"
            className="btn btn-primary sidebar-new"
            title={`New chat (${modKey()}+N)`}
            onClick={() => newConversation('chat')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            New chat
          </button>
          <button
            type="button"
            className="btn btn-primary sidebar-new-caret"
            aria-label="New conversation options"
            aria-haspopup="menu"
            aria-expanded={newMenuOpen}
            onClick={() => setNewMenuOpen(!newMenuOpen)}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 6l5 5 5-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {newMenuOpen ? (
            <div className="sidebar-new-menu" role="menu" aria-label="New conversation">
              <button
                type="button"
                role="menuitem"
                className="sidebar-new-item"
                onClick={() => newConversation('chat')}
              >
                New chat
                <span className="kbd">{modKey()}+N</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="sidebar-new-item"
                onClick={() => newConversation('cowork')}
              >
                New cowork workspace
              </button>
              <button
                type="button"
                role="menuitem"
                className="sidebar-new-item"
                onClick={() => newConversation('code')}
              >
                New code session
              </button>
              <button
                type="button"
                role="menuitem"
                className="sidebar-new-item"
                onClick={() => newConversation('write')}
              >
                New document (Write)
              </button>
              <button
                type="button"
                role="menuitem"
                className="sidebar-new-item"
                onClick={() => newConversation('design')}
              >
                New design
              </button>
            </div>
          ) : null}
        </div>
        <input
          type="search"
          className="input sidebar-search"
          placeholder="Search conversations…"
          aria-label="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="mode-tabs" role="tablist" aria-label="Filter by mode">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={modeFilter === tab.key}
              className={`mode-tab${modeFilter === tab.key ? ' active' : ''}`}
              onClick={() => useConversationsStore.getState().setModeFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="conv-list">
        {summaries.map((s) => (
          <ConversationRow key={s.id} summary={s} active={s.id === activeId} />
        ))}
        {loaded && summaries.length === 0 ? (
          <li className="conv-empty">
            {searching ? (
              <>No conversations match “{query.trim()}”.</>
            ) : (
              <>No conversations yet. Start one with “New chat”.</>
            )}
          </li>
        ) : null}
      </ul>

      <div className="sidebar-footer">
        <button
          type="button"
          className="btn-icon"
          aria-label="Open workflows"
          title="Workflows"
          onClick={() => useUiStore.getState().openWorkflows(true)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="2.5" width="4.5" height="3.2" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <rect x="10" y="2.5" width="4.5" height="3.2" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <rect x="5.75" y="10.3" width="4.5" height="3.2" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M3.75 5.7v2.1h8.5V5.7M8 7.8v2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label="Open settings"
          title={`Settings (${modKey()}+,)`}
          onClick={() => useUiStore.getState().openSettings(true)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M8 1.2l1 1.7a5.7 5.7 0 0 1 1.6.66l1.9-.5.9 1.56-1.35 1.4a5.7 5.7 0 0 1 0 1.86l1.35 1.4-.9 1.56-1.9-.5a5.7 5.7 0 0 1-1.6.66l-1 1.7h-1.8l-1-1.7a5.7 5.7 0 0 1-1.6-.66l-1.9.5-.9-1.56 1.35-1.4a5.7 5.7 0 0 1 0-1.86L1.6 4.62l.9-1.56 1.9.5A5.7 5.7 0 0 1 6 2.9l1-1.7Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className="sidebar-hint">
          <span className="kbd">{modKey()}</span>
          <span className="kbd">K</span> commands
        </span>
      </div>
    </nav>
  )
}
