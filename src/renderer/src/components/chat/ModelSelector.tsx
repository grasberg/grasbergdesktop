import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'
import { useSettingsStore } from '@/stores/settings'
import { useBotsStore } from '@/stores/bots'
import { conversationModel } from '@/lib/providers'
import ModelPickList, { modelPickKey } from './ModelPickList'
import './chat.css'

export default function ModelSelector({ placement = 'header' }: { placement?: 'header' | 'composer' }): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const updateConversation = useChatStore((s) => s.updateConversation)
  const providers = useProvidersStore((s) => s.providers)
  const settings = useSettingsStore((s) => s.settings)
  const agent = useBotsStore((s) => s.roster?.bots.find((row) => row.agent.id === conversation?.agentId)?.agent)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const isOverride = !!conversation && (conversation.providerId !== null || conversation.modelId !== null)
  const { provider: effectiveProvider, modelId: effectiveModelId } =
    conversationModel(conversation, settings, providers, agent)

  const buttonLabel = effectiveProvider
    ? `${effectiveProvider.label} · ${effectiveModelId || '?'}${isOverride ? '' : ' (default)'}`
    : 'Select model'
  const compactLabel = effectiveModelId || effectiveProvider?.label || 'Select model'

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Focus the first row when opening.
  useEffect(() => {
    if (!open) return
    const first = popRef.current?.querySelector<HTMLElement>('[data-nav-row]')
    first?.focus()
  }, [open])

  const close = (refocus = true): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  const onPopoverKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      // Consume it: closing the popover must not also reach the global handler
      // (which would stop an in-flight generation).
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const pop = popRef.current
    if (!pop) return
    const rows = Array.from(pop.querySelectorAll<HTMLElement>('[data-nav-row]'))
    if (rows.length === 0) return
    e.preventDefault()
    const current = rows.indexOf(document.activeElement as HTMLElement)
    const delta = e.key === 'ArrowDown' ? 1 : -1
    const next = current === -1 ? 0 : (current + delta + rows.length) % rows.length
    rows[next]?.focus()
  }

  const selectModel = (providerId: string | null, modelId: string | null): void => {
    void updateConversation({ providerId, modelId })
    close()
  }

  return (
    <div className={`model-selector${placement === 'composer' ? ' model-selector-composer' : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-ghost ms-trigger${placement === 'composer' ? ' ms-trigger-composer' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${buttonLabel}`}
        disabled={!conversation}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="ms-trigger-label" title={buttonLabel}>
          {placement === 'composer' ? compactLabel : buttonLabel}
        </span>
        <span className="ms-trigger-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className={`ms-popover${placement === 'composer' ? ' ms-popover-composer' : ''}`} ref={popRef} role="listbox" onKeyDown={onPopoverKeyDown}>
          <button
            type="button"
            data-nav-row
            role="option"
            aria-selected={!isOverride}
            className={`ms-row${!isOverride ? ' ms-row-selected' : ''}`}
            onClick={() => selectModel(null, null)}
          >
            <span className="ms-row-label">{agent ? 'Use bot defaults' : 'Use global default'}</span>
            {!isOverride && (
              <span className="ms-check" aria-hidden>
                ✓
              </span>
            )}
          </button>

          <ModelPickList
            onPick={(providerId, modelId) => selectModel(providerId, modelId)}
            selectedKey={
              isOverride && conversation
                ? modelPickKey(conversation.providerId, conversation.modelId)
                : null
            }
          />
        </div>
      )}
    </div>
  )
}
