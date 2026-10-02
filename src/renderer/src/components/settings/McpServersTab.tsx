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
import { ConfirmButton, Switch } from '@/components/common/controls'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { useEditorState } from '@/hooks/useEditorState'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { useMcpStore } from '@/stores/mcp'
import { rowsFromExisting, SecretRowsEditor, splitRows, type SecretRow } from './SecretRows'
import ConnectorCatalog from './ConnectorCatalog'
import { unwrap } from '@/api/uld'
import { toastError } from '@/stores/ui'
import './settings.css'
import './connectors.css'

function initialRows(server: McpServerConfig | null): SecretRow[] {
  if (!server) return []
  return rowsFromExisting(
    server.transport === 'stdio' ? server.env : server.headers,
    server.secretNames
  )
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

  const [name, setName] = useState(editing?.name ?? '')
  const [transport, setTransport] = useState<McpTransport>(editing?.transport ?? 'stdio')
  const [command, setCommand] = useState(editing?.command ?? '')
  const [args, setArgs] = useState((editing?.args ?? []).join(' '))
  const [url, setUrl] = useState(editing?.url ?? '')
  const [rows, setRows] = useState<SecretRow[]>(initialRows(editing))
  const [busy, run] = useAsyncAction()
  const [baseline] = useState(() => JSON.stringify([name, transport, command, args, url, rows]))
  const guard = useUnsavedChanges(baseline !== JSON.stringify([name, transport, command, args, url, rows]), 'settings')

  const submit = async (): Promise<void> => {
    const { publicValues: publicMap, setSecrets, deleteSecrets } = splitRows(
      rows,
      editing?.secretNames ?? []
    )
    await run(async () => {
      if (editing) {
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
      guard.markSaved(); onDone()
    })
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
        <SecretRowsEditor
          rows={rows}
          setRows={setRows}
          namePlaceholder={transport === 'stdio' ? 'VAR_NAME' : 'Header-Name'}
          nameAriaLabel="Name"
          valueAriaLabel="Value"
          removeAriaLabel="Remove row"
          addLabel={`+ Add ${transport === 'stdio' ? 'variable' : 'header'}`}
        />
      </div>

      <div className="custom-tool-form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Add server'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => guard.discard(onDone)}>
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
  needs_auth: 'Sign-in needed',
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
  const [, run] = useAsyncAction()
  const status = runtime?.status ?? (server.enabled ? 'connecting' : 'disconnected')
  const [signingIn, setSigningIn] = useState(false)
  const signIn = async (): Promise<void> => {
    setSigningIn(true)
    try {
      useMcpStore.getState().setRuntime(await unwrap(window.uld.mcp.authorize(server.id)))
    } catch (e) {
      toastError(`Sign-in to ${server.name} failed`, e)
    } finally {
      setSigningIn(false)
    }
  }
  const signOut = async (): Promise<void> => {
    try {
      useMcpStore.getState().setRuntime(await unwrap(window.uld.mcp.signOut(server.id)))
    } catch (e) {
      toastError('Sign-out failed', e)
    }
  }
  const setAccess = (access: 'read' | 'write'): Promise<void> =>
    run(() => useMcpStore.getState().update(server.id, { access }))

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
          <select
            className="select"
            value={server.access}
            aria-label={`Access for ${server.name}`}
            title="Read only: offers just the tools this server marks as read-only, and trusts that mark (proactive read-only work may use them). Read and write: every tool is treated as able to change things and send data out."
            onChange={(e) => void setAccess(e.target.value as 'read' | 'write')}
          >
            <option value="read">Read only</option>
            <option value="write">Read &amp; write</option>
          </select>
          {server.transport === 'http' && status === 'needs_auth' ? (
            <button type="button" className="btn btn-primary" disabled={signingIn} onClick={() => void signIn()}>
              {signingIn ? 'Waiting for sign-in…' : 'Sign in'}
            </button>
          ) : null}
          {server.transport === 'http' && runtime?.signedIn ? (
            <button type="button" className="btn btn-ghost" onClick={() => void signOut()}>
              Sign out
            </button>
          ) : null}
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
            onConfirm={() => run(() => remove(server.id))}
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
  const { formOpen, editing, openAdd, openEdit, closeForm } = useEditorState<McpServerConfig>()
  const [catalogOpen, setCatalogOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

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
          <div className="connector-header-actions">
            <button type="button" className="btn btn-primary" onClick={() => setCatalogOpen(true)}>
              + Connect an app
            </button>
            <button type="button" className="btn" onClick={openAdd}>
              + Custom server
            </button>
          </div>
        ) : null}
      </header>

      {catalogOpen && !formOpen ? <ConnectorCatalog onClose={() => setCatalogOpen(false)} /> : null}
      {formOpen ? <McpForm key={editing?.id ?? 'new'} editing={editing} onDone={closeForm} /> : null}

      {!loaded ? (
        <p className="field-hint">Loading…</p>
      ) : servers.length === 0 && !formOpen ? (
        <div className="empty-state card">
          <p>No MCP servers configured.</p>
        </div>
      ) : (
        <ul className="mcp-list">
          {servers.map((s) => (
            <ServerRow key={s.id} server={s} onEdit={() => openEdit(s)} />
          ))}
        </ul>
      )}
    </section>
  )
}
