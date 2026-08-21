import { Fragment, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useConversationsStore } from '@/stores/conversations'
import { useWorkflowsStore } from '@/stores/workflows'
import { errorMessage } from '@/api/uld'
import './settings/settings.css'

interface PaletteItem {
  id: string
  section: 'Actions' | 'Scheduled' | 'Conversations'
  label: string
  hint?: string
  run: () => void
}

/** Case-insensitive subsequence match ("dpsk" matches "DeepSeek"). */
function fuzzyMatch(query: string, text: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const t = text.toLowerCase()
  let i = 0
  for (const ch of t) {
    if (ch === q[i]) i++
    if (i === q.length) return true
  }
  return false
}

const MAX_CONVERSATIONS = 30

export default function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen)
  const openPalette = useUiStore((s) => s.openPalette)
  const openSettings = useUiStore((s) => s.openSettings)
  const openShortcuts = useUiStore((s) => s.openShortcuts)
  const openWorkflows = useUiStore((s) => s.openWorkflows)
  const resolvedTheme = useUiStore((s) => s.resolvedTheme)
  const toast = useUiStore((s) => s.toast)
  const updateSettings = useSettingsStore((s) => s.update)
  const setView = useUiStore((s) => s.setView)
  const summaries = useConversationsStore((s) => s.summaries)
  const convLoaded = useConversationsStore((s) => s.loaded)
  const activeId = useConversationsStore((s) => s.activeId)
  const loadConversations = useConversationsStore((s) => s.load)
  const selectConversation = useConversationsStore((s) => s.select)
  const createConversation = useConversationsStore((s) => s.create)
  const scheduled = useWorkflowsStore((s) => s.scheduled)

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      if (!convLoaded) void loadConversations()
      // Getting-started checklist: remember that the palette has been used.
      const settings = useSettingsStore.getState().settings
      if (settings && !settings.paletteEverOpened) {
        void updateSettings({ paletteEverOpened: true }).catch(() => undefined)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return []
    const close = () => openPalette(false)
    const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark'
    const catchToast = (e: unknown) => toast(errorMessage(e), 'error')

    const actions: PaletteItem[] = [
      {
        id: 'act-home',
        section: 'Actions',
        label: 'Go to Home',
        hint: 'Overview of scheduled tasks, recent work and projects',
        run: () => {
          close()
          setView('home')
        },
      },
      {
        id: 'act-new-chat',
        section: 'Actions',
        label: 'New chat',
        run: () => {
          close()
          void createConversation('chat').catch(catchToast)
        },
      },
      {
        id: 'act-new-work',
        section: 'Actions',
        label: 'New work task',
        hint: 'Files, code, designs and task lists',
        run: () => {
          close()
          useConversationsStore.getState().setModeFilter('work')
          void createConversation('work').catch(catchToast)
        },
      },
      {
        id: 'act-settings',
        section: 'Actions',
        label: 'Open settings',
        run: () => {
          close()
          openSettings(true)
        },
      },
      {
        id: 'act-theme',
        section: 'Actions',
        label: `Toggle theme (switch to ${nextTheme})`,
        run: () => {
          close()
          void updateSettings({ theme: nextTheme }).catch(catchToast)
        },
      },
      {
        id: 'act-workflows',
        section: 'Actions',
        label: 'Open workflows',
        run: () => {
          close()
          openWorkflows(true)
        },
      },
      {
        id: 'act-shortcuts',
        section: 'Actions',
        label: 'Keyboard shortcuts',
        run: () => {
          close()
          openShortcuts(true)
        },
      },
      {
        id: 'act-onboarding',
        section: 'Actions',
        label: 'Start onboarding again',
        run: () => {
          close()
          openSettings(false)
          void updateSettings({ onboardingCompleted: false }).catch(catchToast)
        },
      },
      {
        id: 'act-discover',
        section: 'Actions',
        label: 'What can Grasberg do?',
        hint: 'Re-show the Getting started checklist and feature tips on Home',
        run: () => {
          close()
          void updateSettings({ gettingStartedDismissedAt: null, dismissedTipIds: [] }).catch(
            catchToast
          )
          setView('home')
        },
      },
    ]

    if (activeId) {
      const exportConversation = (format: 'markdown' | 'json'): void => {
        close()
        void window.uld.conversations
          .export({ conversationId: activeId, format })
          .then((res) => {
            if (!res.ok) {
              toast(res.error.message, 'error')
            } else if (!res.data.canceled) {
              toast('Conversation exported.', 'success')
            }
          })
          .catch(catchToast)
      }
      actions.push(
        {
          id: 'act-export-md',
          section: 'Actions',
          label: 'Export conversation as Markdown',
          run: () => exportConversation('markdown'),
        },
        {
          id: 'act-export-json',
          section: 'Actions',
          label: 'Export conversation as JSON',
          run: () => exportConversation('json'),
        }
      )
    }

    const scheduledItems: PaletteItem[] = scheduled
      .filter((entry) => fuzzyMatch(query, entry.workflow.name))
      .map((entry) => ({
        id: `sched-${entry.workflow.id}`,
        section: 'Scheduled' as const,
        label: entry.workflow.name,
        hint: entry.workflow.scheduleEnabled ? 'Open in the workflow builder' : 'Paused',
        run: () => {
          close()
          openWorkflows(true, entry.workflow.id)
        },
      }))

    const conversations: PaletteItem[] = [...summaries]
      .filter((c) => fuzzyMatch(query, c.title))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS)
      .map((c) => ({
        id: `conv-${c.id}`,
        section: 'Conversations' as const,
        label: c.title,
        hint: c.snippet ?? undefined,
        run: () => {
          close()
          selectConversation(c.id)
        },
      }))

    return [...actions.filter((a) => fuzzyMatch(query, a.label)), ...scheduledItems, ...conversations]
  }, [
    open,
    query,
    summaries,
    scheduled,
    activeId,
    resolvedTheme,
    openPalette,
    openSettings,
    openShortcuts,
    openWorkflows,
    setView,
    updateSettings,
    createConversation,
    selectConversation,
    toast,
  ])

  // Keep the highlighted row valid and visible as the result set changes.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)))
  }, [items.length])
  useEffect(() => {
    document.getElementById(`palette-opt-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (items.length === 0 ? 0 : (a + 1) % items.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (items.length === 0 ? 0 : (a - 1 + items.length) % items.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[active]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      openPalette(false)
    }
  }

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) openPalette(false)
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          className="palette-input"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Type a command or search conversations…"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[active] ? `palette-opt-${active}` : undefined}
          aria-autocomplete="list"
          spellCheck={false}
        />
        <ul className="palette-list" id="palette-list" role="listbox">
          {items.length === 0 ? <li className="palette-empty">No matches</li> : null}
          {items.map((item, i) => {
            const showHeader = i === 0 || items[i - 1]!.section !== item.section
            return (
              <Fragment key={item.id}>
                {showHeader ? (
                  <li className="palette-section" role="presentation">
                    {item.section}
                  </li>
                ) : null}
                <li
                  id={`palette-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => item.run()}
                >
                  <span className="palette-item-label">{item.label}</span>
                  {item.hint ? <span className="palette-item-hint">{item.hint}</span> : null}
                </li>
              </Fragment>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
