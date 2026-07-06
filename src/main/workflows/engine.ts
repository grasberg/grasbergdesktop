/**
 * Workflow execution engine: runs a node graph in topological order, feeding
 * each node the concatenated outputs of its predecessors as `{{input}}`.
 * Pure and dependency-injected (AI + fetch + notify), so it is fully
 * unit-testable.
 *
 * Node kinds:
 *  - manual       : emits its configured text (a starting input).
 *  - template     : interpolates {{input}} / {{<nodeId>}} into a template.
 *  - http_request : method + url (+ body), returns the response text.
 *  - ai_agent     : runs a generation over the interpolated prompt; with
 *                   config.useTools the generation may call enabled tools
 *                   (only ones whose permission is 'always allow' — headless
 *                   runs can never pop an approval dialog).
 *  - condition    : passes input through; edges labelled 'true'/'false'
 *                   (sourceHandle) gate the branches. The test is a
 *                   case-insensitive substring match of config.needle against
 *                   the input (empty needle = "input is non-empty").
 *  - notify       : passes input through and delivers it via the injected
 *                   notifier (Telegram bridge / outbound webhook).
 *  - output       : passes its input through (the workflow's result).
 *
 * Branching: an edge is inactive when its source was skipped, or when its
 * source is a condition node and the edge's handle doesn't match the result
 * (edges without a handle count as 'true'). A node with incoming edges, all
 * of them inactive, is skipped.
 */

import type { WorkflowGraph, WorkflowNode, WorkflowRunResult } from '@shared/types'

const MAX_NODES = 100
const HTTP_TIMEOUT_MS = 15_000
const HTTP_MAX_BYTES = 256 * 1024

export interface RunAgentOptions {
  /** Allow the generation to call enabled always-allow tools. */
  useTools?: boolean
  /** Run as this agent profile (persona/model/toolset from Settings → Agents). */
  agentId?: string
  /** Force valid-JSON output (providers with a JSON mode). */
  json?: boolean
  /** Aborts in-flight provider calls when the run is cancelled/timed out. */
  signal?: AbortSignal
}

export interface WorkflowEngineDeps {
  /** Generation for ai_agent nodes. */
  runAgent: (
    prompt: string,
    providerId?: string,
    modelId?: string,
    opts?: RunAgentOptions
  ) => Promise<string>
  /** Delivery for notify nodes (Telegram/webhook); absent = node errors. */
  notify?: (text: string) => Promise<void>
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

/** The condition test: case-insensitive substring; empty needle = non-empty input. */
function evaluateCondition(node: WorkflowNode, input: string): boolean {
  const needle = str(node.config, 'needle').trim()
  if (needle.length === 0) return input.trim().length > 0
  return input.toLowerCase().includes(needle.toLowerCase())
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
  const skipped = new Set<string>()
  /** Condition results by node id (set when the condition executes). */
  const conditionResults = new Map<string, boolean>()

  /** An edge fires only if its source ran and (for conditions) the branch matches. */
  const edgeActive = (edge: WorkflowGraph['edges'][number]): boolean => {
    if (skipped.has(edge.source)) return false
    const source = byId.get(edge.source)
    if (source?.kind === 'condition') {
      const result = conditionResults.get(edge.source) ?? false
      const branch = edge.sourceHandle === 'false' ? false : true
      return branch === result
    }
    return true
  }

  for (const id of order) {
    if (deps.signal?.aborted) {
      return { ok: false, nodeOutputs: outputs, order, error: 'Aborted.', failedNodeId: id }
    }
    const node = byId.get(id)!
    const incomingEdges = graph.edges.filter((e) => e.target === id && byId.has(e.source))
    const activeEdges = incomingEdges.filter(edgeActive)
    if (incomingEdges.length > 0 && activeEdges.length === 0) {
      skipped.add(id)
      continue
    }
    const input = activeEdges
      .map((e) => outputs[e.source] ?? '')
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
        case 'condition':
          conditionResults.set(id, evaluateCondition(node, input))
          output = input
          break
        case 'notify': {
          if (!deps.notify) {
            throw new Error('No delivery channel is configured (Telegram bridge or webhook).')
          }
          await deps.notify(input)
          output = input
          break
        }
        case 'ai_agent': {
          const prompt = interpolate(str(node.config, 'prompt'), input, outputs)
          const agentId = str(node.config, 'agentId')
          output = await deps.runAgent(
            prompt,
            str(node.config, 'providerId') || undefined,
            str(node.config, 'modelId') || undefined,
            {
              useTools: node.config.useTools === true,
              ...(agentId ? { agentId } : {}),
              ...(node.config.jsonOutput === true ? { json: true } : {}),
              ...(deps.signal ? { signal: deps.signal } : {}),
            }
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
        skipped: skipped.size > 0 ? [...skipped] : undefined,
        error: e instanceof Error ? e.message : String(e),
        failedNodeId: id,
      }
    }
  }
  return {
    ok: true,
    nodeOutputs: outputs,
    order,
    skipped: skipped.size > 0 ? [...skipped] : undefined,
  }
}
