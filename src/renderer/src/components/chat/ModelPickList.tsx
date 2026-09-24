import { useEffect, useState, type ReactElement } from 'react'
import type { ModelInfo, ProviderConfig } from '@shared/types'
import { providerSupportsImageOutput, resolveImageModelCatalog } from '@shared/catalog'
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

function loadPreferences(): { favorites: string[]; recent: string[] } {
  try {
    const value = JSON.parse(localStorage.getItem('grasberg.model-preferences.v1') ?? '{}')
    return { favorites: (Array.isArray(value.favorites) ? value.favorites : []).filter((v: unknown) => typeof v === 'string'), recent: (Array.isArray(value.recent) ? value.recent : []).filter((v: unknown) => typeof v === 'string').slice(0, 20) }
  } catch { return { favorites: [], recent: [] } }
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
  onlyProviderId,
  purpose = 'chat',
}: {
  onPick: (providerId: string, modelId: string) => void
  /** modelPickKey() of the row to check-mark, or null for none. */
  selectedKey?: string | null
  onlyProviderId?: string
  purpose?: 'chat' | 'image'
}): ReactElement {
  const providers = useProvidersStore((s) => s.providers)
  const modelsByProvider = useProvidersStore((s) => s.modelsByProvider)
  const loadModels = useProvidersStore((s) => s.loadModels)
  const updated = useProvidersStore((s) => s.modelsUpdatedAt)
  const [failed, setFailed] = useState<Record<string, boolean>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [customDrafts, setCustomDrafts] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'favorites' | 'tools' | 'vision' | 'reasoning'>('all')
  const [preferences, setPreferences] = useState(loadPreferences)
  const savePreferences = (value: typeof preferences): void => {
    setPreferences(value)
    try { localStorage.setItem('grasberg.model-preferences.v1', JSON.stringify(value)) } catch { /* Still usable in memory. */ }
  }
  const pick = (providerId: string, modelId: string): void => {
    const key = modelPickKey(providerId, modelId)
    savePreferences({ ...preferences, recent: [key, ...preferences.recent.filter(k => k !== key)].slice(0, 20) })
    onPick(providerId, modelId)
  }

  const usableProviders = providers.filter(p => (onlyProviderId ? p.id === onlyProviderId : providerUsable(p)) && (purpose !== 'image' || providerSupportsImageOutput(p)))

  // Fetch (cached) model lists on mount — the list only renders while open.
  useEffect(() => {
    for (const p of usableProviders) {
      loadModels(p.id).then(() => setFailed(prev => ({ ...prev, [p.id]: false }))).catch(() => {
        setFailed((prev) => ({ ...prev, [p.id]: true }))
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyCustom = (p: ProviderConfig): void => {
    const id = (customDrafts[p.id] ?? '').trim()
    if (!id) return
    pick(p.id, id)
  }

  return (
    <>
      <div className="ms-search"><input data-autofocus type="search" className="input" aria-label="Search models" placeholder="Search model or provider…" value={search} onChange={e => setSearch(e.target.value)} />
      <div className="ms-filters">{(['all', 'favorites', 'tools', 'vision', 'reasoning'] as const).map(f => <button type="button" className="btn btn-ghost" key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'favorites' ? '★ Favorites' : f[0].toUpperCase() + f.slice(1)}</button>)}</div></div>
      {usableProviders.length > 0 && (
        <button type="button" className="btn btn-ghost" disabled={refreshing} onClick={() => {
          setRefreshing(true)
          void Promise.allSettled(usableProviders.map((p) => loadModels(p.id, true).then(() => setFailed(prev => ({ ...prev, [p.id]: false }))).catch(() => setFailed(prev => ({ ...prev, [p.id]: true })))))
            .finally(() => setRefreshing(false))
        }}>{refreshing ? 'Refreshing models…' : 'Refresh models'}</button>
      )}
      {usableProviders.length === 0 && (
        <div className="ms-empty">Connect a provider in Settings → Providers to choose a model.</div>
      )}

      {usableProviders.map((p) => {
        const models = purpose === 'image'
          ? [...new Map([...(resolveImageModelCatalog(p)?.imageModels ?? []).map(m => ({ ...m, fromCatalog: true })), ...(modelsByProvider[p.id] ?? []).filter(m => m.capabilities.imageOutput)].map(m => [m.id, m])).values()]
          : modelsByProvider[p.id]
        const visibleModels = models?.filter(m => {
          const key = modelPickKey(p.id, m.id)
          return search.toLowerCase().split(/\s+/).every(q => `${p.label} ${m.label ?? ''} ${m.id}`.toLowerCase().includes(q)) &&
            (filter === 'all' || (filter === 'favorites' ? preferences.favorites.includes(key) : m.capabilities[filter]))
        }).sort((a, b) => {
          const score = (m: ModelInfo): number => preferences.favorites.includes(modelPickKey(p.id, m.id)) ? 2 : preferences.recent.includes(modelPickKey(p.id, m.id)) ? 1 : 0
          return score(b) - score(a)
        })
        return (
          <div key={p.id} className="ms-group">
            <div className="ms-group-header">{p.label}</div>
            {models && <div className="ms-loading">{updated?.[p.id] ? `List checked ${new Date(updated[p.id]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. ` : ''}{models.some(m => m.fromCatalog) ? 'Catalog suggestions may need account access.' : 'Models reported by this provider.'}</div>}
            {failed[p.id] && models && <div role="status" className="ms-loading">Refresh failed. Showing the last available list.</div>}
            {!models && !failed[p.id] && <div className="ms-loading">Loading models…</div>}
            {failed[p.id] && !models && (
              <div className="ms-loading">Could not load models — use a custom id below.</div>
            )}
            {models && visibleModels?.length === 0 && <div className="ms-empty">No matching models. Change the search or filter.</div>}
            {visibleModels?.map((m) => {
              const selected = selectedKey === modelPickKey(p.id, m.id)
              const favorite = preferences.favorites.includes(modelPickKey(p.id, m.id))
              return (
                <div className="ms-model-choice" key={m.id}>
                <button
                  key={m.id}
                  type="button"
                  data-nav-row
                  role="option"
                  aria-selected={selected}
                  className={`ms-row${selected ? ' ms-row-selected' : ''}`}
                  onClick={() => pick(p.id, m.id)}
                >
                  <span className="ms-row-label" title={m.id}>
                    {m.label ?? m.id}
                    {m.fromCatalog && <small className="ms-source">Catalog</small>}
                    {!favorite && preferences.recent.includes(modelPickKey(p.id, m.id)) && <small className="ms-source">Recent</small>}
                  </span>
                  <CapabilityBadges model={m} />
                  {selected && (
                    <span className="ms-check" aria-hidden>
                      ✓
                    </span>
                  )}
                </button>
                <button type="button" className="btn-icon ms-favorite" aria-label={`${favorite ? 'Remove' : 'Add'} ${m.label ?? m.id} ${favorite ? 'from' : 'to'} favorites`} aria-pressed={favorite} onClick={() => {
                  const key = modelPickKey(p.id, m.id)
                  savePreferences({ ...preferences, favorites: favorite ? preferences.favorites.filter(k => k !== key) : [...preferences.favorites, key] })
                }}>{favorite ? '★' : '☆'}</button>
                </div>
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
