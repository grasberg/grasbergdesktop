import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { AuthMode, ModelInfo, ProviderConfig, ProviderType } from '@shared/types'
import { isAllowedBaseUrl } from '@shared/schemas'
import { CHATGPT_OAUTH_DEFAULT_MODEL } from '@shared/catalog'
import { presetMeta, presetMetaList } from '@shared/presets'
import { errorMessage } from '@/api/uld'
import { useProvidersStore } from '@/stores/providers'
import { useUiStore } from '@/stores/ui'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'

const CUSTOM = '__custom__'

export function validateBaseUrl(type: ProviderType, baseUrl: string): string | null {
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    return type === 'openai-compatible'
      ? 'Base URL is required for OpenAI-compatible providers.'
      : null
  }
  try {
    new URL(trimmed)
  } catch {
    return 'Base URL must be a valid URL, e.g. https://api.example.com/v1'
  }
  // Mirror the main-side schema: require https, allowing http only for a
  // loopback host so keys are never sent in cleartext to a remote endpoint.
  if (!isAllowedBaseUrl(trimmed)) {
    return 'Base URL must use https:// (http:// is only allowed for localhost).'
  }
  return null
}

/**
 * Add-provider form, also embedded by the onboarding wizard.
 * Creates the provider, then stores the key (if given) via providers.setKey.
 */
export function ProviderAddForm(props: {
  submitLabel?: string
  onCreated?: (provider: ProviderConfig) => void
  onCancel?: () => void
}) {
  const types = useProvidersStore((s) => s.types)
  const create = useProvidersStore((s) => s.create)
  const setKey = useProvidersStore((s) => s.setKey)
  const toast = useUiStore((s) => s.toast)

  const presets = useMemo(() => presetMetaList(), [])

  const [type, setType] = useState<ProviderType>('deepseek')
  const [presetId, setPresetId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [defaultModelId, setDefaultModelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [authMode, setAuthMode] = useState<AuthMode>('api_key')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  // Live model list fetched from the provider (null = not fetched yet).
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [customModel, setCustomModel] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [createdProvider, setCreatedProvider] = useState<ProviderConfig | null>(null)
  const [step, setStep] = useState('')
  const [edited, setEdited] = useState(false)
  const guard = useUnsavedChanges(edited || !!apiKey || !!createdProvider, 'settings')

  const familyMeta = types.find((t) => t.type === type)
  const presetEntry = presetId ? presetMeta(presetId) : undefined
  // Presets always authenticate with an API key; only families expose OAuth.
  const authModes = presetId ? (['api_key'] as AuthMode[]) : familyMeta?.authModes ?? ['api_key']
  const supportsOauth = authModes.includes('chatgpt_oauth')
  const isOauth = authMode === 'chatgpt_oauth'
  const keyLabel = presetEntry?.keyLabel ?? familyMeta?.keyLabel ?? 'API key'
  const docsUrl = presetEntry?.docsUrl ?? familyMeta?.docsUrl
  const hint = presetEntry
    ? `OpenAI-compatible preset · ${presetEntry.baseUrl}`
    : familyMeta?.hint

  /** Drops the fetched model list (call whenever the provider/credentials change). */
  function resetModels(): void {
    setModels(null)
    setCustomModel(false)
  }

  // Prefill from a selected family (its catalog metadata).
  function applyFamily(t: ProviderType): void {
    const m = types.find((x) => x.type === t)
    setPresetId(null)
    setType(t)
    if (m) {
      setLabel(m.label)
      setBaseUrl(m.defaultBaseUrl)
      setDefaultModelId(m.defaultModelId)
    }
    setAuthMode('api_key')
    resetModels()
  }

  // Prefill from a selected preset (maps onto the openai-compatible adapter).
  function applyPreset(id: string): void {
    const p = presetMeta(id)
    if (!p) return
    setPresetId(id)
    setType('openai-compatible')
    setLabel(p.name)
    setBaseUrl(p.baseUrl)
    setDefaultModelId(p.defaultModelId)
    setAuthMode('api_key')
    resetModels()
  }

  /** Fetch the provider's active models with the entered credentials. */
  async function loadModels(): Promise<void> {
    setLoadingModels(true)
    try {
      const res = createdProvider && !apiKey.trim() ? await window.uld.providers.listModels(createdProvider.id) : await window.uld.providers.previewModels({
        type,
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        presetId: presetId ?? undefined,
        authMode,
      })
      if (!res.ok) {
        toast(res.error.message, 'error')
        return
      }
      setModels(res.data)
      // Keep the current model when it's in the live list; otherwise fall back to
      // the custom text field so the user's choice isn't silently discarded.
      const inList = res.data.some((m) => m.id === defaultModelId)
      setCustomModel(res.data.length === 0 || !inList)
      if (res.data.length === 0) toast('No models returned — enter a model id manually.', 'info')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setLoadingModels(false)
    }
  }

  // Prefill the initial family once the type list has loaded.
  useEffect(() => {
    if (types.length > 0 && label === '' && presetId === null) applyFamily(type)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    setFormError(null)
    if (!label.trim()) {
      setFormError('Name is required.')
      return
    }
    const urlError = validateBaseUrl(type, baseUrl)
    if (urlError) {
      setFormError(urlError)
      return
    }
    setSaving(true)
    try {
      setStep('Saving provider…')
      const input = {
        type,
        label: label.trim(),
        baseUrl: baseUrl.trim() || undefined,
        defaultModelId: defaultModelId.trim() || undefined,
        authMode,
        presetId: presetId ?? undefined,
      }
      if (createdProvider) await useProvidersStore.getState().update(createdProvider.id, { label: input.label, baseUrl: input.baseUrl, defaultModelId: input.defaultModelId })
      const created = createdProvider ? useProvidersStore.getState().providers.find(p => p.id === createdProvider.id)! : await create(input)
      setCreatedProvider(created)
      if (isOauth) {
        if (!created.oauthConnected) {
          setStep('Complete Sign in with ChatGPT in the browser…')
          await useProvidersStore.getState().oauthStart(created.id)
        }
      }
      const key = apiKey.trim()
      if (key && !isOauth) {
          await setKey(created.id, key)
          setApiKey('')
      }
      setStep('Testing the selected model…')
      const test = await useProvidersStore.getState().test(created.id)
      if (!test.ok) throw new Error(test.message)
      guard.markSaved()
      toast(`${created.label} connected — ${test.message}`, 'success')
      props.onCreated?.(useProvidersStore.getState().providers.find(p => p.id === created.id) ?? created)
    } catch (createError) {
      setFormError(errorMessage(createError))
    } finally {
      setSaving(false)
      setStep('')
    }
  }

  return (
    <form className="provider-form card" onSubmit={submit} onChange={() => setEdited(true)}>
      <p className="field-hint">1. Choose provider · 2. Enter credentials · 3. Select and test a model. The connection test may incur a small provider charge.</p>
      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'contents' }}>
      <div className="settings-field">
        <label className="field-label" htmlFor="prov-add-type">
          Provider
        </label>
        <select
          disabled={!!createdProvider}
          id="prov-add-type"
          className="select"
          value={presetId ? `preset:${presetId}` : `family:${type}`}
          onChange={(e) => {
            const v = e.target.value
            if (v.startsWith('preset:')) applyPreset(v.slice('preset:'.length))
            else applyFamily(v.slice('family:'.length) as ProviderType)
          }}
        >
          <optgroup label="Direct integrations">
            {types.map((t) => (
              <option key={t.type} value={`family:${t.type}`}>
                {t.label}
              </option>
            ))}
          </optgroup>
          <optgroup label={`OpenAI-compatible presets (${presets.length})`}>
            {presets.map((p) => (
              <option key={p.id} value={`preset:${p.id}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        </select>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </div>

      {supportsOauth ? (
        <div className="settings-field">
          <label className="field-label" htmlFor="prov-add-auth">
            Authentication
          </label>
          <select
            id="prov-add-auth"
            disabled={!!createdProvider}
            className="select"
            value={authMode}
            onChange={(e) => {
              const mode = e.target.value as AuthMode
              setAuthMode(mode)
              resetModels()
              // ChatGPT-login uses a Codex-backend model, not the API default.
              if (mode === 'chatgpt_oauth') setDefaultModelId(CHATGPT_OAUTH_DEFAULT_MODEL)
              else if (familyMeta) setDefaultModelId(familyMeta.defaultModelId)
            }}
          >
            <option value="api_key">API key</option>
            <option value="chatgpt_oauth">Sign in with ChatGPT (experimental)</option>
          </select>
          {isOauth ? (
            <span className="field-hint">
              Uses your ChatGPT subscription via an unofficial login. It may stop working without
              notice. Connect opens the sign-in window on your desktop.
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="settings-field">
        <label className="field-label" htmlFor="prov-add-label">
          Name
        </label>
        <input
          id="prov-add-label"
          className="input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. DeepSeek"
        />
      </div>

      <div className="settings-field">
        <label className="field-label" htmlFor="prov-add-baseurl">
          Base URL{type === 'openai-compatible' ? ' (required)' : ''}
        </label>
        <input
          id="prov-add-baseurl"
          className="input mono"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
          spellCheck={false}
        />
      </div>

      <div className="settings-field">
        <label className="field-label" htmlFor="prov-add-model">
          Default model
        </label>
        {models && models.length > 0 && <input className="input" type="search" aria-label="Search available models" placeholder="Search available models…" value={modelSearch} onChange={e => setModelSearch(e.target.value)} />}
        {models && models.length > 0 ? (
          <select
            id="prov-add-model-select"
            className="select"
            aria-label="Default model"
            value={customModel || !models.some((m) => m.id === defaultModelId) ? CUSTOM : defaultModelId}
            onChange={(e) => {
              if (e.target.value === CUSTOM) {
                setCustomModel(true)
                return
              }
              setCustomModel(false)
              setDefaultModelId(e.target.value)
            }}
          >
            {models.filter(m => m.id === defaultModelId || `${m.id} ${m.label}`.toLowerCase().includes(modelSearch.toLowerCase())).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
            <option value={CUSTOM}>Custom model id…</option>
          </select>
        ) : null}
        {!models || models.length === 0 || customModel ? (
          <input
            id="prov-add-model"
            className="input mono"
            value={defaultModelId}
            onChange={(e) => setDefaultModelId(e.target.value)}
            placeholder="model id"
            spellCheck={false}
          />
        ) : null}
        <div className="provider-model-load">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void loadModels()}
            disabled={loadingModels}
          >
            {loadingModels ? <span className="spinner" aria-hidden="true" /> : null}
            {models ? 'Reload models' : 'Load models'}
          </button>
          <span className="field-hint">
            {isOauth
              ? 'Lists the models the ChatGPT backend accepts.'
              : 'Fetches the provider’s active models (enter the base URL and API key first).'}
          </span>
        </div>
      </div>

      {isOauth ? (
        <p className="field-hint">
          No API key needed. Connect opens <strong>Sign in with ChatGPT</strong> in the browser, then tests your chosen model.
        </p>
      ) : (
        <div className="settings-field">
          <label className="field-label" htmlFor="prov-add-key">
            {keyLabel}{' '}
            <span className="field-hint-inline">(optional — stored encrypted, never shown again)</span>
          </label>
          <input
            id="prov-add-key"
            className="input mono"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            autoComplete="off"
            spellCheck={false}
          />
          {docsUrl ? (
            <span className="field-hint">
              <a href={docsUrl} target="_blank" rel="noreferrer">
                Where do I get a key? ↗
              </a>
            </span>
          ) : null}
        </div>
      )}

      </fieldset>
      {step && <p role="status">{step}</p>}
      {formError ? (
        <p className="form-error" role="alert">
          {formError}{createdProvider && ' The provider is saved. Correct the credentials or model and retry; this will update the same provider.'}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? <span className="spinner" aria-hidden="true" /> : null}
          {saving ? 'Connecting…' : createdProvider ? 'Retry connection test' : props.submitLabel ?? 'Connect and test'}
        </button>
        {props.onCancel ? (
          <button type="button" className="btn btn-ghost" onClick={() => guard.discard(props.onCancel!)} disabled={saving}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}
