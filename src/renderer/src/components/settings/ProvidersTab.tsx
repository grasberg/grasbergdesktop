import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ProviderConfig } from '@shared/types'
import { presetMeta } from '@shared/presets'
import { errorMessage } from '@/api/uld'
import { ConfirmButton, Switch, TestResult } from '@/components/common/controls'
import { useTestConnection } from '@/hooks/useTestConnection'
import { useProvidersStore } from '@/stores/providers'
import { useUiStore } from '@/stores/ui'
import { ProviderAddForm, validateBaseUrl } from './ProviderAddForm'
import LocalServerCard from './LocalServerCard'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import ModelField from '@/components/chat/ModelField'

function ProviderRow({ provider }: { provider: ProviderConfig }) {
  const types = useProvidersStore((s) => s.types)
  const update = useProvidersStore((s) => s.update)
  const remove = useProvidersStore((s) => s.remove)
  const setKey = useProvidersStore((s) => s.setKey)
  const deleteKey = useProvidersStore((s) => s.deleteKey)
  const oauthStart = useProvidersStore((s) => s.oauthStart)
  const oauthLogout = useProvidersStore((s) => s.oauthLogout)
  const toast = useUiStore((s) => s.toast)

  const meta = types.find((t) => t.type === provider.type)
  const isOauth = provider.authMode === 'chatgpt_oauth'
  const [oauthBusy, setOauthBusy] = useState(false)

  const [expanded, setExpanded] = useState(false)
  const { testing, result: testResult, run: runTest } = useTestConnection(provider.id)

  const [label, setLabel] = useState(provider.label)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [modelId, setModelId] = useState(provider.defaultModelId)
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const [newKey, setNewKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const edits = useUnsavedChanges(expanded && (label !== provider.label || baseUrl !== provider.baseUrl || modelId !== provider.defaultModelId || newKey.length > 0), 'settings')

  function toggleExpanded() {
    if (!expanded) {
      setLabel(provider.label)
      setBaseUrl(provider.baseUrl)
      setModelId(provider.defaultModelId)
      setNewKey('')
      setEditError(null)
    }
    if (expanded) edits.discard(() => setExpanded(false))
    else setExpanded(true)
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

  async function signIn() {
    setOauthBusy(true)
    try {
      const status = await oauthStart(provider.id)
      toast(
        status.connected
          ? `Signed in to ChatGPT${status.accountLabel ? ` as ${status.accountLabel}` : ''}`
          : 'Sign-in did not complete',
        status.connected ? 'success' : 'error'
      )
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setOauthBusy(false)
    }
  }

  async function signOut() {
    try {
      await oauthLogout(provider.id)
      toast('Signed out of ChatGPT', 'info')
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
            <span className="badge">
              {provider.presetId
                ? `${presetMeta(provider.presetId)?.name ?? provider.presetId} · preset`
                : meta?.label ?? provider.type}
            </span>
            {isOauth ? (
              provider.oauthConnected ? (
                <span className="badge" title="Signed in with ChatGPT">
                  {provider.oauthAccountLabel ? `ChatGPT · ${provider.oauthAccountLabel}` : 'ChatGPT signed in'}
                </span>
              ) : (
                <span className="badge badge-warning">Not signed in</span>
              )
            ) : provider.hasKey ? (
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
              <ModelField label="Default model" providerId={provider.id} onlyProviderId={provider.id} modelId={modelId || null} onChange={(_, id) => setModelId(id ?? '')} />
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

          {isOauth ? (
            <div className="provider-key-section">
              <h4 className="section-subhead">ChatGPT sign-in (experimental)</h4>
              <p className="field-hint">
                {provider.oauthConnected
                  ? `Signed in${provider.oauthAccountLabel ? ` as ${provider.oauthAccountLabel}` : ''}. Requests use your ChatGPT subscription via an unofficial login that may stop working without notice.`
                  : 'Not signed in. This opens your browser to authorize with ChatGPT; tokens are encrypted and stored on this device only.'}
              </p>
              <div className="key-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void signIn()}
                  disabled={oauthBusy}
                >
                  {oauthBusy ? <span className="spinner" aria-hidden="true" /> : null}
                  {provider.oauthConnected ? 'Sign in again' : 'Sign in with ChatGPT'}
                </button>
                {provider.oauthConnected ? (
                  <ConfirmButton
                    label="Sign out"
                    className="btn btn-ghost"
                    prompt="Forget the stored ChatGPT session?"
                    confirmLabel="Sign out"
                    onConfirm={signOut}
                  />
                ) : null}
              </div>
            </div>
          ) : (
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
          )}

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
          <p className="field-hint">Connect a provider, verify a model and start chatting. Keys are encrypted on your desktop and sent to the chosen provider to authenticate requests.</p>
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
          <LocalServerCard showFallback />
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
