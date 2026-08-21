/**
 * Executes SAVED workflows (manual and scheduled triggers) and persists each
 * execution to workflow_runs. The engine stays pure; this layer owns run
 * bookkeeping, per-workflow serialization, and picking the run's headline
 * output (the output node's text, else the last executed node's).
 */

import type { Workflow, WorkflowGraph, WorkflowRun, WorkflowRunResult } from '@shared/types'
import { WORKFLOW_RUN_TIMEOUT_MS } from '@shared/workflow-status'
import type { AppDatabase } from '../db/database'
import { runWorkflow, type WorkflowEngineDeps } from './engine'

/**
 * The two refusals runById REJECTS with BEFORE it starts anything. They are a
 * contract, not prose: the trigger endpoint matches them exactly to answer 409
 * / 404 instead of a 5xx (see src/main/workflows/trigger-server.ts), so both
 * the thrower and the matcher read the same constants — rewording one in place
 * can no longer silently turn every concurrent trigger into a 500.
 */
export const WORKFLOW_NOT_FOUND_ERROR = 'Workflow not found.'
export const WORKFLOW_ALREADY_RUNNING_ERROR = 'This workflow is already running.'

export interface WorkflowRunner {
  /** Runs a saved workflow, persists the run, and returns the engine result. */
  runById(
    workflowId: string,
    trigger: WorkflowRun['trigger'],
    /** Body of the triggering event, fed to the graph's Input nodes. */
    payload?: string
  ): Promise<WorkflowRunResult>
  /** Aborts every in-flight run (app quit). */
  stopAll(): void
}

export interface WorkflowRunnerHooks {
  /**
   * Fires right after a run row is persisted (manual or scheduled trigger).
   * Best-effort like the insert itself — a throwing hook never breaks the run.
   */
  onRunRecorded?: (run: WorkflowRun, workflow: Workflow) => void
}

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
  deps: WorkflowEngineDeps,
  hooks: WorkflowRunnerHooks = {}
): WorkflowRunner {
  /** A workflow never runs concurrently with itself (manual + schedule races). */
  const running = new Map<string, AbortController>()

  return {
    async runById(workflowId, trigger, payload) {
      const workflow = db.workflows.getById(workflowId)
      if (!workflow) throw new Error(WORKFLOW_NOT_FOUND_ERROR)
      if (running.has(workflowId)) throw new Error(WORKFLOW_ALREADY_RUNNING_ERROR)
      const controller = new AbortController()
      running.set(workflowId, controller)
      const timeout = setTimeout(() => controller.abort(), WORKFLOW_RUN_TIMEOUT_MS)
      const startedAt = Date.now()
      // Stamped up front so the scheduler's due check can't double-fire a
      // long-running workflow on the next tick.
      db.workflows.touchLastRun(workflowId, startedAt)
      try {
        const result = await runWorkflow(workflow.graph, {
          ...deps,
          signal: controller.signal,
          ...(payload ? { triggerPayload: payload } : {}),
        })
        try {
          const run = db.workflows.insertRun({
            workflowId,
            trigger,
            status: result.ok ? 'ok' : 'error',
            output: pickRunOutput(workflow.graph, result),
            error: result.error ?? null,
            startedAt,
            finishedAt: Date.now(),
          })
          hooks.onRunRecorded?.(run, workflow)
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
