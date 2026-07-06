import { describe, expect, it, vi } from 'vitest'
import type { WorkflowGraph, WorkflowNode } from '@shared/types'
import { runWorkflow, topoOrder } from '../../../src/main/workflows/engine'

function node(id: string, kind: WorkflowNode['kind'], config: Record<string, unknown>): WorkflowNode {
  return { id, kind, label: id, position: { x: 0, y: 0 }, config }
}

describe('topoOrder', () => {
  it('orders a DAG and rejects a cycle', () => {
    const dag: WorkflowGraph = {
      nodes: [node('a', 'manual', {}), node('b', 'output', {})],
      edges: [{ id: 'e', source: 'a', target: 'b' }],
    }
    expect(topoOrder(dag)).toEqual(['a', 'b'])

    const cyclic: WorkflowGraph = {
      nodes: [node('a', 'template', {}), node('b', 'template', {})],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    }
    expect(topoOrder(cyclic)).toBeNull()
  })
})

describe('runWorkflow', () => {
  it('runs manual -> template -> ai_agent -> output with interpolation', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        node('m', 'manual', { text: 'world' }),
        node('t', 'template', { template: 'Hello {{input}}' }),
        node('a', 'ai_agent', { prompt: 'Say: {{input}}' }),
        node('o', 'output', {}),
      ],
      edges: [
        { id: 'e1', source: 'm', target: 't' },
        { id: 'e2', source: 't', target: 'a' },
        { id: 'e3', source: 'a', target: 'o' },
      ],
    }
    const runAgent = vi.fn(async (prompt: string) => `AI(${prompt})`)
    const res = await runWorkflow(graph, { runAgent })

    expect(res.ok).toBe(true)
    expect(res.nodeOutputs.m).toBe('world')
    expect(res.nodeOutputs.t).toBe('Hello world')
    expect(runAgent).toHaveBeenCalledWith('Say: Hello world', undefined, undefined, {
      useTools: false,
    })
    expect(res.nodeOutputs.a).toBe('AI(Say: Hello world)')
    expect(res.nodeOutputs.o).toBe('AI(Say: Hello world)')
  })

  it('runs an http_request node with URL interpolation', async () => {
    const fetchImpl = vi.fn(async (_url?: string | URL | Request, _init?: RequestInit) =>
      new Response('pong', { status: 200 })
    )
    const graph: WorkflowGraph = {
      nodes: [
        node('m', 'manual', { text: 'ping' }),
        node('h', 'http_request', { method: 'GET', url: 'https://api.example.com/{{input}}' }),
      ],
      edges: [{ id: 'e', source: 'm', target: 'h' }],
    }
    const res = await runWorkflow(graph, {
      runAgent: async () => '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(res.ok).toBe(true)
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://api.example.com/ping')
    expect(res.nodeOutputs.h).toContain('HTTP 200')
    expect(res.nodeOutputs.h).toContain('pong')
  })

  it('reports a cycle as a failed run', async () => {
    const graph: WorkflowGraph = {
      nodes: [node('a', 'template', {}), node('b', 'template', {})],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    }
    const res = await runWorkflow(graph, { runAgent: async () => '' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cycle/i)
  })

  it('captures a node failure with its id', async () => {
    const graph: WorkflowGraph = {
      nodes: [node('h', 'http_request', { method: 'GET', url: 'ftp://nope' })],
      edges: [],
    }
    const res = await runWorkflow(graph, { runAgent: async () => '' })
    expect(res.ok).toBe(false)
    expect(res.failedNodeId).toBe('h')
  })

  it('condition routes the true branch and skips the false branch (and downstream)', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        node('m', 'manual', { text: 'URGENT: server down' }),
        node('c', 'condition', { needle: 'urgent' }),
        node('yes', 'template', { template: 'alert: {{input}}' }),
        node('no', 'template', { template: 'calm: {{input}}' }),
        node('after-no', 'template', { template: 'x{{input}}' }),
      ],
      edges: [
        { id: 'e1', source: 'm', target: 'c' },
        { id: 'e2', source: 'c', target: 'yes', sourceHandle: 'true' },
        { id: 'e3', source: 'c', target: 'no', sourceHandle: 'false' },
        { id: 'e4', source: 'no', target: 'after-no' },
      ],
    }
    const res = await runWorkflow(graph, { runAgent: async () => '' })
    expect(res.ok).toBe(true)
    expect(res.nodeOutputs.yes).toBe('alert: URGENT: server down')
    expect(res.nodeOutputs.no).toBeUndefined()
    // Skips propagate through the dead branch.
    expect(res.skipped).toEqual(expect.arrayContaining(['no', 'after-no']))
  })

  it('a condition edge without a handle counts as the true branch', async () => {
    const graph: WorkflowGraph = {
      nodes: [
        node('m', 'manual', { text: 'nothing here' }),
        node('c', 'condition', { needle: 'urgent' }),
        node('t', 'template', { template: 'got {{input}}' }),
      ],
      edges: [
        { id: 'e1', source: 'm', target: 'c' },
        { id: 'e2', source: 'c', target: 't' },
      ],
    }
    const res = await runWorkflow(graph, { runAgent: async () => '' })
    expect(res.ok).toBe(true)
    // Condition is false -> the (implicit true) edge doesn't fire.
    expect(res.nodeOutputs.t).toBeUndefined()
    expect(res.skipped).toEqual(['t'])
  })

  it('notify delivers its input and errors without a channel', async () => {
    const graph: WorkflowGraph = {
      nodes: [node('m', 'manual', { text: 'hello' }), node('n', 'notify', {})],
      edges: [{ id: 'e1', source: 'm', target: 'n' }],
    }
    const notify = vi.fn(async () => undefined)
    const ok = await runWorkflow(graph, { runAgent: async () => '', notify })
    expect(ok.ok).toBe(true)
    expect(notify).toHaveBeenCalledWith('hello')
    expect(ok.nodeOutputs.n).toBe('hello')

    const noChannel = await runWorkflow(graph, { runAgent: async () => '' })
    expect(noChannel.ok).toBe(false)
    expect(noChannel.failedNodeId).toBe('n')
  })

  it('passes useTools through to runAgent', async () => {
    const graph: WorkflowGraph = {
      nodes: [node('a', 'ai_agent', { prompt: 'go', useTools: true })],
      edges: [],
    }
    const runAgent = vi.fn(async () => 'done')
    await runWorkflow(graph, { runAgent })
    expect(runAgent).toHaveBeenCalledWith('go', undefined, undefined, { useTools: true })
  })
})
