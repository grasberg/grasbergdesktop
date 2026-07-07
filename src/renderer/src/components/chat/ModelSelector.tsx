import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { ModelInfo, ProviderConfig } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'
import { useSettingsStore } from '@/stores/settings'
import { providerUsable } from '@/lib/providers'
import './chat.css'

function formatContext(n: number | undefined): string | null {
  if (!n) return null
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  return `${Math.round(n / 1000)}k`
}

function CapabilityBadges({ model }: { model: ModelInfo }): ReactElement {
  const ctx = formatContext(model.contextLength)
  return (
    <span className="ms-badges">
      {ctx && <span className="badge ms-badge">{ctx}</span>}
      {model.capabilities.tools && <span className="badge ms-badge">tools</span>}
      {model.capabilities.vision && <span className="badge ms-badge">vision</span>}
      {model.capabilities.reasoning && <span className="badge ms-badge">reasoning</span>}
    </span>
  )
}

export default function ModelSelector(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const updateConversation = useChatStore((s) => s.updateConversation)
  const providers = useProvidersStore((s) => s.providers)
  const modelsByProvider = useProvidersStore((s) => s.modelsByProvider)
  const loadModels = useProvidersStore((s) => s.loadModels)
  const settings = useSettingsStore((s) => s.settings)

  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState<Record<string, boolean>>({})
  const [customDrafts, setCustomDrafts] = useState<Record<string, string>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const usableProviders = providers.filter(providerUsable)

  const isOverride = !!conversation && (conversation.providerId !== null || conversation.modelId !== null)
  const effectiveProviderId = conversation?.providerId ?? settings?.defaultProviderId ?? null
  const effectiveProvider = effectiveProviderId
    ? (providers.find((p) => p.id === effectiveProviderId) ?? null)
    : null
  const effectiveModelId =
    conversation?.modelId ??
    settings?.defaultModelId ??
    (effectiveProvider ? effectiveProvider.defaultModelId : null)

  const buttonLabel = effectiveProvider
    ? `${effectiveProvider.label} · ${effectiveModelId || '?'}${isOverride ? '' : ' (default)'}`
    : 'Select model'

  // Fetch (cached) model lists for usable providers when the popover opens.
  useEffect(() => {
    if (!open) return
    for (const p of usableProviders) {
      if (modelsByProvider[p.id]) continue
      loadModels(p.id).catch(() => {
        setFailed((prev) => ({ ...prev, [p.id]: true }))
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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

  const applyCustom = (p: ProviderConfig): void => {
    const id = (customDrafts[p.id] ?? '').trim()
    if (!id) return
    selectModel(p.id, id)
  }

  return (
    <div className="model-selector" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost ms-trigger"
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
        <span className="ms-trigger-label">{buttonLabel}</span>
        <span className="ms-trigger-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="ms-popover" ref={popRef} role="listbox" onKeyDown={onPopoverKeyDown}>
          <button
            type="button"
            data-nav-row
            role="option"
            aria-selected={!isOverride}
            className={`ms-row${!isOverride ? ' ms-row-selected' : ''}`}
            onClick={() => selectModel(null, null)}
          >
            <span className="ms-row-label">Use global default</span>
            {!isOverride && (
              <span className="ms-check" aria-hidden>
                ✓
              </span>
            )}
          </button>

          {usableProviders.length === 0 && (
            <div className="ms-empty">No enabled providers with an API key.</div>
          )}

          {usableProviders.map((p) => {
            const models = modelsByProvider[p.id]
            return (
              <div key={p.id} className="ms-group">
                <div className="ms-group-header">{p.label}</div>
                {!models && !failed[p.id] && <div className="ms-loading">Loading models…</div>}
                {failed[p.id] && !models && (
                  <div className="ms-loading">Could not load models — use a custom id below.</div>
                )}
                {models?.map((m) => {
                  const selected =
                    isOverride && conversation?.providerId === p.id && conversation?.modelId === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      data-nav-row
                      role="option"
                      aria-selected={selected}
                      className={`ms-row${selected ? ' ms-row-selected' : ''}`}
                      onClick={() => selectModel(p.id, m.id)}
                    >
                      <span className="ms-row-label" title={m.id}>
                        {m.label ?? m.id}
                      </span>
                      <CapabilityBadges model={m} />
                      {selected && (
                        <span className="ms-check" aria-hidden>
                          ✓
                        </span>
                      )}
                    </button>
                  )
                })}
                <div className="ms-custom">
                  <input
                    className="input ms-custom-input"
                    placeholder="Custom model id…"
                    aria-label={`Custom model id for ${p.label}`}
                    value={customDrafts[p.id] ?? ''}
                    onChange={(e) =>
                      setCustomDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        applyCustom(p)
                      }
                      // Let Escape bubble to close; stop arrow nav from stealing focus while typing.
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.stopPropagation()
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost ms-custom-apply"
                    aria-label={`Use custom model for ${p.label}`}
                    disabled={!(customDrafts[p.id] ?? '').trim()}
                    onClick={() => applyCustom(p)}
                  >
                    Apply
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
