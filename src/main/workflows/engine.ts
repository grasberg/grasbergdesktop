/**
 * Workflow execution engine: runs a node graph in topological order, feeding
 * each node the concatenated outputs of its predecessors as `{{input}}`.
 * Pure and dependency-injected (AI + fetch), so it is fully unit-testable.
 *
 * Node kinds:
 *  - manual       : emits its configured text (a starting input).
 *  - template     : interpolates {{input}} / {{<nodeId>}} into a template.
 *  - http_request : method + url (+ body), returns the response text.
 *  - ai_agent     : runs a one-shot generation over the interpolated prompt.
 *  - output       : passes its input through (the workflow's result).
 */

import type { WorkflowGraph, WorkflowNode, WorkflowRunResult } from '@shared/types'

const MAX_NODES = 100
const HTTP_TIMEOUT_MS = 15_000
const HTTP_MAX_BYTES = 256 * 1024

export interface WorkflowEngineDeps {
  /** One-shot generation for ai_agent nodes. */
  runAgent: (prompt: string, providerId?: string, modelId?: string) => Promise<string>
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

function str(config: Record<string, unknown>, key: string): string {
  const v = config[key]
  return typeof v === 'string' ? v : ''
}

/** Topological order of node ids, or null if the graph has a cycle. */
export function topoOrder(graph: WorkflowGraph): string[] | null {
  const ids = new Set(graph.nodes.map((n) => n.id))
  const indegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of graph.nodes) {
    indegree.set(n.id, 0)
    adj.set(n.id, [])
  }
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1)
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1
      indegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  return order.length === graph.nodes.length ? order : null
}

/** Interpolates {{input}} and {{<nodeId>}} placeholders. */
function interpolate(
  template: string,
  input: string,
  outputs: Record<string, string>
): string {
  return template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key: string) => {
    if (key === 'input') return input
    return outputs[key] ?? ''
  })
}

async function runHttp(
  node: WorkflowNode,
  input: string,
  outputs: Record<string, string>,
  deps: WorkflowEngineDeps
): Promise<string> {
  const method = (str(node.config, 'method') || 'GET').toUpperCase()
  const url = interpolate(str(node.config, 'url'), input, outputs).trim()
  const parsed = new URL(url) // throws -> caught by caller
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('URL must use https:// (http is only allowed for localhost).')
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const init: RequestInit = { method, signal: controller.signal }
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = interpolate(str(node.config, 'body'), input, outputs)
      init.headers = { 'content-type': 'application/json' }
    }
    const res = await fetchImpl(parsed.toString(), init)
    const text = (await res.text()).slice(0, HTTP_MAX_BYTES)
    return `HTTP ${res.status}\n${text}`
  } finally {
    clearTimeout(timer)
  }
}

export async function runWorkflow(
  graph: WorkflowGraph,
  deps: WorkflowEngineDeps
): Promise<WorkflowRunResult> {
  const outputs: Record<string, string> = {}
  if (graph.nodes.length === 0) return { ok: true, nodeOutputs: {}, order: [] }
  if (graph.nodes.length > MAX_NODES) {
    return { ok: false, nodeOutputs: {}, order: [], error: `Too many nodes (max ${MAX_NODES}).` }
  }
  const order = topoOrder(graph)
  if (!order) {
    return { ok: false, nodeOutputs: {}, order: [], error: 'The workflow has a cycle.' }
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const incoming = new Map<string, string[]>()
  for (const n of graph.nodes) incoming.set(n.id, [])
  for (const e of graph.edges) incoming.get(e.target)?.push(e.source)

  for (const id of order) {
    if (deps.signal?.aborted) {
      return { ok: false, nodeOutputs: outputs, order, error: 'Aborted.', failedNodeId: id }
    }
    const node = byId.get(id)!
    const input = (incoming.get(id) ?? [])
      .map((src) => outputs[src] ?? '')
      .filter((s) => s.length > 0)
      .join('\n')
    try {
      let output = ''
      switch (node.kind) {
        case 'manual':
          output = str(node.config, 'text')
          break
        case 'template':
          output = interpolate(str(node.config, 'template'), input, outputs)
          break
        case 'output':
          output = input
          break
        case 'http_request':
          output = await runHttp(node, input, outputs, deps)
          break
        case 'ai_agent': {
          const prompt = interpolate(str(node.config, 'prompt'), input, outputs)
          output = await deps.runAgent(
            prompt,
            str(node.config, 'providerId') || undefined,
            str(node.config, 'modelId') || undefined
          )
          break
        }
        default:
          output = ''
      }
      outputs[id] = output
    } catch (e) {
      return {
        ok: false,
        nodeOutputs: outputs,
        order,
        error: e instanceof Error ? e.message : String(e),
        failedNodeId: id,
      }
    }
  }
  return { ok: true, nodeOutputs: outputs, order }
}
