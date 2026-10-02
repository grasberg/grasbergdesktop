/**
 * Connector catalog (v53): one-click apps for agents — the dots plugin /
 * Muse connector equivalent, built on plain MCP servers. OAuth connectors
 * sign in through the browser right after they are added; API-key ones ask
 * for the key first. Everything lands as an ordinary MCP server row the user
 * can edit, restrict to read-only, or delete.
 */

import { useMemo, useState, type ReactElement } from 'react'
import {
  CONNECTOR_CATALOG,
  CONNECTOR_CATEGORIES,
  connectorToServerInput,
  type ConnectorTemplate,
} from '@shared/connectors'
import { unwrap } from '@/api/uld'
import { useMcpStore } from '@/stores/mcp'
import { toastError, useUiStore } from '@/stores/ui'

function ConnectorSetup({ template, onDone }: { template: ConnectorTemplate; onDone: () => void }): ReactElement {
  const fields = template.auth === 'env' ? (template.secret?.env ?? []) : template.secret ? [template.secret.label] : []
  const [values, setValues] = useState<string[]>(fields.map(() => ''))
  const [busy, setBusy] = useState(false)

  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      const input = connectorToServerInput(template, values)
      const servers = await unwrap(window.uld.mcp.create(input))
      await useMcpStore.getState().load()
      const created = [...servers].reverse().find((s) => s.name === template.name)
      if (created && template.auth === 'oauth') {
        useUiStore.getState().toast(`Sign in to ${template.name} in your browser…`)
        const runtime = await unwrap(window.uld.mcp.authorize(created.id))
        useMcpStore.getState().setRuntime(runtime)
        const state = runtime.find((r) => r.id === created.id)
        if (state?.status === 'connected') {
          useUiStore.getState().toast(`${template.name} connected — ${state.toolCount} tools.`, 'success')
        }
      } else {
        useUiStore.getState().toast(`${template.name} added.`, 'success')
      }
      onDone()
    } catch (e) {
      toastError(`Could not connect ${template.name}`, e)
    } finally {
      setBusy(false)
    }
  }

  const ready = fields.length === 0 || values.every((v) => v.trim().length > 0)
  return (
    <div className="connector-setup card">
      <strong>{template.name}</strong>
      <p className="field-hint">{template.description}</p>
      {template.note ? <p className="field-hint">{template.note}</p> : null}
      {fields.map((label, index) => (
        <input
          key={label}
          className="input"
          type="password"
          value={values[index]}
          placeholder={template.auth === 'env' ? label : (template.secret?.placeholder ?? label)}
          aria-label={label}
          onChange={(e) => setValues((prev) => prev.map((v, i) => (i === index ? e.target.value : v)))}
        />
      ))}
      <p className="field-hint">
        Starts with {template.access === 'read' ? 'read-only access' : 'read and write access'} — change it on the server row.
        {template.transport === 'stdio' ? ' Runs a local command.' : ''}
      </p>
      <div className="connector-setup-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={() => void add()}>
          {busy ? (template.auth === 'oauth' ? 'Waiting for sign-in…' : 'Adding…') : template.auth === 'oauth' ? 'Add & sign in' : 'Add'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function ConnectorCatalog({ onClose }: { onClose: () => void }): ReactElement {
  const servers = useMcpStore((s) => s.servers)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<ConnectorTemplate | null>(null)
  const installed = useMemo(() => new Set(servers.map((s) => s.url ?? `${s.command} ${s.args.join(' ')}`)), [servers])
  const q = query.trim().toLowerCase()
  const visible = CONNECTOR_CATALOG.filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)
  )

  if (picked) return <ConnectorSetup template={picked} onDone={() => { setPicked(null); onClose() }} />

  return (
    <div className="connector-catalog card">
      <div className="connector-catalog-head">
        <strong>Connect an app</strong>
        <input className="input" type="search" placeholder="Search apps…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {CONNECTOR_CATEGORIES.map((category) => {
        const items = visible.filter((t) => t.category === category)
        if (items.length === 0) return null
        return (
          <div key={category} className="connector-group">
            <h5>{category}</h5>
            <div className="connector-grid">
              {items.map((template) => {
                const key = template.url ?? `${template.command} ${(template.args ?? []).join(' ')}`
                const already = installed.has(key)
                return (
                  <button
                    key={template.id}
                    type="button"
                    className={`connector-tile${already ? ' installed' : ''}`}
                    disabled={already}
                    title={template.description}
                    onClick={() => setPicked(template)}
                  >
                    <span className="connector-name">{template.name}</span>
                    <span className="connector-desc">{already ? 'Connected' : template.description}</span>
                    <span className="connector-auth">
                      {template.auth === 'oauth' ? 'Sign in' : template.auth === 'none' ? 'No account' : 'API key'}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
