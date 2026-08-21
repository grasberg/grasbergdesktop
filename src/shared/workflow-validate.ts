/**
 * Pure pre-run sanity checks for a workflow graph, shared by the builder UI
 * (node badges + checks list) and unit tests. Errors are things that will
 * make a run fail or do nothing; warnings are likely mistakes that still run.
 * No runtime deps — mirrors the engine's semantics without importing it.
 */

import type { WorkflowGraph } from './types'

export interface WorkflowIssue {
  /** The offending node, or null for a graph-level issue. */
  nodeId: string | null
  level: 'error' | 'warning'
  message: string
}

/** Kahn's algorithm — true when the graph has a cycle (matches engine.topoOrder). */
function hasCycle(graph: WorkflowGraph): boolean {
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
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    visited += 1
    for (const next of adj.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1
      indegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  return visited !== graph.nodes.length
}

function configText(config: Record<string, unknown>, key: string): string {
  const v = config[key]
  return typeof v === 'string' ? v.trim() : ''
}

export function validateWorkflowGraph(graph: WorkflowGraph): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  if (graph.nodes.length === 0) return issues

  if (hasCycle(graph)) {
    issues.push({ nodeId: null, level: 'error', message: 'The workflow has a cycle.' })
  }

  const connected = new Set<string>()
  for (const e of graph.edges) {
    connected.add(e.source)
    connected.add(e.target)
  }

  for (const node of graph.nodes) {
    switch (node.kind) {
      case 'http_request':
        if (!configText(node.config, 'url')) {
          issues.push({ nodeId: node.id, level: 'error', message: 'HTTP request has no URL.' })
        }
        break
      case 'ai_agent':
        if (!configText(node.config, 'prompt')) {
          issues.push({ nodeId: node.id, level: 'error', message: 'AI agent has no prompt.' })
        }
        break
      case 'template':
        if (!configText(node.config, 'template')) {
          issues.push({ nodeId: node.id, level: 'error', message: 'Template is empty.' })
        }
        break
      case 'manual':
        if (!configText(node.config, 'text')) {
          issues.push({ nodeId: node.id, level: 'warning', message: 'Input node has no text.' })
        }
        break
      default:
        break
    }
    if (graph.nodes.length > 1 && !connected.has(node.id)) {
      issues.push({
        nodeId: node.id,
        level: 'warning',
        message: 'Not connected to anything — it runs in isolation.',
      })
    }
  }

  if (!graph.nodes.some((n) => n.kind === 'output')) {
    issues.push({
      nodeId: null,
      level: 'warning',
      message: 'No Output node — the run result falls back to the last node’s output.',
    })
  }

  return issues
}
