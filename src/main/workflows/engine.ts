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

import { isAllowedBaseUrl } from '@shared/schemas'
import type { WorkflowGraph, WorkflowNode, WorkflowRunResult } from '@shared/types'

const MAX_NODES = 100
const MAX_PARALLEL_ASYNC_NODES = 3
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
  /** Route to the configured economy model (dry runs; explicit ids still win). */
  economy?: boolean
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
  /**
   * Payload the run was triggered with (the trigger endpoint's request body).
   * Input nodes emit it instead of their configured text, so an event-driven
   * workflow can act on what the event carried. Plain text, never evaluated.
   */
  triggerPayload?: string
}

function str(config: Record<string, unknown>, key: string): string {
  const v = config[key]
  return typeof v === 'string' ? v : ''
}

/**
 * Wraps live engine deps for a DRY RUN: http_request nodes report the exact
 * request they would have sent (method, URL, body) without sending it,
 * notify nodes swallow delivery (their output still shows the message text)
 * but still fail when NO channel is configured — the exact error a real run
 * would hit — and ai_agent generations run WITHOUT tools (a dry run must
 * never fire always-allow tools' real side effects) and route to the economy
 * model when one is configured. Everything else — interpolation, branching,
 * ordering — runs exactly like a real execution.
 */
export function makeDryRunDeps(
  real: WorkflowEngineDeps,
  opts: {
    /** Preflight for notify nodes (no sends); absent = assume configured. */
    notifyConfigured?: () => boolean
  } = {}
): WorkflowEngineDeps {
  const stubFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const body =
      typeof init?.body === 'string' && init.body.length > 0
        ? `\nbody: ${init.body.slice(0, 2000)}`
        : ''
    return new Response(
      `[dry run] Would send ${method} ${String(input)} — nothing was sent.${body}`,
      { status: 200 }
    )
  }) as typeof fetch
  return {
    ...real,
    runAgent: (prompt, providerId, modelId, agentOpts) =>
      real.runAgent(prompt, providerId, modelId, { ...agentOpts, useTools: false, economy: true }),
    notify: async () => {
      if (opts.notifyConfigured && !opts.notifyConfigured()) {
        throw new Error(
          'No delivery channel available — connect the Telegram bridge or configure a webhook.'
        )
      }
    },
    fetchImpl: stubFetch,
  }
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

/**
 * Reads at most `maxBytes` of a response body, then cancels the rest — a
 * workflow URL can point at an arbitrarily large payload, and buffering it in
 * full would only be truncated afterwards (at main-process memory's expense).
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes)
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let out = ''
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The body may already be closed/errored — nothing to do.
    }
  }
  return (out + decoder.decode()).slice(0, maxBytes)
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
  // Same policy as providers/MCP/webhooks: https always, http only for the
  // loopback hosts (localhost / 127.0.0.1 / [::1]).
  if (!isAllowedBaseUrl(parsed.toString())) {
    throw new Error('URL must use https:// (http is only allowed for localhost).')
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const abortFromParent = (): void => controller.abort(deps.signal?.reason)
  if (deps.signal?.aborted) abortFromParent()
  else deps.signal?.addEventListener('abort', abortFromParent, { once: true })
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const init: RequestInit = { method, signal: controller.signal }
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = interpolate(str(node.config, 'body'), input, outputs)
      init.headers = { 'content-type': 'application/json' }
    }
    const res = await fetchImpl(parsed.toString(), init)
    const text = await readCapped(res, HTTP_MAX_BYTES)
    return `HTTP ${res.status}\n${text}`
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', abortFromParent)
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
  const incoming = new Map<string, WorkflowGraph['edges']>()
  for (const id of order) incoming.set(id, [])
  for (const edge of graph.edges) {
    if (byId.has(edge.source) && byId.has(edge.target)) incoming.get(edge.target)!.push(edge)
  }

  // Group the stable topological order into dependency levels. Nodes in one
  // level never depend on each other, so its AI/HTTP work is safe to overlap.
  const depth = new Map<string, number>()
  const levels: string[][] = []
  for (const id of order) {
    const nodeDepth = (incoming.get(id) ?? []).reduce(
      (max, edge) => Math.max(max, (depth.get(edge.source) ?? 0) + 1),
      0
    )
    depth.set(id, nodeDepth)
    ;(levels[nodeDepth] ??= []).push(id)
  }

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

  const controller = new AbortController()
  const abortFromParent = (): void => controller.abort(deps.signal?.reason)
  if (deps.signal?.aborted) abortFromParent()
  else deps.signal?.addEventListener('abort', abortFromParent, { once: true })
  const runDeps: WorkflowEngineDeps = { ...deps, signal: controller.signal }

  let failure: { id: string; error: unknown } | null = null

  const executeNode = async (id: string): Promise<void> => {
    if (controller.signal.aborted) throw new Error('Aborted.')
    const node = byId.get(id)!
    const incomingEdges = incoming.get(id) ?? []
    const activeEdges = incomingEdges.filter(edgeActive)
    if (incomingEdges.length > 0 && activeEdges.length === 0) {
      skipped.add(id)
      return
    }
    const input = activeEdges
      .map((e) => outputs[e.source] ?? '')
      .filter((s) => s.length > 0)
      .join('\n')
    let output = ''
    switch (node.kind) {
        case 'manual':
          // A trigger payload overrides the node's configured text, so the same
          // graph works both by hand and driven by an outside event.
          output = runDeps.triggerPayload?.trim() ? runDeps.triggerPayload : str(node.config, 'text')
          break
        case 'template':
          output = interpolate(str(node.config, 'template'), input, outputs)
          break
        case 'output':
          output = input
          break
        case 'http_request':
          output = await runHttp(node, input, outputs, runDeps)
          break
        case 'condition':
          conditionResults.set(id, evaluateCondition(node, input))
          output = input
          break
        case 'notify': {
          if (!runDeps.notify) {
            throw new Error('No delivery channel is configured (Telegram bridge or webhook).')
          }
          await runDeps.notify(input)
          output = input
          break
        }
        case 'ai_agent': {
          const prompt = interpolate(str(node.config, 'prompt'), input, outputs)
          const agentId = str(node.config, 'agentId')
          output = await runDeps.runAgent(
            prompt,
            str(node.config, 'providerId') || undefined,
            str(node.config, 'modelId') || undefined,
            {
              useTools: node.config.useTools === true,
              ...(agentId ? { agentId } : {}),
              ...(node.config.jsonOutput === true ? { json: true } : {}),
              signal: controller.signal,
            }
          )
          break
        }
        default:
          output = ''
    }
    outputs[id] = output
  }

  const fail = (id: string, error: unknown): void => {
    if (failure) return
    failure = { id, error }
    controller.abort()
  }

  const runAsyncNodes = async (ids: string[]): Promise<void> => {
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (!failure && cursor < ids.length) {
        const id = ids[cursor++]!
        try {
          await executeNode(id)
        } catch (error) {
          fail(id, error)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(MAX_PARALLEL_ASYNC_NODES, ids.length) }, () => worker())
    )
  }

  try {
    for (const level of levels) {
      if (controller.signal.aborted) {
        if (!failure) fail(level[0] ?? order[0]!, new Error('Aborted.'))
        break
      }
      let asyncNodes: string[] = []
      const flushAsync = async (): Promise<void> => {
        if (asyncNodes.length === 0 || failure) return
        const queued = asyncNodes
        asyncNodes = []
        await runAsyncNodes(queued)
      }

      for (const id of level) {
        if (failure) break
        const kind = byId.get(id)!.kind
        if (kind === 'ai_agent' || kind === 'http_request') {
          asyncNodes.push(id)
          continue
        }
        // Notifications are serialized barriers so externally visible sends
        // keep the same stable topological order.
        if (kind === 'notify') await flushAsync()
        if (failure) break
        try {
          await executeNode(id)
        } catch (error) {
          fail(id, error)
        }
      }
      await flushAsync()
      if (failure) break
    }
  } finally {
    deps.signal?.removeEventListener('abort', abortFromParent)
  }

  if (failure) {
    const failed = failure as { id: string; error: unknown }
    return {
      ok: false,
      nodeOutputs: outputs,
      order,
      skipped: skipped.size > 0 ? [...skipped] : undefined,
      error: failed.error instanceof Error ? failed.error.message : String(failed.error),
      failedNodeId: failed.id,
    }
  }
  return { ok: true, nodeOutputs: outputs, order, skipped: skipped.size > 0 ? [...skipped] : undefined }
}
