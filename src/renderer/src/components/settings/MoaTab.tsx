import { useEffect, useState, type ReactElement } from 'react'
import type { MoaModelRef, MoaPreset, ProviderConfig } from '@shared/types'
import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'
import { providerUsable } from '@/lib/providers'

/** Providers that can actually be called (enabled + key, or connected OAuth). */
function usableProviders(providers: ProviderConfig[]): ProviderConfig[] {
  return providers.filter(providerUsable)
}

/** A never-empty model id for a provider, so a new preset is always valid. */
function defaultModelFor(provider: ProviderConfig | undefined): string {
  return provider?.defaultModelId?.trim() || 'model-id'
}

/** Provider select + model input for one advisor/aggregator reference. */
function ModelRefEditor({
  value,
  onChange,
  ariaPrefix,
}: {
  value: MoaModelRef
  onChange: (next: MoaModelRef) => void
  ariaPrefix: string
}): ReactElement {
  const providers = useProvidersStore((s) => s.providers)
  const modelsByProvider = useProvidersStore((s) => s.modelsByProvider)
  const loadModels = useProvidersStore((s) => s.loadModels)

  const enabled = usableProviders(providers)
  const provider = providers.find((p) => p.id === value.providerId)
  const models = provider ? modelsByProvider[provider.id] ?? [] : []
  const listId = `moa-models-${value.providerId}`

  const [model, setModel] = useState(value.modelId)
  useEffect(() => setModel(value.modelId), [value.modelId])

  // Best-effort model list for the datalist (the input still accepts any id).
  useEffect(() => {
    if (!provider || modelsByProvider[provider.id]) return
    void loadModels(provider.id).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id])

  const onProvider = (id: string): void => {
    const p = providers.find((x) => x.id === id)
    onChange({ providerId: id, modelId: defaultModelFor(p) })
  }

  const commitModel = (): void => {
    const next = model.trim() || defaultModelFor(provider)
    setModel(next)
    if (next !== value.modelId) onChange({ providerId: value.providerId, modelId: next })
  }

  return (
    <div className="moa-ref-row">
      <select
        className="select"
        aria-label={`${ariaPrefix} provider`}
        value={value.providerId}
        onChange={(e) => onProvider(e.target.value)}
      >
        {enabled.length === 0 && <option value={value.providerId}>No usable providers</option>}
        {enabled.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        {provider && !usableProviders(providers).some((p) => p.id === provider.id) && (
          <option value={provider.id}>{provider.label} (unavailable)</option>
        )}
      </select>
      <input
        className="input mono"
        aria-label={`${ariaPrefix} model id`}
        list={listId}
        value={model}
        placeholder="model id"
        spellCheck={false}
        onChange={(e) => setModel(e.target.value)}
        onBlur={commitModel}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitModel()
          }
        }}
      />
      {models.length > 0 && (
        <datalist id={listId}>
          {models.map((m) => (
            <option key={m.id} value={m.id} />
          ))}
        </datalist>
      )}
    </div>
  )
}

/** Optional numeric tuning field (blank = provider/conversation default). */
function TuningField({
  label,
  value,
  onCommit,
  step,
}: {
  label: string
  value: number | undefined
  onCommit: (next: number | undefined) => void
  step: number
}): ReactElement {
  const [draft, setDraft] = useState(value != null ? String(value) : '')
  useEffect(() => setDraft(value != null ? String(value) : ''), [value])
  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed === '') {
      onCommit(undefined)
      return
    }
    const n = Number(trimmed)
    onCommit(Number.isFinite(n) && n > 0 ? n : undefined)
  }
  return (
    <label className="moa-tuning">
      <span className="field-hint-inline">{label}</span>
      <input
        className="input param-num"
        type="number"
        min={0}
        step={step}
        value={draft}
        placeholder="default"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
    </label>
  )
}

function PresetCard({
  preset,
  isDefault,
  onChange,
  onDelete,
  onMakeDefault,
}: {
  preset: MoaPreset
  isDefault: boolean
  onChange: (next: MoaPreset) => void
  onDelete: () => void
  onMakeDefault: () => void
}): ReactElement {
  const [name, setName] = useState(preset.name)
  useEffect(() => setName(preset.name), [preset.name])

  const patch = (p: Partial<MoaPreset>): void => onChange({ ...preset, ...p })

  const setReference = (index: number, ref: MoaModelRef): void =>
    patch({ referenceModels: preset.referenceModels.map((r, i) => (i === index ? ref : r)) })

  const addReference = (): void =>
    patch({
      referenceModels: [
        ...preset.referenceModels,
        preset.referenceModels[preset.referenceModels.length - 1] ?? preset.aggregator,
      ],
    })

  const removeReference = (index: number): void => {
    if (preset.referenceModels.length <= 1) return
    patch({ referenceModels: preset.referenceModels.filter((_, i) => i !== index) })
  }

  return (
    <div className={`moa-card${preset.enabled ? '' : ' moa-card-disabled'}`}>
      <div className="moa-card-head">
        <input
          className="input moa-name"
          aria-label="Preset name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const next = name.trim() || 'Untitled preset'
            setName(next)
            if (next !== preset.name) patch({ name: next })
          }}
        />
        <label className="field-checkbox moa-inline">
          <input
            type="checkbox"
            checked={preset.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>
        <label className="field-checkbox moa-inline">
          <input type="radio" name="moa-default" checked={isDefault} onChange={onMakeDefault} />
          <span>Default (/moa)</span>
        </label>
        <button type="button" className="btn btn-ghost btn-danger-text" onClick={onDelete}>
          Delete
        </button>
      </div>

      <h5 className="moa-subhead">Advisor models</h5>
      <p className="field-hint">
        Each runs in parallel on the conversation and its output is shown to you and fed to the
        aggregator.
      </p>
      {preset.referenceModels.map((ref, index) => (
        <div key={index} className="moa-ref-line">
          <ModelRefEditor
            value={ref}
            ariaPrefix={`Advisor ${index + 1}`}
            onChange={(next) => setReference(index, next)}
          />
          <button
            type="button"
            className="btn-icon"
            aria-label={`Remove advisor ${index + 1}`}
            title="Remove advisor"
            disabled={preset.referenceModels.length <= 1}
            onClick={() => removeReference(index)}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost moa-add-ref"
        disabled={preset.referenceModels.length >= 8}
        onClick={addReference}
      >
        + Add advisor
      </button>

      <h5 className="moa-subhead">Aggregator</h5>
      <p className="field-hint">
        Reads every advisor output and writes the final answer. This is the acting model that also
        runs tools.
      </p>
      <ModelRefEditor
        value={preset.aggregator}
        ariaPrefix="Aggregator"
        onChange={(next) => patch({ aggregator: next })}
      />

      <h5 className="moa-subhead">Tuning (optional)</h5>
      <div className="moa-tuning-row">
        <TuningField
          label="Advisor max tokens"
          value={preset.referenceMaxTokens}
          step={1}
          onCommit={(v) => patch({ referenceMaxTokens: v })}
        />
        <TuningField
          label="Advisor temp"
          value={preset.referenceTemperature}
          step={0.1}
          onCommit={(v) => patch({ referenceTemperature: v })}
        />
        <TuningField
          label="Aggregator temp"
          value={preset.aggregatorTemperature}
          step={0.1}
          onCommit={(v) => patch({ aggregatorTemperature: v })}
        />
        <TuningField
          label="Aggregator max tokens"
          value={preset.maxTokens}
          step={1}
          onCommit={(v) => patch({ maxTokens: v })}
        />
      </div>
    </div>
  )
}

export default function MoaTab(): ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const providers = useProvidersStore((s) => s.providers)
  const persist = usePersistSettings()

  if (!settings) {
    return <p className="field-hint">Loading settings…</p>
  }

  const presets = settings.moaPresets
  const enabled = usableProviders(providers)

  const commit = (next: MoaPreset[]): void => void persist({ moaPresets: next })

  const updatePreset = (updated: MoaPreset): void =>
    commit(presets.map((p) => (p.id === updated.id ? updated : p)))

  const deletePreset = (id: string): void => {
    const next = presets.filter((p) => p.id !== id)
    void persist({
      moaPresets: next,
      ...(settings.defaultMoaPresetId === id ? { defaultMoaPresetId: null } : {}),
    })
  }

  const addPreset = (): void => {
    const provider = enabled[0]
    const seed: MoaModelRef = { providerId: provider.id, modelId: defaultModelFor(provider) }
    const second = enabled[1] ?? provider
    const preset: MoaPreset = {
      id: crypto.randomUUID(),
      name: `Preset ${presets.length + 1}`,
      referenceModels: [seed, { providerId: second.id, modelId: defaultModelFor(second) }],
      aggregator: { ...seed },
      enabled: true,
    }
    void persist({
      moaPresets: [...presets, preset],
      ...(settings.defaultMoaPresetId ? {} : { defaultMoaPresetId: preset.id }),
    })
  }

  return (
    <section aria-label="Mixture of Agents">
      <header className="tab-header">
        <div>
          <h3>Mixture of Agents</h3>
          <p className="field-hint">
            Combine several models: the <strong>advisor</strong> models answer in parallel, then an{' '}
            <strong>aggregator</strong> model synthesizes them into one reply (and runs any tools).
            Turn a preset on for a conversation with the <strong>MoA</strong> button in the composer,
            or run one message through the default preset with <code>/moa &lt;prompt&gt;</code>.
          </p>
        </div>
      </header>

      {enabled.length === 0 ? (
        <p className="field-hint">
          Add at least one enabled provider with an API key (Providers tab) to build a preset.
        </p>
      ) : (
        <>
          {presets.length === 0 && (
            <p className="field-hint">No presets yet — add one to get started.</p>
          )}
          <div className="moa-list">
            {presets.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                isDefault={settings.defaultMoaPresetId === preset.id}
                onChange={updatePreset}
                onDelete={() => deletePreset(preset.id)}
                onMakeDefault={() => void persist({ defaultMoaPresetId: preset.id })}
              />
            ))}
          </div>
          <button type="button" className="btn btn-primary" onClick={addPreset}>
            + Add preset
          </button>
        </>
      )}
    </section>
  )
}
