import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalBehavior } from '@/hooks/useModalBehavior'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'
import ModelPickList, { modelPickKey } from './ModelPickList'

/** Shared selection UI for configuration forms; nulls preserve inheritance. */
export default function ModelField({ providerId, modelId, onChange, onlyProviderId, label = 'Model', defaultLabel, allowDefault = true, purpose = 'chat' }: {
  providerId: string | null; modelId: string | null
  onChange: (providerId: string | null, modelId: string | null) => void
  onlyProviderId?: string; label?: string; defaultLabel?: string; allowDefault?: boolean
  purpose?: 'chat' | 'image'
}) {
  const [open, setOpen] = useState(false)
  const ref = useModalBehavior(open, () => setOpen(false))
  const titleId = useId()
  const settings = useSettingsStore(s => s.settings)
  const providers = useProvidersStore(s => s.providers)
  const inheritedProvider = providers.find(p => p.id === (providerId ?? settings?.defaultProviderId))
  const inheritedModel = providerId ? inheritedProvider?.defaultModelId : settings?.defaultModelId || inheritedProvider?.defaultModelId
  const inherited = defaultLabel ?? `${inheritedProvider?.label ?? 'Default provider'} · ${inheritedModel || 'automatic model'}`
  return <div className="model-field">
    <span className="field-label">{label}</span>
    <button type="button" className="btn model-field-trigger" onClick={() => setOpen(true)}>{modelId ? `${providers.find(p => p.id === providerId)?.label ?? ''} · ${modelId}` : allowDefault ? `Use default — ${inherited}` : 'Choose a model…'} <span aria-hidden>▾</span></button>
    {open && createPortal(<div className="modal-backdrop" style={{ zIndex: 900 }} onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false) }}>
      <div ref={ref} className="modal model-field-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="settings-header"><h2 id={titleId}>Choose model</h2><button type="button" className="btn-icon" aria-label="Close model picker" onClick={() => setOpen(false)}>×</button></header>
        {allowDefault && <button type="button" className="btn btn-ghost" onClick={() => { onChange(onlyProviderId ?? null, null); setOpen(false) }}>Use default — {inherited}</button>}
        <div className="model-field-list"><ModelPickList purpose={purpose} onlyProviderId={onlyProviderId} selectedKey={modelPickKey(providerId, modelId)} onPick={(p, m) => { onChange(p, m); setOpen(false) }} /></div>
      </div>
    </div>, document.body)}
  </div>
}
