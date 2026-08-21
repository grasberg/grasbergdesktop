import { useEffect, useState, type ReactElement } from 'react'
import type { ModelInfo, ProviderConfig } from '@shared/types'
import { useProvidersStore } from '@/stores/providers'
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

/** The check-mark key for a provider/model row (see ModelPickList). */
export function modelPickKey(providerId: string | null, modelId: string | null): string {
  return `${providerId ?? ''}::${modelId ?? ''}`
}

/**
 * The provider-grouped model list shared by the ModelSelector popover and the
 * message toolbar's "Regenerate with…" menu: cached model lists per usable
 * provider, capability badges, and a custom-model-id input per provider.
 * The parent owns the popover shell (trigger, outside-click close, arrow-key
 * navigation over the data-nav-row attributes rendered here).
 */
export default function ModelPickList({
  onPick,
  selectedKey = null,
}: {
  onPick: (providerId: string, modelId: string) => void
  /** modelPickKey() of the row to check-mark, or null for none. */
  selectedKey?: string | null
}): ReactElement {
  const providers = useProvidersStore((s) => s.providers)
  const modelsByProvider = useProvidersStore((s) => s.modelsByProvider)
  const loadModels = useProvidersStore((s) => s.loadModels)
  const [failed, setFailed] = useState<Record<string, boolean>>({})
  const [customDrafts, setCustomDrafts] = useState<Record<string, string>>({})

  const usableProviders = providers.filter(providerUsable)

  // Fetch (cached) model lists on mount — the list only renders while open.
  useEffect(() => {
    for (const p of usableProviders) {
      if (modelsByProvider[p.id]) continue
      loadModels(p.id).catch(() => {
        setFailed((prev) => ({ ...prev, [p.id]: true }))
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyCustom = (p: ProviderConfig): void => {
    const id = (customDrafts[p.id] ?? '').trim()
    if (!id) return
    onPick(p.id, id)
  }

  return (
    <>
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
              const selected = selectedKey === modelPickKey(p.id, m.id)
              return (
                <button
                  key={m.id}
                  type="button"
                  data-nav-row
                  role="option"
                  aria-selected={selected}
                  className={`ms-row${selected ? ' ms-row-selected' : ''}`}
                  onClick={() => onPick(p.id, m.id)}
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
    </>
  )
}
