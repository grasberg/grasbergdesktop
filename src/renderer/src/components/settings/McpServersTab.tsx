/**
 * Settings → MCP: connect to Model Context Protocol servers (stdio or HTTP).
 * Their tools join the tool list (grouped in the Tools tab) and go through the
 * same per-tool permission + approval model. Secret env vars / headers are
 * write-only: values are encrypted in main and never shown again.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type {
  McpServerConfig,
  McpServerInput,
  McpServerPatch,
  McpTransport,
} from '@shared/types'
import { useMcpStore } from '@/stores/mcp'
import { useUiStore } from '@/stores/ui'
import { ConfirmButton, Switch, errorMessage } from './ProvidersTab'
import './settings.css'

interface Row {
  name: string
  value: string
  secret: boolean
  existing: boolean
}

function initialRows(server: McpServerConfig | null): Row[] {
  if (!server) return []
  const rows: Row[] = []
  const map = server.transport === 'stdio' ? server.env : server.headers
  for (const [name, value] of Object.entries(map)) {
    rows.push({ name, value, secret: false, existing: false })
  }
  for (const name of server.secretNames) rows.push({ name, value: '', secret: true, existing: true })
  return rows
}

function McpForm({
  editing,
  onDone,
}: {
  editing: McpServerConfig | null
  onDone: () => void
}): ReactElement {
  const create = useMcpStore((s) => s.create)
  const update = useMcpStore((s) => s.update)
  const toast = useUiStore((s) => s.toast)

  const [name, setName] = useState(editing?.name ?? '')
  const [transport, setTransport] = useState<McpTransport>(editing?.transport ?? 'stdio')
  const [command, setCommand] = useState(editing?.command ?? '')
  const [args, setArgs] = useState((editing?.args ?? []).join(' '))
  const [url, setUrl] = useState(editing?.url ?? '')
  const [rows, setRows] = useState<Row[]>(initialRows(editing))
  const [busy, setBusy] = useState(false)

  const setRow = (i: number, patch: Partial<Row>): void =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRow = (): void =>
    setRows((rs) => [...rs, { name: '', value: '', secret: false, existing: false }])
  const removeRow = (i: number): void => setRows((rs) => rs.filter((_, idx) => idx !== i))

  const submit = async (): Promise<void> => {
    const publicMap: Record<string, string> = {}
    const setSecrets: Record<string, string> = {}
    for (const r of rows) {
      const key = r.name.trim()
      if (!key) continue
      if (r.secret) {
        if (r.value.length > 0) setSecrets[key] = r.value
      } else {
        publicMap[key] = r.value
      }
    }
    setBusy(true)
    try {
      if (editing) {
        const originalSecrets = new Set(editing.secretNames)
        const keptSecrets = new Set(rows.filter((r) => r.secret).map((r) => r.name.trim()))
        const deleteSecrets = [...originalSecrets].filter((n) => !keptSecrets.has(n))
        const patch: McpServerPatch = {
          name,
          setSecrets,
          deleteSecrets,
          ...(transport === 'stdio'
            ? { command, args: args.trim() ? args.trim().split(/\s+/) : [], env: publicMap }
            : { url, headers: publicMap }),
        }
        await update(editing.id, patch)
      } else {
        const input: McpServerInput = {
          name,
          transport,
          setSecrets,
          ...(transport === 'stdio'
            ? { command, args: args.trim() ? args.trim().split(/\s+/) : [], env: publicMap }
            : { url, headers: publicMap }),
        }
        await create(input)
      }
      onDone()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card mcp-form">
      <h5>{editing ? `Edit ${editing.name}` : 'Add MCP server'}</h5>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {!editing && (
        <label className="field">
          <span className="field-label">Transport</span>
          <select
            className="select"
            value={transport}
            onChange={(e) => setTransport(e.target.value as McpTransport)}
          >
            <option value="stdio">stdio (local command)</option>
            <option value="http">HTTP (Streamable)</option>
          </select>
        </label>
      )}
      {transport === 'stdio' ? (
        <>
          <label className="field">
            <span className="field-label">Command</span>
            <input
              className="input mono"
              value={command}
              placeholder="npx"
              onChange={(e) => setCommand(e.target.value)}
            />
            <span className="field-hint">
              Runs a local process with your permissions — only add servers you trust.
            </span>
          </label>
          <label className="field">
            <span className="field-label">Arguments</span>
            <input
              className="input mono"
              value={args}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
              onChange={(e) => setArgs(e.target.value)}
            />
          </label>
        </>
      ) : (
        <label className="field">
          <span className="field-label">URL</span>
          <input
            className="input"
            value={url}
            placeholder="https://mcp.example.com"
            onChange={(e) => setUrl(e.target.value)}
          />
          <span className="field-hint">https:// only (http allowed for localhost).</span>
        </label>
      )}

      <div className="field">
        <span className="field-label">{transport === 'stdio' ? 'Environment' : 'Headers'}</span>
        {rows.map((r, i) => (
          <div className="custom-tool-header-row" key={i}>
            <input
              className="input"
              value={r.name}
              placeholder={transport === 'stdio' ? 'VAR_NAME' : 'Header-Name'}
              aria-label="Name"
              onChange={(e) => setRow(i, { name: e.target.value })}
            />
            <input
              className="input"
              type={r.secret ? 'password' : 'text'}
              value={r.value}
              placeholder={r.secret && r.existing ? '•••••• (unchanged)' : 'value'}
              aria-label="Value"
              onChange={(e) => setRow(i, { value: e.target.value })}
            />
            <label className="custom-tool-secret-toggle" title="Store this value encrypted">
              <input
                type="checkbox"
                checked={r.secret}
                onChange={(e) => setRow(i, { secret: e.target.checked })}
              />
              secret
            </label>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label="Remove row"
              onClick={() => removeRow(i)}
            >
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-ghost" onClick={addRow}>
          + Add {transport === 'stdio' ? 'variable' : 'header'}
        </button>
      </div>

      <div className="custom-tool-form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Add server'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disabled',
  error: 'Error',
}

function ServerRow({
  server,
  onEdit,
}: {
  server: McpServerConfig
  onEdit: () => void
}): ReactElement {
  const runtime = useMcpStore((s) => s.runtime[server.id])
  const setEnabled = useMcpStore((s) => s.setEnabled)
  const reconnect = useMcpStore((s) => s.reconnect)
  const remove = useMcpStore((s) => s.remove)
  const toast = useUiStore((s) => s.toast)
  const status = runtime?.status ?? (server.enabled ? 'connecting' : 'disconnected')

  return (
    <li className="mcp-item card">
      <div className="mcp-item-head">
        <div className="mcp-item-main">
          <strong>{server.name}</strong>
          <span className={`badge mcp-status mcp-status-${status}`}>
            {STATUS_LABEL[status] ?? status}
          </span>
          <span className="badge">{server.transport}</span>
          {runtime && runtime.toolCount > 0 ? (
            <span className="field-hint-inline">{runtime.toolCount} tools</span>
          ) : null}
        </div>
        <div className="mcp-item-actions">
          <Switch
            checked={server.enabled}
            onChange={(v) => void setEnabled(server.id, v)}
            label={`Enable ${server.name}`}
          />
          {server.enabled ? (
            <button type="button" className="btn btn-ghost" onClick={() => void reconnect(server.id)}>
              Reconnect
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost" onClick={onEdit}>
            Edit
          </button>
          <ConfirmButton
            label="Delete"
            prompt="Delete this server?"
            onConfirm={async () => {
              try {
                await remove(server.id)
              } catch (e) {
                toast(errorMessage(e), 'error')
              }
            }}
          />
        </div>
      </div>
      {runtime?.error ? <p className="mcp-item-error">{runtime.error}</p> : null}
      {runtime && runtime.tools.length > 0 ? (
        <p className="field-hint mcp-item-tools">
          {runtime.tools.map((t) => t.name).join(', ')}
        </p>
      ) : null}
    </li>
  )
}

export default function McpServersTab(): ReactElement {
  const servers = useMcpStore((s) => s.servers)
  const loaded = useMcpStore((s) => s.loaded)
  const load = useMcpStore((s) => s.load)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<McpServerConfig | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  return (
    <section aria-label="MCP servers">
      <header className="tab-header">
        <div>
          <h3>MCP servers</h3>
          <p className="field-hint">
            Connect to Model Context Protocol servers to give the assistant extra tools. Their tools
            appear under Tools and ask for approval by default. stdio servers run a local command —
            only add servers you trust.
          </p>
        </div>
        {!formOpen ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            + Add server
          </button>
        ) : null}
      </header>

      {formOpen ? <McpForm editing={editing} onDone={closeForm} /> : null}

      {!loaded ? (
        <p className="field-hint">Loading…</p>
      ) : servers.length === 0 && !formOpen ? (
        <div className="empty-state card">
          <p>No MCP servers configured.</p>
        </div>
      ) : (
        <ul className="mcp-list">
          {servers.map((s) => (
            <ServerRow
              key={s.id}
              server={s}
              onEdit={() => {
                setEditing(s)
                setFormOpen(true)
              }}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
