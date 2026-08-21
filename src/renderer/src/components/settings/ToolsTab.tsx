/**
 * Settings → Tools: per-tool enable flags and permission decisions for the
 * local tool registry, plus create/edit/delete of user-defined custom HTTP
 * tools. Tools always run locally; sensitive ones ask for approval by default.
 *
 * Custom-tool secret headers are write-only: existing values are never sent
 * back to the renderer (only names + a masked preview), and leaving a secret's
 * value blank on edit keeps the stored value unchanged.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type {
  CustomToolInfo,
  CustomToolInput,
  CustomToolPatch,
  ToolDefinition,
  ToolPermissionDecision,
  ToolRuleEffect,
} from '@shared/types'
import { toolRulePatternHint } from '@shared/tool-rules'
import { RiskBadge } from '@/components/ToolApprovalDialog'
import { ConfirmButton, Switch } from '@/components/common/controls'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { useEditorState } from '@/hooks/useEditorState'
import { effectivePermission, useToolsStore } from '@/stores/tools'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { rowsFromExisting, splitRows, SecretRowsEditor, type SecretRow } from './SecretRows'
import './tools.css'

const PERMISSION_OPTIONS: ReadonlyArray<{ value: ToolPermissionDecision; label: string }> = [
  { value: 'always_allow', label: 'Always allow' },
  { value: 'ask', label: 'Ask every time' },
  { value: 'deny', label: 'Deny' },
]

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

// ---------------------------------------------------------------------------
// Standing approval rules
// ---------------------------------------------------------------------------

const RULE_EFFECT_LABEL: Record<ToolRuleEffect, string> = {
  allow: 'Run without asking',
  require_approval: 'Always ask',
}

/**
 * Settings → Tools → Approval rules: what "Always allow" / "Allow in this
 * chat" saved, plus a form for the other direction — pinning a tool (or one
 * command prefix, host or path) to always ask, which outranks every allow.
 */
function ApprovalRulesSection(): ReactElement {
  const rules = useToolsStore((s) => s.rules)
  const tools = useToolsStore((s) => s.tools)
  const ruleCreate = useToolsStore((s) => s.ruleCreate)
  const ruleDelete = useToolsStore((s) => s.ruleDelete)
  const [effect, setEffect] = useState<ToolRuleEffect>('require_approval')
  const [toolId, setToolId] = useState('')
  const [pattern, setPattern] = useState('')

  // 'Always ask' can be pinned on anything; 'run without asking' can never
  // cover a tool whose contract is a fresh approval per call.
  const selectable = tools.filter(
    (tool) => tool.enabled && (effect === 'require_approval' || tool.noStandingApproval !== true)
  )
  const selected = toolId || selectable[0]?.id || ''
  const patternHint = toolRulePatternHint(selected)
  const toolName = (id: string): string => tools.find((t) => t.id === id)?.name ?? id

  const submit = (): void => {
    if (!selected) return
    void ruleCreate({
      toolId: selected,
      effect,
      scope: 'global',
      pattern: pattern.trim() || null,
    })
    setPattern('')
  }

  return (
    <>
      <h4 className="section-subhead">Approval rules</h4>
      <p className="field-hint">
        Standing decisions, kept until you remove them here. An <em>always ask</em> rule wins over
        everything — including a tool set to “Always allow” above — so it is the way to carve one
        risky command back out of a broad permission.
      </p>

      {rules.length === 0 ? (
        <p className="field-hint">
          No rules yet. “Always allow” in an approval dialog saves one here.
        </p>
      ) : (
        <ul className="tools-rule-list">
          {rules.map((rule) => (
            <li key={rule.id} className="tools-rule">
              <span className={`badge tools-rule-effect tools-rule-${rule.effect}`}>
                {RULE_EFFECT_LABEL[rule.effect]}
              </span>
              <span className="mono tools-rule-tool">{toolName(rule.toolId)}</span>
              {rule.pattern ? <code className="tools-rule-pattern">{rule.pattern}</code> : null}
              <span className="field-hint tools-rule-scope">
                {rule.scope === 'global' ? 'everywhere' : `this ${rule.scope} only`}
              </span>
              <button
                type="button"
                className="btn-link"
                onClick={() => void ruleDelete(rule.id)}
                aria-label={`Remove rule for ${toolName(rule.toolId)}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="tools-rule-form">
        <select
          className="select"
          value={effect}
          aria-label="Rule effect"
          onChange={(e) => setEffect(e.target.value as ToolRuleEffect)}
        >
          <option value="require_approval">Always ask about</option>
          <option value="allow">Run without asking</option>
        </select>
        <select
          className="select"
          value={selected}
          aria-label="Tool"
          onChange={(e) => setToolId(e.target.value)}
        >
          {selectable.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.name}
            </option>
          ))}
        </select>
        <input
          className="input"
          value={pattern}
          disabled={patternHint === null}
          placeholder={patternHint ?? 'Every call of this tool'}
          aria-label="Pattern"
          onChange={(e) => setPattern(e.target.value)}
        />
        <button type="button" className="btn" disabled={!selected} onClick={submit}>
          Add rule
        </button>
      </div>
    </>
  )
}

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

function ToolTable({ tools }: { tools: ToolDefinition[] }): ReactElement {
  return (
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
        {tools.map((t) => (
          <BuiltinRow key={t.id} tool={t} />
        ))}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------------------
// Shell command allowlist
// ---------------------------------------------------------------------------

/**
 * Command prefixes run_shell_command may run without the per-call approval
 * dialog (e.g. "npm test"). One prefix per line; commands with chaining
 * characters (;, &&, |, …) never match regardless.
 */
function ShellAllowlistEditor(): ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.update)
  const toast = useUiStore((s) => s.toast)
  const stored = settings?.shellCommandAllowlist ?? []
  const [text, setText] = useState(stored.join('\n'))
  const [busy, run] = useAsyncAction()

  const save = (): Promise<void> =>
    run(async () => {
      const entries = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 100)
      await updateSettings({ shellCommandAllowlist: entries })
      toast(
        entries.length > 0
          ? `${entries.length} command prefix${entries.length === 1 ? '' : 'es'} will run without asking.`
          : 'Allowlist cleared — every shell command asks again.',
        'success'
      )
    })

  return (
    <div className="field">
      <label className="field-label" htmlFor="shell-allowlist">
        Run without asking (command prefixes)
      </label>
      <textarea
        id="shell-allowlist"
        className="textarea mono"
        rows={4}
        placeholder={'npm test\ngit status\nnpx vitest run'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <span className="field-hint">
        One prefix per line. A command runs without the approval dialog when it equals a prefix or
        continues it at a word boundary ("npm test -- --watch" matches "npm test"). Commands
        containing <code>;</code>, <code>&amp;&amp;</code>, <code>|</code> or other chaining
        characters always ask.
      </span>
      <div>
        <button
          type="button"
          className="btn"
          disabled={busy || text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n') === stored.join('\n')}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save allowlist'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Custom tool form
// ---------------------------------------------------------------------------

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
  const [rows, setRows] = useState<SecretRow[]>(
    editing ? rowsFromExisting(editing.headers, editing.secretHeaders.map((s) => s.name)) : []
  )
  const [busy, run] = useAsyncAction()

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

    const {
      publicValues: headers,
      setSecrets: setSecretHeaders,
      deleteSecrets: deleteSecretHeaders,
    } = splitRows(rows, (editing?.secretHeaders ?? []).map((s) => s.name))

    await run(async () => {
      if (editing) {
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
    })
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
        <SecretRowsEditor
          rows={rows}
          setRows={setRows}
          namePlaceholder="Header-Name"
          nameAriaLabel="Header name"
          valueAriaLabel="Header value"
          removeAriaLabel="Remove header"
          addLabel="+ Add header"
        />
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
  const [, run] = useAsyncAction()
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
          onConfirm={() => run(() => customDelete(info.id))}
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
  const [, run] = useAsyncAction()

  const { formOpen, editing, openAdd, openEdit, closeForm } = useEditorState<CustomToolInfo>()

  useEffect(() => {
    // Refresh on every visit so changes from other surfaces show up.
    void load()
  }, [load])

  const toggleToolFlag = (
    key: 'shellExecutionEnabled' | 'browserToolsEnabled',
    enabled: boolean
  ): Promise<void> =>
    run(async () => {
      await updateSettings({ [key]: enabled })
      // The gated tools appear/disappear with their setting.
      await load()
    })

  const builtins = tools.filter((t) => t.builtin)
  const mcpTools = tools.filter((t) => t.source === 'mcp')

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
        <ToolTable tools={builtins} />
      )}

      <ApprovalRulesSection />

      <h4 className="section-subhead">Shell execution</h4>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings?.shellExecutionEnabled ?? false}
          onChange={(e) => void toggleToolFlag('shellExecutionEnabled', e.target.checked)}
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
      {settings?.shellExecutionEnabled ? <ShellAllowlistEditor /> : null}

      <h4 className="section-subhead">Browser &amp; computer use</h4>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings?.browserToolsEnabled ?? false}
          onChange={(e) => void toggleToolFlag('browserToolsEnabled', e.target.checked)}
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

      {formOpen ? (
        <CustomToolForm key={editing?.id ?? 'new'} editing={editing} onDone={closeForm} />
      ) : null}

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
          <ToolTable tools={mcpTools} />
        </>
      ) : null}
    </section>
  )
}
