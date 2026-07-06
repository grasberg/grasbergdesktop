/**
 * Executes SAVED workflows (manual and scheduled triggers) and persists each
 * execution to workflow_runs. The engine stays pure; this layer owns run
 * bookkeeping, per-workflow serialization, and picking the run's headline
 * output (the output node's text, else the last executed node's).
 */

import type { WorkflowGraph, WorkflowRun, WorkflowRunResult } from '@shared/types'
import type { AppDatabase } from '../db/database'
import { runWorkflow, type WorkflowEngineDeps } from './engine'

export interface WorkflowRunner {
  /** Runs a saved workflow, persists the run, and returns the engine result. */
  runById(workflowId: string, trigger: WorkflowRun['trigger']): Promise<WorkflowRunResult>
  /** Aborts every in-flight run (app quit). */
  stopAll(): void
}

/** Wall-clock cap per run: a hung provider call must not wedge the workflow. */
const RUN_TIMEOUT_MS = 10 * 60_000

/** The output node's text (last one in execution order), else the last output. */
export function pickRunOutput(graph: WorkflowGraph, result: WorkflowRunResult): string {
  const outputIds = new Set(graph.nodes.filter((n) => n.kind === 'output').map((n) => n.id))
  for (let i = result.order.length - 1; i >= 0; i--) {
    const id = result.order[i]
    if (outputIds.has(id) && result.nodeOutputs[id] !== undefined) {
      return result.nodeOutputs[id]
    }
  }
  for (let i = result.order.length - 1; i >= 0; i--) {
    const out = result.nodeOutputs[result.order[i]]
    if (out !== undefined && out.length > 0) return out
  }
  return ''
}

export function createWorkflowRunner(
  db: AppDatabase,
  deps: WorkflowEngineDeps
): WorkflowRunner {
  /** A workflow never runs concurrently with itself (manual + schedule races). */
  const running = new Map<string, AbortController>()

  return {
    async runById(workflowId, trigger) {
      const workflow = db.workflows.getById(workflowId)
      if (!workflow) throw new Error('Workflow not found.')
      if (running.has(workflowId)) throw new Error('This workflow is already running.')
      const controller = new AbortController()
      running.set(workflowId, controller)
      const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS)
      const startedAt = Date.now()
      // Stamped up front so the scheduler's due check can't double-fire a
      // long-running workflow on the next tick.
      db.workflows.touchLastRun(workflowId, startedAt)
      try {
        const result = await runWorkflow(workflow.graph, { ...deps, signal: controller.signal })
        try {
          db.workflows.insertRun({
            workflowId,
            trigger,
            status: result.ok ? 'ok' : 'error',
            output: pickRunOutput(workflow.graph, result),
            error: result.error ?? null,
            startedAt,
            finishedAt: Date.now(),
          })
        } catch {
          // Run history is best-effort — the result still reaches the caller.
        }
        return result
      } finally {
        clearTimeout(timeout)
        running.delete(workflowId)
      }
    },

    stopAll() {
      for (const controller of running.values()) controller.abort()
    },
  }
}
