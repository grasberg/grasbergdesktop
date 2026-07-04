/**
 * Settings → Tools: per-tool enable flags and permission decisions for the
 * local tool registry, plus create/edit/delete of user-defined custom HTTP
 * tools. Tools always run locally; sensitive ones ask for approval by default.
 *
 * Custom-tool secret headers are write-only: existing values are never sent
 * back to the renderer (only names + a masked preview), and leaving a secret's
 * value blank on edit keeps the stored value unchanged.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type {
  CustomToolInfo,
  CustomToolInput,
  CustomToolPatch,
  ToolDefinition,
  ToolPermissionDecision,
} from '@shared/types'
import { RiskBadge } from '@/components/ToolApprovalDialog'
import { effectivePermission, useToolsStore } from '@/stores/tools'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { ConfirmButton, Switch, errorMessage } from './ProvidersTab'
import './tools.css'

const PERMISSION_OPTIONS: ReadonlyArray<{ value: ToolPermissionDecision; label: string }> = [
  { value: 'always_allow', label: 'Always allow' },
  { value: 'ask', label: 'Ask every time' },
  { value: 'deny', label: 'Deny' },
]

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

// ---------------------------------------------------------------------------
// Built-in tool table
// ---------------------------------------------------------------------------

function PermissionSelect({ tool }: { tool: ToolDefinition }): ReactElement {
  const permissions = useToolsStore((s) => s.permissions)
  const setPermission = useToolsStore((s) => s.setPermission)
  return (
    <select
      className="select tools-permission-select"
      value={effectivePermission(permissions, tool)}
      aria-label={`Permission for ${tool.name}`}
      disabled={!tool.enabled}
      onChange={(e) => void setPermission(tool.id, e.target.value as ToolPermissionDecision)}
    >
      {PERMISSION_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function BuiltinRow({ tool }: { tool: ToolDefinition }): ReactElement {
  const setEnabled = useToolsStore((s) => s.setEnabled)
  return (
    <tr className="tools-row">
      <td className="tools-cell-name mono">{tool.name}</td>
      <td className="tools-cell-desc" title={tool.description}>
        {tool.description}
      </td>
      <td className="tools-cell-risk">
        <RiskBadge risk={tool.risk} />
      </td>
      <td className="tools-cell-enabled">
        <Switch
          checked={tool.enabled}
          onChange={(v) => void setEnabled(tool.id, v)}
          label={`Enable ${tool.name}`}
        />
      </td>
      <td className="tools-cell-permission">
        <PermissionSelect tool={tool} />
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Custom tool form
// ---------------------------------------------------------------------------

interface HeaderRow {
  name: string
  value: string
  secret: boolean
  /** A secret header that already exists on the server (value blank = keep). */
  existing: boolean
}

function toRows(info: CustomToolInfo | null): HeaderRow[] {
  if (!info) return []
  const rows: HeaderRow[] = []
  for (const [name, value] of Object.entries(info.headers)) {
    rows.push({ name, value, secret: false, existing: false })
  }
  for (const s of info.secretHeaders) {
    rows.push({ name: s.name, value: '', secret: true, existing: true })
  }
  return rows
}

function CustomToolForm({
  editing,
  onDone,
}: {
  editing: CustomToolInfo | null
  onDone: () => void
}): ReactElement {
  const customCreate = useToolsStore((s) => s.customCreate)
  const customUpdate = useToolsStore((s) => s.customUpdate)
  const toast = useUiStore((s) => s.toast)

  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '')
  const [method, setMethod] = useState(editing?.method ?? 'GET')
  const [schemaText, setSchemaText] = useState(
    editing ? JSON.stringify(editing.paramsSchema, null, 2) : '{\n  "type": "object",\n  "properties": {}\n}'
  )
  const [rows, setRows] = useState<HeaderRow[]>(toRows(editing))
  const [busy, setBusy] = useState(false)

  const originalSecretNames = useMemo(
    () => new Set((editing?.secretHeaders ?? []).map((s) => s.name)),
    [editing]
  )

  const setRow = (i: number, patch: Partial<HeaderRow>): void =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRow = (): void =>
    setRows((rs) => [...rs, { name: '', value: '', secret: false, existing: false }])
  const removeRow = (i: number): void => setRows((rs) => rs.filter((_, idx) => idx !== i))

  const submit = async (): Promise<void> => {
    // Parse the arguments schema (empty -> default object schema).
    let paramsSchema: Record<string, unknown> | undefined
    const trimmedSchema = schemaText.trim()
    if (trimmedSchema.length > 0) {
      try {
        const parsed: unknown = JSON.parse(trimmedSchema)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          toast('Arguments schema must be a JSON object.', 'error')
          return
        }
        paramsSchema = parsed as Record<string, unknown>
      } catch {
        toast('Arguments schema is not valid JSON.', 'error')
        return
      }
    }

    const headers: Record<string, string> = {}
    const setSecretHeaders: Record<string, string> = {}
    for (const r of rows) {
      const key = r.name.trim()
      if (key.length === 0) continue
      if (r.secret) {
        if (r.value.length > 0) setSecretHeaders[key] = r.value
        // existing secret with a blank value -> keep as is (not sent)
      } else {
        headers[key] = r.value
      }
    }

    setBusy(true)
    try {
      if (editing) {
        const keptSecretNames = new Set(rows.filter((r) => r.secret).map((r) => r.name.trim()))
        const deleteSecretHeaders = [...originalSecretNames].filter((n) => !keptSecretNames.has(n))
        const patch: CustomToolPatch = {
          name,
          description,
          baseUrl,
          method,
          headers,
          setSecretHeaders,
          deleteSecretHeaders,
          paramsSchema,
        }
        await customUpdate(editing.id, patch)
      } else {
        const input: CustomToolInput = {
          name,
          description,
          baseUrl,
          method,
          headers,
          setSecretHeaders,
          paramsSchema,
        }
        await customCreate(input)
      }
      onDone()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card custom-tool-form">
      <h5>{editing ? `Edit ${editing.name}` : 'Add custom tool'}</h5>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          value={name}
          maxLength={64}
          placeholder="get_weather"
          onChange={(e) => setName(e.target.value)}
        />
        <span className="field-hint">Letters, digits, "_" and "-" only. Shown to the model.</span>
      </label>
      <label className="field">
        <span className="field-label">Description</span>
        <input
          className="input"
          value={description}
          placeholder="What the tool does (helps the model decide when to call it)."
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="custom-tool-url-row">
        <label className="field">
          <span className="field-label">Method</span>
          <select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="field custom-tool-url">
          <span className="field-label">Base URL</span>
          <input
            className="input"
            value={baseUrl}
            placeholder="https://api.example.com/endpoint"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <span className="field-hint">
            https:// only (http allowed for localhost). Arguments are sent as query params for
            GET/DELETE, otherwise as a JSON body.
          </span>
        </label>
      </div>

      <div className="field">
        <span className="field-label">Headers</span>
        {rows.map((r, i) => (
          <div className="custom-tool-header-row" key={i}>
            <input
              className="input"
              value={r.name}
              placeholder="Header-Name"
              aria-label="Header name"
              onChange={(e) => setRow(i, { name: e.target.value })}
            />
            <input
              className="input"
              type={r.secret ? 'password' : 'text'}
              value={r.value}
              placeholder={r.secret && r.existing ? '•••••• (unchanged)' : 'value'}
              aria-label="Header value"
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
              aria-label="Remove header"
              onClick={() => removeRow(i)}
            >
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-ghost" onClick={addRow}>
          + Add header
        </button>
        <span className="field-hint">
          Mark tokens/keys as <strong>secret</strong> — they are encrypted with your OS key store
          and never shown again.
        </span>
      </div>

      <label className="field">
        <span className="field-label">Arguments (JSON Schema)</span>
        <textarea
          className="textarea mono"
          rows={6}
          value={schemaText}
          onChange={(e) => setSchemaText(e.target.value)}
        />
        <span className="field-hint">
          OpenAI tool-parameter schema. The model fills these in when calling the tool.
        </span>
      </label>

      <div className="custom-tool-form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Add tool'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Custom tool list
// ---------------------------------------------------------------------------

function CustomToolRow({
  info,
  onEdit,
}: {
  info: CustomToolInfo
  onEdit: () => void
}): ReactElement {
  const tools = useToolsStore((s) => s.tools)
  const setEnabled = useToolsStore((s) => s.setEnabled)
  const customDelete = useToolsStore((s) => s.customDelete)
  const toast = useUiStore((s) => s.toast)
  const tool = tools.find((t) => t.id === info.id)

  return (
    <tr className="tools-row">
      <td className="tools-cell-name mono">{info.name}</td>
      <td className="tools-cell-desc" title={`${info.method} ${info.baseUrl}`}>
        <span className="mono">{info.method}</span> {info.baseUrl}
      </td>
      <td className="tools-cell-enabled">
        <Switch
          checked={tool?.enabled ?? info.enabled}
          onChange={(v) => void setEnabled(info.id, v)}
          label={`Enable ${info.name}`}
        />
      </td>
      <td className="tools-cell-permission">{tool ? <PermissionSelect tool={tool} /> : null}</td>
      <td className="tools-cell-actions">
        <button type="button" className="btn btn-ghost" onClick={onEdit}>
          Edit
        </button>
        <ConfirmButton
          label="Delete"
          prompt="Delete this tool?"
          onConfirm={async () => {
            try {
              await customDelete(info.id)
            } catch (e) {
              toast(errorMessage(e), 'error')
            }
          }}
        />
      </td>
    </tr>
  )
}

export default function ToolsTab(): ReactElement {
  const tools = useToolsStore((s) => s.tools)
  const customInfos = useToolsStore((s) => s.customInfos)
  const loaded = useToolsStore((s) => s.loaded)
  const load = useToolsStore((s) => s.load)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.update)
  const toast = useUiStore((s) => s.toast)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CustomToolInfo | null>(null)

  useEffect(() => {
    // Refresh on every visit so changes from other surfaces show up.
    void load()
  }, [load])

  const toggleShell = async (enabled: boolean): Promise<void> => {
    try {
      await updateSettings({ shellExecutionEnabled: enabled })
      // The run_shell_command tool appears/disappears with this setting.
      await load()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  const toggleBrowser = async (enabled: boolean): Promise<void> => {
    try {
      await updateSettings({ browserToolsEnabled: enabled })
      await load() // the browser/computer tools appear/disappear
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  const builtins = tools.filter((t) => t.builtin)
  const mcpTools = tools.filter((t) => t.source === 'mcp')

  const openAdd = (): void => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (info: CustomToolInfo): void => {
    setEditing(info)
    setFormOpen(true)
  }
  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  return (
    <section aria-label="Tools">
      <header className="tab-header">
        <div>
          <h3>Tools</h3>
          <p className="field-hint">
            Tools run locally on this device. Each tool has its own permission; sensitive tools ask
            for your approval by default, and nothing runs without it.
          </p>
        </div>
      </header>

      {!loaded ? (
        <p className="field-hint">Loading tools…</p>
      ) : builtins.length === 0 ? (
        <div className="empty-state card">
          <p>No built-in tools are available in this build.</p>
        </div>
      ) : (
        <table className="tools-table">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Description</th>
              <th scope="col">Risk</th>
              <th scope="col">Enabled</th>
              <th scope="col">Permission</th>
            </tr>
          </thead>
          <tbody>
            {builtins.map((t) => (
              <BuiltinRow key={t.id} tool={t} />
            ))}
          </tbody>
        </table>
      )}

      <h4 className="section-subhead">Shell execution</h4>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings?.shellExecutionEnabled ?? false}
          onChange={(e) => void toggleShell(e.target.checked)}
        />
        <span>
          Let the assistant run shell commands (with approval)
          <span className="field-hint">
            Off by default. When on, the <code>run_shell_command</code> tool can execute commands in
            a granted project folder — you still approve every call, and there is a timeout. Leave
            off to keep commands as copyable suggestions only.
          </span>
        </span>
      </label>

      <h4 className="section-subhead">Browser &amp; computer use</h4>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings?.browserToolsEnabled ?? false}
          onChange={(e) => void toggleBrowser(e.target.checked)}
        />
        <span>
          Let the assistant use an embedded browser
          <span className="field-hint">
            Off by default. When on, the <code>browser</code> and <code>computer</code> tools drive
            a sandboxed, isolated browser (http/https only, no access to your machine) — for looking
            things up and interacting with web pages. Each call asks for approval; vision models
            also receive screenshots.
          </span>
        </span>
      </label>

      <div className="custom-tools-head">
        <h4 className="section-subhead">Custom HTTP tools</h4>
        {!formOpen ? (
          <button type="button" className="btn" onClick={openAdd}>
            + Add custom tool
          </button>
        ) : null}
      </div>
      <p className="field-hint">
        Give the model your own HTTP endpoints as tools. They are sensitive by default and ask for
        approval before every call.
      </p>

      {formOpen ? <CustomToolForm editing={editing} onDone={closeForm} /> : null}

      {customInfos.length > 0 ? (
        <table className="tools-table">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Endpoint</th>
              <th scope="col">Enabled</th>
              <th scope="col">Permission</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {customInfos.map((info) => (
              <CustomToolRow key={info.id} info={info} onEdit={() => openEdit(info)} />
            ))}
          </tbody>
        </table>
      ) : !formOpen ? (
        <p className="field-hint">No custom tools yet.</p>
      ) : null}

      {mcpTools.length > 0 ? (
        <>
          <h4 className="section-subhead">MCP tools</h4>
          <p className="field-hint">
            Discovered from your connected MCP servers (managed in the MCP tab).
          </p>
          <table className="tools-table">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Description</th>
                <th scope="col">Risk</th>
                <th scope="col">Enabled</th>
                <th scope="col">Permission</th>
              </tr>
            </thead>
            <tbody>
              {mcpTools.map((t) => (
                <BuiltinRow key={t.id} tool={t} />
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  )
}
