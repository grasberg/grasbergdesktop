/**
 * Workflows builder: a React Flow canvas over the workflow engine. Add nodes
 * from the palette, connect them, edit each node's config, then Run — the
 * workflow is saved and executed in the main process; each node's output and
 * the persisted run history are shown. Edges leaving a Condition node carry a
 * true/false branch (click the edge to flip it).
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Edge,
  type Node,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type {
  AgentProfile,
  Workflow,
  WorkflowGraph,
  WorkflowNodeKind,
  WorkflowRun,
  WorkflowRunResult,
} from '@shared/types'
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from '@shared/workflow-templates'
import { validateWorkflowGraph } from '@shared/workflow-validate'
import { Switch } from '@/components/common/controls'
import { useUiStore } from '@/stores/ui'
import './workflows.css'

interface NodeData {
  label: string
  kind: WorkflowNodeKind
  config: Record<string, unknown>
  [key: string]: unknown
}
type FlowNode = Node<NodeData>

const PALETTE: ReadonlyArray<{ kind: WorkflowNodeKind; label: string }> = [
  { kind: 'manual', label: 'Input' },
  { kind: 'template', label: 'Template' },
  { kind: 'ai_agent', label: 'AI agent' },
  { kind: 'http_request', label: 'HTTP request' },
  { kind: 'condition', label: 'Condition' },
  { kind: 'notify', label: 'Notify' },
  { kind: 'output', label: 'Output' },
]

let idSeq = 0
function nextId(): string {
  idSeq += 1
  return `n${idSeq}_${Math.floor(Math.random() * 1e6)}`
}

/** Edge label showing the branch of a condition edge. */
function branchLabel(sourceHandle: string | null | undefined): string | undefined {
  if (sourceHandle === 'false') return 'false'
  if (sourceHandle === 'true') return 'true'
  return undefined
}

function toFlow(workflow: WorkflowGraph): { nodes: FlowNode[]; edges: Edge[] } {
  return {
    nodes: workflow.nodes.map((n) => ({
      id: n.id,
      position: n.position,
      data: { label: n.label, kind: n.kind, config: n.config },
      type: 'default',
    })),
    edges: workflow.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      label: branchLabel(e.sourceHandle),
    })),
  }
}

function toGraph(nodes: FlowNode[], edges: Edge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind,
      label: n.data.label,
      position: n.position,
      config: n.data.config,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
    })),
  }
}

function formatRunTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

export default function WorkflowsView(): ReactElement {
  const openWorkflows = useUiStore((s) => s.openWorkflows)
  const toast = useUiStore((s) => s.toast)

  const [saved, setSaved] = useState<Workflow[]>([])
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  const [name, setName] = useState('Untitled workflow')
  const [nodes, setNodes] = useState<FlowNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [result, setResult] = useState<WorkflowRunResult | null>(null)
  const [running, setRunning] = useState(false)
  const [wasDryRun, setWasDryRun] = useState(false)
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [everyMinutes, setEveryMinutes] = useState('60')
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [agents, setAgents] = useState<AgentProfile[]>([])

  const loadList = useCallback(async () => {
    const res = await window.uld.workflows.list()
    if (res.ok) setSaved(res.data)
  }, [])

  const loadRuns = useCallback(async (id: string) => {
    const res = await window.uld.workflows.runs(id)
    if (res.ok) setRuns(res.data)
  }, [])

  useEffect(() => {
    void loadList()
    void window.uld.agents.list().then((res) => {
      if (res.ok) setAgents(res.data.filter((a) => a.enabled))
    })
  }, [loadList])

  // Deep link from the sidebar's "Scheduled tasks" section: open that
  // workflow, then clear the pointer (openWorkflows without an id) so
  // clicking the same row again re-triggers this effect.
  const initialWorkflowId = useUiStore((s) => s.workflowsInitialId)
  useEffect(() => {
    if (!initialWorkflowId) return
    void openWorkflow(initialWorkflowId)
    useUiStore.getState().openWorkflows(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWorkflowId])

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    []
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    []
  )
  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge({ ...c, id: nextId() }, es)),
    []
  )

  const addNode = (kind: WorkflowNodeKind, label: string): void => {
    const id = nextId()
    setNodes((ns) => [
      ...ns,
      {
        id,
        position: { x: 80 + Math.random() * 240, y: 80 + Math.random() * 240 },
        data: { label, kind, config: {} },
        type: 'default',
      },
    ])
  }

  // Pre-run sanity checks: badge offending nodes and list problems in the
  // inspector. Warnings still run; errors will fail or do nothing.
  const issues = useMemo(() => validateWorkflowGraph(toGraph(nodes, edges)), [nodes, edges])
  const errorNodeIds = useMemo(
    () => new Set(issues.filter((i) => i.level === 'error' && i.nodeId).map((i) => i.nodeId)),
    [issues]
  )
  const displayNodes = useMemo(
    () =>
      nodes.map((n) =>
        errorNodeIds.has(n.id) ? { ...n, className: 'workflows-node-invalid' } : n
      ),
    [nodes, errorNodeIds]
  )
  const labelOfNode = (id: string | null): string =>
    id ? (nodes.find((n) => n.id === id)?.data.label ?? id) : ''

  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId])
  const selectedEdge = useMemo(
    () => edges.find((e) => e.id === selectedEdgeId) ?? null,
    [edges, selectedEdgeId]
  )
  const selectedEdgeSource = useMemo(
    () => (selectedEdge ? (nodes.find((n) => n.id === selectedEdge.source) ?? null) : null),
    [selectedEdge, nodes]
  )

  const patchSelected = (patch: Partial<NodeData> | { config: Record<string, unknown> }): void => {
    if (!selectedId) return
    setNodes((ns) =>
      ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n))
    )
  }
  const setConfig = (key: string, value: string | boolean): void => {
    if (!selected) return
    patchSelected({ config: { ...selected.data.config, [key]: value } })
  }

  const setEdgeBranch = (branch: 'true' | 'false'): void => {
    if (!selectedEdgeId) return
    setEdges((es) =>
      es.map((e) =>
        e.id === selectedEdgeId ? { ...e, sourceHandle: branch, label: branch } : e
      )
    )
  }

  const newWorkflow = (): void => {
    setWorkflowId(null)
    setName('Untitled workflow')
    setNodes([])
    setEdges([])
    setSelectedId(null)
    setSelectedEdgeId(null)
    setResult(null)
    setScheduleEnabled(false)
    setEveryMinutes('60')
    setRuns([])
  }

  const openWorkflow = async (id: string): Promise<void> => {
    const res = await window.uld.workflows.get(id)
    if (res.ok && res.data) {
      const flow = toFlow(res.data.graph)
      setWorkflowId(res.data.id)
      setName(res.data.name)
      setNodes(flow.nodes)
      setEdges(flow.edges)
      setSelectedId(null)
      setSelectedEdgeId(null)
      setResult(null)
      setScheduleEnabled(res.data.scheduleEnabled)
      setEveryMinutes(String(res.data.schedule?.everyMinutes ?? 60))
      await loadRuns(res.data.id)
    }
  }

  /** Persists the workflow; returns its id (null on failure). */
  const save = async (silent = false): Promise<string | null> => {
    const minutes = Math.floor(Number(everyMinutes))
    const input = {
      name: name.trim() || 'Untitled workflow',
      graph: toGraph(nodes, edges),
      schedule: Number.isFinite(minutes) && minutes >= 1 ? { everyMinutes: minutes } : null,
      scheduleEnabled,
    }
    const res = workflowId
      ? await window.uld.workflows.update(workflowId, input)
      : await window.uld.workflows.create(input)
    if (res.ok) {
      setWorkflowId(res.data.id)
      await loadList()
      if (!silent) {
        const errorCount = issues.filter((i) => i.level === 'error').length
        if (errorCount > 0) {
          toast(
            `Saved — ${errorCount} problem${errorCount === 1 ? '' : 's'} may stop it from running (see Checks).`,
            'info'
          )
        } else {
          toast('Workflow saved.', 'success')
        }
      }
      return res.data.id
    }
    toast(res.error.message, 'error')
    return null
  }

  const remove = async (): Promise<void> => {
    if (!workflowId) return
    const res = await window.uld.workflows.delete(workflowId)
    if (res.ok) {
      newWorkflow()
      await loadList()
    }
  }

  /** Save & run: executes the saved workflow so the run lands in the history. */
  const run = async (): Promise<void> => {
    setRunning(true)
    setResult(null)
    setWasDryRun(false)
    try {
      const id = await save(true)
      if (!id) return
      const res = await window.uld.workflows.runById(id)
      if (res.ok) setResult(res.data)
      else toast(res.error.message, 'error')
      await loadRuns(id)
    } finally {
      setRunning(false)
    }
  }

  /**
   * Dry run: executes the LIVE editor graph with side effects stubbed — HTTP
   * nodes report what they would send, notifications are swallowed, AI routes
   * to the economy model. Nothing is saved and no run history is recorded.
   */
  const dryRun = async (): Promise<void> => {
    setRunning(true)
    setResult(null)
    setWasDryRun(true)
    try {
      const res = await window.uld.workflows.run(toGraph(nodes, edges), { dryRun: true })
      if (res.ok) {
        setResult(res.data)
        toast('Dry run finished — nothing was sent or delivered.', 'success')
      } else {
        toast(res.error.message, 'error')
      }
    } finally {
      setRunning(false)
    }
  }

  /** Loads a starter template into the (empty) canvas, ready to edit. */
  const applyTemplate = (template: WorkflowTemplate): void => {
    const flow = toFlow(template.graph)
    setNodes(flow.nodes)
    setEdges(flow.edges)
    if (!workflowId) setName(template.name)
    setSelectedId(null)
    setSelectedEdgeId(null)
    setResult(null)
  }

  return (
    <div className="workflows">
      <header className="workflows-header">
        <div className="workflows-header-left">
          <button type="button" className="btn-icon" aria-label="Back" onClick={() => openWorkflows(false)}>
            ←
          </button>
          <input
            className="input workflows-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Workflow name"
          />
          <select
            className="select"
            value={workflowId ?? ''}
            onChange={(e) => (e.target.value ? void openWorkflow(e.target.value) : newWorkflow())}
            aria-label="Open workflow"
          >
            <option value="">New workflow…</option>
            {saved.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.scheduleEnabled && w.schedule ? ` ⏰ ${w.schedule.everyMinutes}m` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="workflows-header-actions">
          <button type="button" className="btn" onClick={() => void save()}>
            Save
          </button>
          {workflowId ? (
            <button type="button" className="btn btn-ghost" onClick={() => void remove()}>
              Delete
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={running || nodes.length === 0}
            title="Test the workflow without side effects: HTTP requests report what they would send, notifications are swallowed, AI uses the economy model."
            onClick={() => void dryRun()}
          >
            {running && wasDryRun ? 'Dry running…' : 'Dry run'}
          </button>
          <button type="button" className="btn btn-primary" disabled={running} onClick={() => void run()}>
            {running && !wasDryRun ? 'Running…' : 'Save & run'}
          </button>
        </div>
      </header>

      <div className="workflows-body">
        <aside className="workflows-palette">
          <h4 className="section-subhead">Add node</h4>
          {PALETTE.map((p) => (
            <button
              key={p.kind}
              type="button"
              className="btn btn-ghost workflows-palette-btn"
              onClick={() => addNode(p.kind, p.label)}
            >
              + {p.label}
            </button>
          ))}
          <p className="field-hint">
            Connect nodes to pass each node&apos;s output as <code>{'{{input}}'}</code> to the next.
          </p>
        </aside>

        <div className="workflows-canvas">
          {nodes.length === 0 && (
            <div className="workflows-gallery" role="region" aria-label="Workflow templates">
              <h3 className="workflows-gallery-title">Start from a template</h3>
              <div className="workflows-gallery-grid">
                {WORKFLOW_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="card workflows-gallery-card"
                    onClick={() => applyTemplate(template)}
                  >
                    <strong>{template.name}</strong>
                    <span className="field-hint">{template.description}</span>
                  </button>
                ))}
              </div>
              <p className="field-hint">…or add nodes from the palette to start blank.</p>
            </div>
          )}
          {wasDryRun && result && (
            <div className="workflows-dryrun-badge" role="status">
              Dry run — HTTP &amp; notifications were stubbed, nothing was sent.
            </div>
          )}
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, n) => {
              setSelectedId(n.id)
              setSelectedEdgeId(null)
            }}
            onEdgeClick={(_e, edge) => {
              setSelectedEdgeId(edge.id)
              setSelectedId(null)
            }}
            onPaneClick={() => {
              setSelectedId(null)
              setSelectedEdgeId(null)
            }}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        <aside className="workflows-inspector">
          {selected ? (
            <>
              <h4 className="section-subhead">{selected.data.kind}</h4>
              <label className="field">
                <span className="field-label">Label</span>
                <input
                  className="input"
                  value={selected.data.label}
                  onChange={(e) => patchSelected({ label: e.target.value })}
                />
              </label>
              {selected.data.kind === 'manual' && (
                <label className="field">
                  <span className="field-label">Text</span>
                  <textarea
                    className="textarea"
                    rows={5}
                    value={String(selected.data.config.text ?? '')}
                    onChange={(e) => setConfig('text', e.target.value)}
                  />
                </label>
              )}
              {selected.data.kind === 'template' && (
                <label className="field">
                  <span className="field-label">Template</span>
                  <textarea
                    className="textarea mono"
                    rows={6}
                    value={String(selected.data.config.template ?? '')}
                    placeholder="Hello {{input}}"
                    onChange={(e) => setConfig('template', e.target.value)}
                  />
                </label>
              )}
              {selected.data.kind === 'ai_agent' && (
                <>
                  <label className="field">
                    <span className="field-label">Prompt</span>
                    <textarea
                      className="textarea"
                      rows={6}
                      value={String(selected.data.config.prompt ?? '')}
                      placeholder="Summarize: {{input}}"
                      onChange={(e) => setConfig('prompt', e.target.value)}
                    />
                  </label>
                  {agents.length > 0 && (
                    <label className="field">
                      <span className="field-label">Agent profile</span>
                      <select
                        className="select"
                        value={String(selected.data.config.agentId ?? '')}
                        onChange={(e) => setConfig('agentId', e.target.value)}
                      >
                        <option value="">None (plain generation)</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="field">
                    <Switch
                      checked={selected.data.config.useTools === true}
                      onChange={(v) => setConfig('useTools', v)}
                      label="Allow tools"
                    />
                    <p className="field-hint">
                      Lets the agent call enabled tools whose permission is “always allow”
                      (e.g. web search) — headless runs never show approval dialogs.
                    </p>
                  </div>
                  <div className="field">
                    <Switch
                      checked={selected.data.config.jsonOutput === true}
                      onChange={(v) => setConfig('jsonOutput', v)}
                      label="JSON output"
                    />
                    <p className="field-hint">
                      Forces valid JSON (providers with a JSON mode) — handy when the next
                      node parses the result.
                    </p>
                  </div>
                </>
              )}
              {selected.data.kind === 'condition' && (
                <label className="field">
                  <span className="field-label">Contains text</span>
                  <input
                    className="input"
                    value={String(selected.data.config.needle ?? '')}
                    placeholder="e.g. URGENT (empty = input is non-empty)"
                    onChange={(e) => setConfig('needle', e.target.value)}
                  />
                  <p className="field-hint">
                    Case-insensitive. Click an outgoing edge to set its true/false branch.
                  </p>
                </label>
              )}
              {selected.data.kind === 'notify' && (
                <p className="field-hint">
                  Delivers its input via the Telegram bridge and/or the outbound webhook
                  (Settings → Bridges), then passes it through.
                </p>
              )}
              {selected.data.kind === 'http_request' && (
                <>
                  <label className="field">
                    <span className="field-label">Method</span>
                    <select
                      className="select"
                      value={String(selected.data.config.method ?? 'GET')}
                      onChange={(e) => setConfig('method', e.target.value)}
                    >
                      {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">URL</span>
                    <input
                      className="input"
                      value={String(selected.data.config.url ?? '')}
                      placeholder="https://api.example.com/{{input}}"
                      onChange={(e) => setConfig('url', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Body</span>
                    <textarea
                      className="textarea mono"
                      rows={4}
                      value={String(selected.data.config.body ?? '')}
                      onChange={(e) => setConfig('body', e.target.value)}
                    />
                  </label>
                </>
              )}
              {result?.nodeOutputs[selected.id] !== undefined && (
                <div className="field">
                  <span className="field-label">Last output</span>
                  <pre className="workflows-output">{result.nodeOutputs[selected.id]}</pre>
                </div>
              )}
              {result?.skipped?.includes(selected.id) && (
                <p className="field-hint">Skipped in the last run (condition branch didn’t fire).</p>
              )}
            </>
          ) : selectedEdge && selectedEdgeSource?.data.kind === 'condition' ? (
            <>
              <h4 className="section-subhead">Condition branch</h4>
              <label className="field">
                <span className="field-label">This edge fires when the condition is</span>
                <select
                  className="select"
                  value={selectedEdge.sourceHandle === 'false' ? 'false' : 'true'}
                  onChange={(e) => setEdgeBranch(e.target.value === 'false' ? 'false' : 'true')}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              </label>
            </>
          ) : (
            <>
              {issues.length > 0 && (
                <>
                  <h4 className="section-subhead">Checks</h4>
                  <ul className="workflows-issues">
                    {issues.map((issue, i) => (
                      <li key={i} className={`workflows-issue workflows-issue-${issue.level}`}>
                        {issue.nodeId ? <strong>{labelOfNode(issue.nodeId)}: </strong> : null}
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h4 className="section-subhead">Schedule</h4>
              <div className="field">
                <Switch
                  checked={scheduleEnabled}
                  onChange={setScheduleEnabled}
                  label="Run on a schedule"
                />
              </div>
              <label className="field">
                <span className="field-label">Every (minutes)</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={everyMinutes}
                  disabled={!scheduleEnabled}
                  onChange={(e) => setEveryMinutes(e.target.value)}
                />
                <p className="field-hint">Save to apply. Add a Notify node to get the result.</p>
              </label>

              <h4 className="section-subhead">Run history</h4>
              {runs.length === 0 ? (
                <p className="field-hint">
                  {workflowId ? 'No runs recorded yet.' : 'Save the workflow to record runs.'}
                </p>
              ) : (
                <ul className="workflows-runs">
                  {runs.map((r) => (
                    <li key={r.id} className={`workflows-run workflows-run-${r.status}`}>
                      <div className="workflows-run-head">
                        <span>{r.status === 'ok' ? '✓' : '✗'}</span>
                        <span>{formatRunTime(r.startedAt)}</span>
                        <span className="workflows-run-trigger">{r.trigger}</span>
                      </div>
                      {r.error ? (
                        <div className="workflows-run-error">{r.error}</div>
                      ) : r.output ? (
                        <div className="workflows-run-output">{r.output.slice(0, 300)}</div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {result && !result.ok ? (
            <p className="mcp-item-error">
              {result.error}
              {result.failedNodeId ? ` (node ${result.failedNodeId})` : ''}
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
