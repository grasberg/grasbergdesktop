import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { ProviderConfig, ProviderType, TestConnectionResult } from '@shared/types'
import { useProvidersStore } from '@/stores/providers'
import { useUiStore } from '@/stores/ui'

/**
 * Extracts a safe, human-readable message from store/IPC failures
 * (NormalizedError-shaped rejections). Never inspects anything but `message`,
 * which the main process guarantees is sanitized.
 */
export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message
    if (typeof m === 'string' && m.length > 0) return m
  }
  return 'Something went wrong'
}

function validateBaseUrl(type: ProviderType, baseUrl: string): string | null {
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    return type === 'openai-compatible'
      ? 'Base URL is required for OpenAI-compatible providers.'
      : null
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'Base URL must be a valid URL, e.g. https://api.example.com/v1'
  }
  // Mirror the main-side schema: require https, allowing http only for a
  // loopback host so keys are never sent in cleartext to a remote endpoint.
  if (url.protocol !== 'https:') {
    const host = url.hostname
    const isLocalhost =
      host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
    if (!(url.protocol === 'http:' && isLocalhost)) {
      return 'Base URL must use https:// (http:// is only allowed for localhost).'
    }
  }
  return null
}

/** Button that swaps to an inline confirm/cancel pair before running the action. */
export function ConfirmButton(props: {
  label: ReactNode
  prompt?: string
  confirmLabel?: string
  className?: string
  disabled?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!armed) {
    return (
      <button
        type="button"
        className={props.className ?? 'btn btn-danger'}
        disabled={props.disabled}
        onClick={() => setArmed(true)}
      >
        {props.label}
      </button>
    )
  }
  return (
    <span className="confirm-inline" role="group" aria-label="Confirm action">
      {props.prompt ? <span className="confirm-prompt">{props.prompt}</span> : null}
      <button
        type="button"
        className="btn btn-danger"
        autoFocus
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await props.onConfirm()
          } finally {
            setBusy(false)
            setArmed(false)
          }
        }}
      >
        {props.confirmLabel ?? 'Confirm'}
      </button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  )
}

/** Accessible toggle switch (checkbox under the hood). */
export function Switch(props: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <label className="switch" title={props.label}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.label}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </label>
  )
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

  const [type, setType] = useState<ProviderType>('deepseek')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [defaultModelId, setDefaultModelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const meta = types.find((t) => t.type === type)

  // Prefill editable fields from the type's metadata whenever the type changes.
  useEffect(() => {
    const m = types.find((t) => t.type === type)
    if (m) {
      setLabel(m.label)
      setBaseUrl(m.defaultBaseUrl)
      setDefaultModelId(m.defaultModelId)
    }
  }, [type, types])

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
      })
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
          Provider type
        </label>
        <select
          id="prov-add-type"
          className="select"
          value={type}
          onChange={(e) => setType(e.target.value as ProviderType)}
        >
          {types.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

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

      <div className="settings-field">
        <label className="field-label" htmlFor="prov-add-key">
          API key <span className="field-hint-inline">(optional — stored encrypted, never shown again)</span>
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
        {meta?.docsUrl ? (
          <span className="field-hint">
            <a href={meta.docsUrl} target="_blank" rel="noreferrer">
              Where do I get a key? ↗
            </a>
          </span>
        ) : null}
      </div>

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

function TestResult(props: { testing: boolean; result: TestConnectionResult | null }) {
  if (props.testing) {
    return (
      <span className="test-result" role="status">
        <span className="spinner" aria-hidden="true" /> Testing…
      </span>
    )
  }
  if (!props.result) return null
  if (props.result.ok) {
    const parts = ['Connected']
    if (props.result.latencyMs != null) parts.push(`${props.result.latencyMs}ms`)
    if (props.result.modelCount != null) parts.push(`${props.result.modelCount} models`)
    return (
      <span className="test-result ok" role="status">
        {parts.join(' · ')}
      </span>
    )
  }
  return (
    <span className="test-result err" role="status">
      {props.result.message}
    </span>
  )
}

function ProviderRow({ provider }: { provider: ProviderConfig }) {
  const types = useProvidersStore((s) => s.types)
  const update = useProvidersStore((s) => s.update)
  const remove = useProvidersStore((s) => s.remove)
  const setKey = useProvidersStore((s) => s.setKey)
  const deleteKey = useProvidersStore((s) => s.deleteKey)
  const test = useProvidersStore((s) => s.test)
  const toast = useUiStore((s) => s.toast)

  const meta = types.find((t) => t.type === provider.type)

  const [expanded, setExpanded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)

  const [label, setLabel] = useState(provider.label)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [modelId, setModelId] = useState(provider.defaultModelId)
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const [newKey, setNewKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  function toggleExpanded() {
    if (!expanded) {
      setLabel(provider.label)
      setBaseUrl(provider.baseUrl)
      setModelId(provider.defaultModelId)
      setNewKey('')
      setEditError(null)
    }
    setExpanded(!expanded)
  }

  async function runTest() {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await test(provider.id))
    } catch (e) {
      setTestResult({ ok: false, message: errorMessage(e) })
    } finally {
      setTesting(false)
    }
  }

  async function toggleEnabled(enabled: boolean) {
    try {
      await update(provider.id, { enabled })
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault()
    setEditError(null)
    if (!label.trim()) {
      setEditError('Name is required.')
      return
    }
    if (!baseUrl.trim()) {
      setEditError('Base URL is required.')
      return
    }
    const urlError = validateBaseUrl(provider.type, baseUrl)
    if (urlError) {
      setEditError(urlError)
      return
    }
    setSavingEdit(true)
    try {
      await update(provider.id, {
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        defaultModelId: modelId.trim(),
      })
      toast('Provider updated', 'success')
    } catch (err) {
      setEditError(errorMessage(err))
    } finally {
      setSavingEdit(false)
    }
  }

  async function saveKey() {
    const key = newKey.trim()
    if (!key) return
    setSavingKey(true)
    try {
      await setKey(provider.id, key)
      setNewKey('')
      toast('API key saved', 'success')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setSavingKey(false)
    }
  }

  async function removeKey() {
    try {
      await deleteKey(provider.id)
      toast('API key removed', 'info')
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function deleteProvider() {
    try {
      await remove(provider.id)
      toast(`${provider.label} deleted`, 'info')
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <li className="provider-row card">
      <div className="provider-row-head">
        <div className="provider-row-main">
          <div className="provider-row-title">
            <strong>{provider.label}</strong>
            <span className="badge">{meta?.label ?? provider.type}</span>
            {provider.hasKey ? (
              <span className="badge key-badge mono" title="API key configured (masked)">
                {provider.keyPreview ?? 'key set'}
              </span>
            ) : (
              <span className="badge badge-warning">No key</span>
            )}
          </div>
          <div className="provider-row-sub mono">{provider.baseUrl || 'No base URL'}</div>
          <TestResult testing={testing} result={testResult} />
        </div>
        <div className="provider-row-actions">
          <Switch
            checked={provider.enabled}
            onChange={(v) => void toggleEnabled(v)}
            label={`Enable ${provider.label}`}
          />
          <button type="button" className="btn btn-ghost" onClick={() => void runTest()} disabled={testing}>
            Test connection
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            aria-expanded={expanded}
            onClick={toggleExpanded}
          >
            {expanded ? 'Close' : 'Edit'}
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="provider-expand">
          <form className="provider-edit-grid" onSubmit={saveEdit}>
            <div className="settings-field">
              <label className="field-label" htmlFor={`prov-label-${provider.id}`}>
                Name
              </label>
              <input
                id={`prov-label-${provider.id}`}
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="settings-field">
              <label className="field-label" htmlFor={`prov-url-${provider.id}`}>
                Base URL
              </label>
              <input
                id={`prov-url-${provider.id}`}
                className="input mono"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="settings-field">
              <label className="field-label" htmlFor={`prov-model-${provider.id}`}>
                Default model
              </label>
              <input
                id={`prov-model-${provider.id}`}
                className="input mono"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                spellCheck={false}
              />
            </div>
            {editError ? (
              <p className="form-error" role="alert">
                {editError}
              </p>
            ) : null}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={savingEdit}>
                Save changes
              </button>
            </div>
          </form>

          <div className="provider-key-section">
            <h4 className="section-subhead">API key</h4>
            {provider.hasKey ? (
              <p className="field-hint">
                A key is stored for this provider{' '}
                {provider.keyPreview ? (
                  <span className="mono">({provider.keyPreview})</span>
                ) : null}
                . For security it can be replaced or removed, but never displayed.
              </p>
            ) : (
              <p className="field-hint">No API key stored. Requests to this provider will fail until one is added.</p>
            )}
            <div className="key-row">
              <input
                className="input mono"
                type="password"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder={provider.hasKey ? 'Replace key…' : 'Paste API key…'}
                aria-label={`API key for ${provider.label}`}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveKey()}
                disabled={savingKey || !newKey.trim()}
              >
                Save key
              </button>
              {provider.hasKey ? (
                <ConfirmButton
                  label="Remove key"
                  className="btn btn-ghost"
                  prompt="Remove the stored key?"
                  confirmLabel="Remove"
                  onConfirm={removeKey}
                />
              ) : null}
            </div>
            {meta?.docsUrl ? (
              <span className="field-hint">
                <a href={meta.docsUrl} target="_blank" rel="noreferrer">
                  Provider docs ↗
                </a>
              </span>
            ) : null}
          </div>

          <div className="provider-danger">
            <ConfirmButton
              label="Delete provider"
              prompt="Existing conversations keep their history, but can no longer generate replies with this provider. Delete?"
              confirmLabel="Delete"
              onConfirm={deleteProvider}
            />
          </div>
        </div>
      ) : null}
    </li>
  )
}

export default function ProvidersTab() {
  const providers = useProvidersStore((s) => s.providers)
  const loaded = useProvidersStore((s) => s.loaded)
  const load = useProvidersStore((s) => s.load)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  return (
    <section aria-label="Providers">
      <header className="tab-header">
        <div>
          <h3>Providers</h3>
          <p className="field-hint">Configure LLM endpoints and API keys. Keys are encrypted and stay on this device.</p>
        </div>
        {!adding ? (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            Add provider
          </button>
        ) : null}
      </header>

      {adding ? (
        <ProviderAddForm onCreated={() => setAdding(false)} onCancel={() => setAdding(false)} />
      ) : null}

      {providers.length === 0 && !adding ? (
        <div className="empty-state card">
          <p>No providers configured yet.</p>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            Add your first provider
          </button>
        </div>
      ) : (
        <ul className="provider-list">
          {providers.map((p) => (
            <ProviderRow key={p.id} provider={p} />
          ))}
        </ul>
      )}
    </section>
  )
}
