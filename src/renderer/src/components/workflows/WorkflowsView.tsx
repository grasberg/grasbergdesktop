/**
 * Workflows builder: a React Flow canvas over the workflow engine. Add nodes
 * from the palette, connect them, edit each node's config, then Run — the graph
 * executes in the main process and each node's output is shown.
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
  Workflow,
  WorkflowGraph,
  WorkflowNodeKind,
  WorkflowRunResult,
} from '@shared/types'
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
  { kind: 'output', label: 'Output' },
]

let idSeq = 0
function nextId(): string {
  idSeq += 1
  return `n${idSeq}_${Math.floor(Math.random() * 1e6)}`
}

function toFlow(workflow: WorkflowGraph): { nodes: FlowNode[]; edges: Edge[] } {
  return {
    nodes: workflow.nodes.map((n) => ({
      id: n.id,
      position: n.position,
      data: { label: n.label, kind: n.kind, config: n.config },
      type: 'default',
    })),
    edges: workflow.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
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
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  }
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
  const [result, setResult] = useState<WorkflowRunResult | null>(null)
  const [running, setRunning] = useState(false)

  const loadList = useCallback(async () => {
    const res = await window.uld.workflows.list()
    if (res.ok) setSaved(res.data)
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

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

  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId])

  const patchSelected = (patch: Partial<NodeData> | { config: Record<string, unknown> }): void => {
    if (!selectedId) return
    setNodes((ns) =>
      ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n))
    )
  }
  const setConfig = (key: string, value: string): void => {
    if (!selected) return
    patchSelected({ config: { ...selected.data.config, [key]: value } })
  }

  const newWorkflow = (): void => {
    setWorkflowId(null)
    setName('Untitled workflow')
    setNodes([])
    setEdges([])
    setSelectedId(null)
    setResult(null)
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
      setResult(null)
    }
  }

  const save = async (): Promise<void> => {
    const input = { name: name.trim() || 'Untitled workflow', graph: toGraph(nodes, edges) }
    const res = workflowId
      ? await window.uld.workflows.update(workflowId, input)
      : await window.uld.workflows.create(input)
    if (res.ok) {
      setWorkflowId(res.data.id)
      await loadList()
      toast('Workflow saved.', 'success')
    } else {
      toast(res.error.message, 'error')
    }
  }

  const remove = async (): Promise<void> => {
    if (!workflowId) return
    const res = await window.uld.workflows.delete(workflowId)
    if (res.ok) {
      newWorkflow()
      await loadList()
    }
  }

  const run = async (): Promise<void> => {
    setRunning(true)
    setResult(null)
    try {
      const res = await window.uld.workflows.run(toGraph(nodes, edges))
      if (res.ok) setResult(res.data)
      else toast(res.error.message, 'error')
    } finally {
      setRunning(false)
    }
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
          <button type="button" className="btn btn-primary" disabled={running} onClick={() => void run()}>
            {running ? 'Running…' : 'Run'}
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
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
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
            </>
          ) : (
            <p className="field-hint">Select a node to edit it, or add one from the palette.</p>
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
