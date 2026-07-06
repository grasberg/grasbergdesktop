import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ChatParams, ConversationMode, ModeModelDefault } from '@shared/types'
import { usePersistSettings } from '@/hooks/usePersistSettings'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'

const CUSTOM = '__custom__'

const MODE_LABELS: ReadonlyArray<{ mode: ConversationMode; label: string }> = [
  { mode: 'chat', label: 'Chat' },
  { mode: 'cowork', label: 'Cowork' },
  { mode: 'code', label: 'Code' },
  { mode: 'write', label: 'Write' },
  { mode: 'design', label: 'Design' },
]

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** One mode's provider + model picker for the per-mode defaults section. */
function ModeModelRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: ModeModelDefault
  onChange: (next: ModeModelDefault) => void
}): React.JSX.Element {
  const providers = useProvidersStore((s) => s.providers)
  const modelsByProvider = useProvidersStore((s) => s.modelsByProvider)
  const loadModels = useProvidersStore((s) => s.loadModels)

  const [customMode, setCustomMode] = useState(false)
  const [customDraft, setCustomDraft] = useState(value.modelId ?? '')

  const provider = providers.find((p) => p.id === value.providerId) ?? null
  const enabledProviders = providers.filter((p) => p.enabled)
  const models = provider ? modelsByProvider[provider.id] ?? [] : []
  const inList = models.some((m) => m.id === value.modelId)
  const showCustom =
    !!provider && (customMode || models.length === 0 || (!!value.modelId && !inList))

  useEffect(() => setCustomDraft(value.modelId ?? ''), [value.modelId])

  // Fetch models for the picked provider (cached in the store).
  useEffect(() => {
    if (!provider || modelsByProvider[provider.id]) return
    void loadModels(provider.id).catch(() => {
      // Best-effort; the custom model input still works.
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id])

  const onProviderChange = (id: string): void => {
    setCustomMode(false)
    onChange(id ? { providerId: id, modelId: null } : { providerId: null, modelId: null })
  }

  const onModelSelect = (v: string): void => {
    if (v === CUSTOM) {
      setCustomMode(true)
      setCustomDraft(value.modelId ?? '')
      return
    }
    setCustomMode(false)
    onChange({ providerId: value.providerId, modelId: v || null })
  }

  const commitCustom = (): void =>
    onChange({ providerId: value.providerId, modelId: customDraft.trim() || null })

  return (
    <div className="mode-model-row">
      <span className="mode-model-label">{label}</span>
      <select
        className="select"
        aria-label={`${label} provider`}
        value={value.providerId ?? ''}
        onChange={(e) => onProviderChange(e.target.value)}
      >
        <option value="">Use default</option>
        {enabledProviders.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        {provider && !provider.enabled ? (
          <option value={provider.id}>{provider.label} (disabled)</option>
        ) : null}
      </select>
      {provider ? (
        showCustom ? (
          <input
            className="input mono"
            aria-label={`${label} custom model id`}
            value={customDraft}
            placeholder="model id"
            spellCheck={false}
            onChange={(e) => setCustomDraft(e.target.value)}
            onBlur={commitCustom}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitCustom()
              }
            }}
          />
        ) : (
          <select
            className="select"
            aria-label={`${label} model`}
            value={value.modelId ?? ''}
            onChange={(e) => onModelSelect(e.target.value)}
          >
            <option value="">
              Provider default{provider.defaultModelId ? ` (${provider.defaultModelId})` : ''}
            </option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
            <option value={CUSTOM}>Custom model id…</option>
          </select>
        )
      ) : (
        <span className="field-hint mode-model-hint">Uses the default above.</span>
      )}
    </div>
  )
}

export default function DefaultsTab() {
  const settings = useSettingsStore((s) => s.settings)
  const providers = useProvidersStore((s) => s.providers)
  const modelsByProvider = useProvidersStore((s) => s.modelsByProvider)
  const loadModels = useProvidersStore((s) => s.loadModels)
  const persist = usePersistSettings()

  const providerId = settings?.defaultProviderId ?? ''
  const provider = providers.find((p) => p.id === providerId) ?? null

  const [customMode, setCustomMode] = useState(false)
  const [customDraft, setCustomDraft] = useState('')
  const [prompt, setPrompt] = useState('')
  const [temp, setTemp] = useState('')
  const [topP, setTopP] = useState('')
  const [maxTok, setMaxTok] = useState('')

  const promptValue = settings?.defaultSystemPrompt ?? ''
  const tempValue = settings?.defaultParams.temperature
  const topPValue = settings?.defaultParams.topP
  const maxTokValue = settings?.defaultParams.maxTokens

  // Sync each local draft from its persisted value (per-field deps so an
  // update to one field never clobbers in-progress edits of another).
  useEffect(() => setPrompt(promptValue), [promptValue])
  useEffect(() => setTemp(tempValue != null ? String(tempValue) : ''), [tempValue])
  useEffect(() => setTopP(topPValue != null ? String(topPValue) : ''), [topPValue])
  useEffect(() => setMaxTok(maxTokValue != null ? String(maxTokValue) : ''), [maxTokValue])

  const modelIdValue = settings?.defaultModelId ?? ''
  useEffect(() => setCustomDraft(modelIdValue), [modelIdValue])

  // Fetch models for the selected default provider (cached in the store).
  useEffect(() => {
    if (!provider) return
    if (modelsByProvider[provider.id]) return
    void loadModels(provider.id).catch(() => {
      // Model listing is best-effort; the custom model input still works.
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id])

  if (!settings) {
    return <p className="field-hint">Loading settings…</p>
  }

  const enabledProviders = providers.filter((p) => p.enabled)
  const selectedDisabled = provider && !provider.enabled
  const models = provider ? modelsByProvider[provider.id] ?? [] : []
  const inList = models.some((m) => m.id === settings.defaultModelId)
  const showCustom = customMode || (!!settings.defaultModelId && !inList) || models.length === 0

  async function onProviderChange(id: string) {
    const p = providers.find((x) => x.id === id)
    setCustomMode(false)
    await persist({
      defaultProviderId: id || null,
      defaultModelId: p ? p.defaultModelId || null : null,
    })
  }

  function onModelSelect(v: string) {
    if (v === CUSTOM) {
      setCustomMode(true)
      setCustomDraft(settings?.defaultModelId ?? '')
      return
    }
    setCustomMode(false)
    void persist({ defaultModelId: v || null })
  }

  function commitCustomModel() {
    void persist({ defaultModelId: customDraft.trim() || null })
  }

  function buildParams(): ChatParams {
    // Preserve keys this tab does not edit (frequency/presence penalties).
    const out: ChatParams = { ...settings!.defaultParams }
    const t = parseFloat(temp)
    if (temp.trim() !== '' && Number.isFinite(t)) out.temperature = clamp(t, 0, 2)
    else delete out.temperature
    const p = parseFloat(topP)
    if (topP.trim() !== '' && Number.isFinite(p)) out.topP = clamp(p, 0, 1)
    else delete out.topP
    const m = Math.floor(Number(maxTok))
    if (maxTok.trim() !== '' && Number.isFinite(m) && m > 0) out.maxTokens = m
    else delete out.maxTokens
    return out
  }

  function commitParams() {
    void persist({ defaultParams: buildParams() })
  }

  const commitOnEnter = (commit: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  }

  return (
    <section aria-label="Defaults">
      <header className="tab-header">
        <div>
          <h3>Defaults</h3>
          <p className="field-hint">Used for new conversations. Each conversation can override these.</p>
        </div>
      </header>

      <div className="settings-field">
        <label className="field-label" htmlFor="def-provider">
          Default provider
        </label>
        <select
          id="def-provider"
          className="select"
          value={providerId}
          onChange={(e) => void onProviderChange(e.target.value)}
        >
          <option value="">None selected</option>
          {enabledProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {selectedDisabled ? (
            <option value={provider.id}>{provider.label} (disabled)</option>
          ) : null}
        </select>
      </div>

      <div className="settings-field">
        <label className="field-label" htmlFor="def-model">
          Default model
        </label>
        {models.length > 0 ? (
          <select
            id="def-model"
            className="select"
            value={showCustom ? CUSTOM : settings.defaultModelId ?? ''}
            onChange={(e) => onModelSelect(e.target.value)}
            disabled={!provider}
          >
            <option value="">Provider default{provider?.defaultModelId ? ` (${provider.defaultModelId})` : ''}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
            <option value={CUSTOM}>Custom model id…</option>
          </select>
        ) : null}
        {showCustom ? (
          <input
            id={models.length > 0 ? 'def-model-custom' : 'def-model'}
            className="input mono"
            value={customDraft}
            onChange={(e) => setCustomDraft(e.target.value)}
            onBlur={commitCustomModel}
            onKeyDown={commitOnEnter(commitCustomModel)}
            placeholder="Type any model id"
            disabled={!provider}
            spellCheck={false}
            aria-label="Custom model id"
          />
        ) : null}
        {!provider ? <span className="field-hint">Pick a provider first.</span> : null}
      </div>

      <h4 className="section-subhead">Model per mode</h4>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings.perModeModelsEnabled}
          onChange={(e) => void persist({ perModeModelsEnabled: e.target.checked })}
        />
        <span>
          Use a different model for each mode
          <span className="field-hint">
            Off: every mode uses the default provider/model above. On: a new conversation in each
            mode starts with the model you pick below — modes left as “Use default” fall back to the
            default above. You can still change any conversation’s model afterwards.
          </span>
        </span>
      </label>
      {settings.perModeModelsEnabled ? (
        <div className="mode-model-list">
          {MODE_LABELS.map(({ mode, label }) => (
            <ModeModelRow
              key={mode}
              label={label}
              value={settings.modeModels[mode]}
              onChange={(next) =>
                void persist({ modeModels: { ...settings.modeModels, [mode]: next } })
              }
            />
          ))}
        </div>
      ) : null}

      <div className="settings-field">
        <label className="field-label" htmlFor="def-system-prompt">
          Default system prompt
        </label>
        <textarea
          id="def-system-prompt"
          className="textarea"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => void persist({ defaultSystemPrompt: prompt })}
          placeholder="You are a helpful assistant…"
        />
      </div>

      <h4 className="section-subhead">Sampling parameters</h4>
      <p className="field-hint">Leave a field blank to use the provider's default.</p>

      <div className="param-row">
        <label className="field-label" htmlFor="def-temp-num">
          Temperature <span className="field-hint-inline">0–2</span>
        </label>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={temp === '' ? 1 : Number(temp)}
          onChange={(e) => setTemp(e.target.value)}
          onPointerUp={commitParams}
          onKeyUp={commitParams}
          aria-label="Temperature slider"
        />
        <input
          id="def-temp-num"
          className="input param-num"
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={temp}
          placeholder="default"
          onChange={(e) => setTemp(e.target.value)}
          onBlur={commitParams}
          onKeyDown={commitOnEnter(commitParams)}
        />
      </div>

      <div className="param-row">
        <label className="field-label" htmlFor="def-topp-num">
          Top P <span className="field-hint-inline">0–1</span>
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={topP === '' ? 1 : Number(topP)}
          onChange={(e) => setTopP(e.target.value)}
          onPointerUp={commitParams}
          onKeyUp={commitParams}
          aria-label="Top P slider"
        />
        <input
          id="def-topp-num"
          className="input param-num"
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={topP}
          placeholder="default"
          onChange={(e) => setTopP(e.target.value)}
          onBlur={commitParams}
          onKeyDown={commitOnEnter(commitParams)}
        />
      </div>

      <div className="param-row">
        <label className="field-label" htmlFor="def-maxtok">
          Max tokens
        </label>
        <span className="param-spacer" aria-hidden="true" />
        <input
          id="def-maxtok"
          className="input param-num wide"
          type="number"
          min={1}
          step={1}
          value={maxTok}
          placeholder="provider default"
          onChange={(e) => setMaxTok(e.target.value)}
          onBlur={commitParams}
          onKeyDown={commitOnEnter(commitParams)}
        />
      </div>

      <div className="param-row">
        <label className="field-label" htmlFor="def-reasoning">
          Reasoning effort
        </label>
        <span className="param-spacer" aria-hidden="true" />
        <select
          id="def-reasoning"
          className="select param-num wide"
          value={settings.defaultParams.reasoningEffort ?? ''}
          onChange={(e) => {
            const params: ChatParams = { ...settings.defaultParams }
            const v = e.target.value
            if (v === 'low' || v === 'medium' || v === 'high') params.reasoningEffort = v
            else delete params.reasoningEffort
            void persist({ defaultParams: params })
          }}
        >
          <option value="">Provider default</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      <p className="field-hint">
        How much thinking reasoning-capable models spend before answering. Sent as
        reasoning_effort (OpenAI-style), an extended-thinking budget (Anthropic) or a thinking
        budget (Gemini); models without reasoning ignore it.
      </p>

      <h4 className="section-subhead">Long conversations</h4>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings.compactionEnabled}
          onChange={(e) => void persist({ compactionEnabled: e.target.checked })}
        />
        <span>
          Automatically condense long conversations
          <span className="field-hint">
            When a chat nears the model&apos;s context limit, older messages are summarized so the
            conversation can continue. The summary is kept and shown above the chat.
          </span>
        </span>
      </label>
    </section>
  )
}
