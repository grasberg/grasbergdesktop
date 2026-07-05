import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { AuthMode, ProviderConfig, ProviderType } from '@shared/types'
import { isAllowedBaseUrl } from '@shared/schemas'
import { CHATGPT_OAUTH_DEFAULT_MODEL } from '@shared/catalog'
import { presetMeta, presetMetaList } from '@shared/presets'
import { errorMessage } from '@/api/uld'
import { useProvidersStore } from '@/stores/providers'
import { useUiStore } from '@/stores/ui'

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
  }

  // Prefill the initial family once the type list has loaded.
  useEffect(() => {
    if (types.length > 0 && label === '' && presetId === null) applyFamily(type)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types])

  async function submit(e: FormEvent) {
    e.preventDefault()
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
      const created = await create({
        type,
        label: label.trim(),
        baseUrl: baseUrl.trim() || undefined,
        defaultModelId: defaultModelId.trim() || undefined,
        authMode,
        presetId: presetId ?? undefined,
      })
      if (isOauth) {
        toast(`${created.label} added — click "Sign in with ChatGPT" to connect`, 'success')
        props.onCreated?.(created)
        return
      }
      const key = apiKey.trim()
      setApiKey('')
      if (key) {
        try {
          await setKey(created.id, key)
        } catch (keyError) {
          toast(`Provider added, but saving the API key failed: ${errorMessage(keyError)}`, 'error')
        }
      }
      toast(`${created.label} added`, 'success')
      props.onCreated?.(created)
    } catch (createError) {
      setFormError(errorMessage(createError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="provider-form card" onSubmit={submit}>
      <div className="settings-field">
        <label className="field-label" htmlFor="prov-add-type">
          Provider
        </label>
        <select
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
            className="select"
            value={authMode}
            onChange={(e) => {
              const mode = e.target.value as AuthMode
              setAuthMode(mode)
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
              notice. You&apos;ll sign in from the provider row after adding it.
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
        <input
          id="prov-add-model"
          className="input mono"
          value={defaultModelId}
          onChange={(e) => setDefaultModelId(e.target.value)}
          placeholder="model id"
          spellCheck={false}
        />
      </div>

      {isOauth ? (
        <p className="field-hint">
          No API key needed — after adding this provider, open it and choose{' '}
          <strong>Sign in with ChatGPT</strong> to connect your subscription.
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

      {formError ? (
        <p className="form-error" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? <span className="spinner" aria-hidden="true" /> : null}
          {props.submitLabel ?? 'Add provider'}
        </button>
        {props.onCancel ? (
          <button type="button" className="btn btn-ghost" onClick={props.onCancel} disabled={saving}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}
