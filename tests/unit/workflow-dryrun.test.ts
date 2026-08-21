/**
 * Dry-run deps and graph validation: makeDryRunDeps must stub every side
 * effect (no real HTTP, no delivery) while keeping the run's mechanics —
 * interpolation, branching, ordering — identical; the templates gallery must
 * only ship graphs that pass validation.
 */

import { describe, expect, it } from 'vitest'
import type { WorkflowGraph } from '@shared/types'
import { WORKFLOW_TEMPLATES } from '@shared/workflow-templates'
import { validateWorkflowGraph } from '@shared/workflow-validate'
import {
  makeDryRunDeps,
  runWorkflow,
  type RunAgentOptions,
  type WorkflowEngineDeps,
} from '../../src/main/workflows/engine'

function node(
  id: string,
  kind: WorkflowGraph['nodes'][number]['kind'],
  config: Record<string, unknown> = {}
): WorkflowGraph['nodes'][number] {
  return { id, kind, label: id, position: { x: 0, y: 0 }, config }
}

describe('makeDryRunDeps', () => {
  it('stubs HTTP + notify and routes AI to the economy model', async () => {
    const agentCalls: Array<{ prompt: string; opts?: RunAgentOptions }> = []
    const notified: string[] = []
    const realDeps: WorkflowEngineDeps = {
      runAgent: async (prompt, _providerId, _modelId, opts) => {
        agentCalls.push({ prompt, opts })
        return `AI(${prompt})`
      },
      notify: async (text) => {
        notified.push(text)
      },
      fetchImpl: (async () => {
        throw new Error('REAL FETCH MUST NEVER RUN IN A DRY RUN')
      }) as typeof fetch,
    }

    const graph: WorkflowGraph = {
      nodes: [
        node('fetch', 'http_request', {
          method: 'POST',
          url: 'https://api.example.com/hook',
          body: '{"x":1}',
        }),
        node('ai', 'ai_agent', { prompt: 'Summarize: {{input}}', useTools: true }),
        node('send', 'notify'),
        node('out', 'output'),
      ],
      edges: [
        { id: 'e1', source: 'fetch', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'send' },
        { id: 'e3', source: 'send', target: 'out' },
      ],
    }

    const result = await runWorkflow(graph, makeDryRunDeps(realDeps))
    expect(result.ok).toBe(true)

    // The HTTP node reports what it WOULD have sent — the real fetch never ran.
    expect(result.nodeOutputs['fetch']).toContain('[dry run] Would send POST')
    expect(result.nodeOutputs['fetch']).toContain('https://api.example.com/hook')
    expect(result.nodeOutputs['fetch']).toContain('{"x":1}')

    // The AI ran (that IS the test value) but was routed to economy — and
    // with tools OFF: a dry run must never fire always-allow tools' real
    // side effects, even when the node opted into them.
    expect(agentCalls).toHaveLength(1)
    expect(agentCalls[0]!.opts?.economy).toBe(true)
    expect(agentCalls[0]!.opts?.useTools).toBe(false)
    expect(agentCalls[0]!.prompt).toContain('[dry run] Would send POST')

    // Nothing was delivered; the notify node still passed its input through.
    expect(notified).toEqual([])
    expect(result.nodeOutputs['out']).toContain('AI(')
  })

  it('fails the notify node when no delivery channel is configured — like a real run', async () => {
    const deps = makeDryRunDeps(
      {
        runAgent: async () => 'x',
        notify: async () => undefined,
      },
      { notifyConfigured: () => false }
    )
    const graph: WorkflowGraph = {
      nodes: [
        node('in', 'manual', { text: 'hello' }),
        node('send', 'notify'),
        node('out', 'output'),
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'send' },
        { id: 'e2', source: 'send', target: 'out' },
      ],
    }
    const result = await runWorkflow(graph, deps)
    expect(result.ok).toBe(false)
    expect(result.failedNodeId).toBe('send')
    expect(result.error).toContain('No delivery channel')
  })

  it('keeps condition branching intact in a dry run', async () => {
    const deps = makeDryRunDeps({
      runAgent: async () => 'URGENT: something happened',
      notify: async () => undefined,
    })
    const graph: WorkflowGraph = {
      nodes: [
        node('in', 'manual', { text: 'check this' }),
        node('ai', 'ai_agent', { prompt: '{{input}}' }),
        node('cond', 'condition', { needle: 'URGENT' }),
        node('alert', 'notify'),
        node('out', 'output'),
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'cond' },
        { id: 'e3', source: 'cond', target: 'alert', sourceHandle: 'true' },
        { id: 'e4', source: 'alert', target: 'out' },
      ],
    }
    const result = await runWorkflow(graph, deps)
    expect(result.ok).toBe(true)
    // The true branch fired, exactly like a real run would.
    expect(result.skipped ?? []).not.toContain('alert')
    expect(result.nodeOutputs['out']).toBe('URGENT: something happened')
  })
})

describe('validateWorkflowGraph', () => {
  it('flags missing required config as errors', () => {
    const graph: WorkflowGraph = {
      nodes: [
        node('h', 'http_request'),
        node('a', 'ai_agent'),
        node('t', 'template'),
        node('out', 'output'),
      ],
      edges: [
        { id: 'e1', source: 'h', target: 'a' },
        { id: 'e2', source: 'a', target: 't' },
        { id: 'e3', source: 't', target: 'out' },
      ],
    }
    const errors = validateWorkflowGraph(graph).filter((i) => i.level === 'error')
    expect(errors.map((i) => i.nodeId).sort()).toEqual(['a', 'h', 't'])
  })

  it('flags cycles, disconnected nodes and a missing output node', () => {
    const graph: WorkflowGraph = {
      nodes: [
        node('a', 'manual', { text: 'x' }),
        node('b', 'template', { template: '{{input}}' }),
        node('island', 'manual', { text: 'alone' }),
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    }
    const issues = validateWorkflowGraph(graph)
    expect(issues.some((i) => i.level === 'error' && /cycle/i.test(i.message))).toBe(true)
    expect(
      issues.some((i) => i.nodeId === 'island' && /not connected/i.test(i.message))
    ).toBe(true)
    expect(issues.some((i) => /no output node/i.test(i.message))).toBe(true)
  })

  it('accepts a healthy linear graph', () => {
    const graph: WorkflowGraph = {
      nodes: [
        node('in', 'manual', { text: 'go' }),
        node('ai', 'ai_agent', { prompt: '{{input}}' }),
        node('out', 'output'),
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'out' },
      ],
    }
    expect(validateWorkflowGraph(graph)).toEqual([])
  })

  it('every shipped template passes validation with zero errors', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const errors = validateWorkflowGraph(template.graph).filter((i) => i.level === 'error')
      expect(errors, `template ${template.id}`).toEqual([])
      // And every template ends in an output node.
      expect(template.graph.nodes.some((n) => n.kind === 'output')).toBe(true)
    }
  })
})
