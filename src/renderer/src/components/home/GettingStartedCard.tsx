/**
 * Home guidance card, two lives:
 *  1. "Getting started" checklist with live checkmarks derived from real app
 *     state — every unchecked row is a button that performs the step.
 *  2. Once the basics are done, the same slot graduates into a "Discover"
 *     card showing one feature tip at a time, prioritized by what the user
 *     demonstrably hasn't used yet. "Got it" dismisses a tip (persisted);
 *     "Hide tips" removes the card for good (both via AppSettings — no
 *     migration; the settings repo merges new fields over defaults).
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { ConversationSummary } from '@shared/types'
import { modKeyLabel } from '@/lib/platform'
import { providerUsable } from '@/lib/providers'
import { useConversationsStore } from '@/stores/conversations'
import { useProvidersStore } from '@/stores/providers'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import './home.css'

interface ChecklistItem {
  id: string
  label: string
  done: boolean
  actionLabel: string
  run: () => void
}

interface DiscoverTip {
  id: string
  title: string
  body: string
  /** Skip the tip when the user already uses the feature. */
  applicable: boolean
  actionLabel?: string
  run?: () => void
}

export default function GettingStartedCard({
  recent,
}: {
  /** HomeView's cross-mode recent conversations (null while loading). */
  recent: ConversationSummary[] | null
}): ReactElement | null {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.update)
  const providers = useProvidersStore((s) => s.providers)
  const providersLoaded = useProvidersStore((s) => s.loaded)
  const loadProviders = useProvidersStore((s) => s.load)
  const [workflowCount, setWorkflowCount] = useState<number | null>(null)

  useEffect(() => {
    if (!providersLoaded) void loadProviders()
  }, [providersLoaded, loadProviders])

  useEffect(() => {
    let cancelled = false
    void window.uld.workflows.list().then((res) => {
      if (!cancelled && res.ok) setWorkflowCount(res.data.length)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!settings || settings.gettingStartedDismissedAt !== null) return null
  if (recent === null || workflowCount === null || !providersLoaded) return null

  const hasProvider = providers.some(providerUsable)
  const hasMessage = recent.some((c) => (c.snippet ?? '').length > 0)
  const hasWorkTask = recent.some((c) => c.mode === 'work')
  const hasWorkflow = workflowCount > 0
  const openedPalette = settings.paletteEverOpened

  const hide = (): void => {
    void updateSettings({ gettingStartedDismissedAt: Date.now() })
  }

  const newConversation = (mode: 'chat' | 'work'): void => {
    if (mode === 'work') useConversationsStore.getState().setModeFilter('work')
    void useConversationsStore.getState().create(mode)
  }

  const checklist: ChecklistItem[] = [
    {
      id: 'provider',
      label: 'Add a provider (or a local model)',
      done: hasProvider,
      actionLabel: 'Open settings',
      run: () => useUiStore.getState().openSettings(true),
    },
    {
      id: 'message',
      label: 'Send your first message',
      done: hasMessage,
      actionLabel: 'New chat',
      run: () => newConversation('chat'),
    },
    {
      id: 'work',
      label: 'Try a Work task (files, code, previews)',
      done: hasWorkTask,
      actionLabel: 'New work task',
      run: () => newConversation('work'),
    },
    {
      id: 'palette',
      label: `Open the command palette (${modKeyLabel}+K)`,
      done: openedPalette,
      actionLabel: 'Open it',
      run: () => useUiStore.getState().openPalette(true),
    },
    {
      id: 'workflow',
      label: 'Build a workflow from a template',
      done: hasWorkflow,
      actionLabel: 'Open builder',
      run: () => useUiStore.getState().openWorkflows(true),
    },
  ]
  const remaining = checklist.filter((item) => !item.done)

  if (remaining.length > 0) {
    return (
      <section className="card home-card" aria-label="Getting started">
        <div className="home-card-head">
          <h2 className="home-card-title">Getting started</h2>
          <button type="button" className="btn btn-ghost home-card-action" onClick={hide}>
            Hide
          </button>
        </div>
        <ul className="home-checklist">
          {checklist.map((item) => (
            <li key={item.id} className={`home-checklist-item${item.done ? ' done' : ''}`}>
              <span className="home-checklist-mark" aria-hidden>
                {item.done ? '✓' : '○'}
              </span>
              <span className="home-checklist-label">{item.label}</span>
              {!item.done && (
                <button type="button" className="btn btn-ghost home-checklist-btn" onClick={item.run}>
                  {item.actionLabel}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    )
  }

  // Basics done — graduate into one feature tip at a time, prioritized by
  // what this user hasn't touched (state-aware, not a static tour).
  const tips: DiscoverTip[] = [
    {
      id: 'second-opinion',
      title: 'Second opinion on any answer',
      body: 'Click ▾ next to Regenerate to retry with another model — or keep both answers side by side and pick the better one.',
      applicable: true,
    },
    {
      id: 'moa',
      title: 'Mixture of Agents',
      body: 'Ask several models at once and let one synthesize the best answer. Set up a preset under Settings → Mixture of Agents.',
      applicable: (settings.moaPresets ?? []).length === 0,
      actionLabel: 'Open settings',
      run: () => useUiStore.getState().openSettings(true),
    },
    {
      id: 'dry-run',
      title: 'Test workflows safely',
      body: 'The workflow builder’s Dry run executes your graph with HTTP and notifications stubbed — see exactly what it would do, without sending anything.',
      applicable: true,
      actionLabel: 'Open builder',
      run: () => useUiStore.getState().openWorkflows(true),
    },
    {
      id: 'local-models',
      title: 'Free local models',
      body: 'Run Ollama or LM Studio and Grasberg auto-detects it — chat without an API key, with nothing leaving your machine.',
      applicable: true,
      actionLabel: 'Open settings',
      run: () => useUiStore.getState().openSettings(true),
    },
    {
      id: 'undo-turn',
      title: 'Undo a whole agent turn',
      body: 'In Work mode, every applied file change is checkpointed — one click on an assistant message reverts everything that turn did.',
      applicable: true,
    },
  ]
  const dismissed = new Set(settings.dismissedTipIds ?? [])
  const tip = tips.find((t) => t.applicable && !dismissed.has(t.id))
  if (!tip) return null

  const gotIt = (): void => {
    void updateSettings({ dismissedTipIds: [...(settings.dismissedTipIds ?? []), tip.id] })
  }

  return (
    <section className="card home-card" aria-label="Discover">
      <div className="home-card-head">
        <h2 className="home-card-title">Discover</h2>
        <button type="button" className="btn btn-ghost home-card-action" onClick={hide}>
          Hide tips
        </button>
      </div>
      <div className="home-discover">
        <strong>{tip.title}</strong>
        <p className="home-discover-body">{tip.body}</p>
        <div className="home-discover-actions">
          {tip.run && (
            <button type="button" className="btn btn-primary" onClick={tip.run}>
              {tip.actionLabel ?? 'Try it'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={gotIt}>
            Got it
          </button>
        </div>
      </div>
    </section>
  )
}
