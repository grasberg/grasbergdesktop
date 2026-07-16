/**
 * The agent inbox: one review queue over every background result — finished
 * background agent runs (delegate background=true), workflow runs and
 * scheduled-task runs. Pure aggregation: the IPC handler feeds it repository
 * rows plus the reviewed-state map and renders the result to the Home inbox.
 */

import type {
  AgentRun,
  InboxItem,
  ScheduledTask,
  WorkflowRunListItem,
} from '@shared/types'

const SNIPPET_MAX = 240
const INBOX_MAX_ITEMS = 50

function snip(text: string | null | undefined): string {
  const trimmed = (text ?? '').trim().replace(/\s+/g, ' ')
  return trimmed.length > SNIPPET_MAX ? `${trimmed.slice(0, SNIPPET_MAX)}…` : trimmed
}

export interface InboxSources {
  agentRuns: AgentRun[]
  workflowRuns: WorkflowRunListItem[]
  scheduledTasks: ScheduledTask[]
}

export function buildInboxItems(
  sources: InboxSources,
  reviewedByKey: Map<string, number>
): InboxItem[] {
  const items: InboxItem[] = []

  for (const run of sources.agentRuns) {
    if (run.status === 'running') continue
    items.push({
      itemType: 'agent_run',
      itemId: run.id,
      sourceLabel: run.agentName ?? 'Background agent',
      title: snip(run.task) || 'Background run',
      status: run.status === 'done' ? 'ok' : run.status === 'stopped' ? 'stopped' : 'error',
      snippet: snip(run.result),
      conversationId: run.conversationId,
      workflowId: null,
      finishedAt: run.finishedAt ?? run.startedAt,
      reviewedAt: reviewedByKey.get(`agent_run:${run.id}`) ?? null,
    })
  }

  for (const run of sources.workflowRuns) {
    items.push({
      itemType: 'workflow_run',
      itemId: run.id,
      sourceLabel: run.workflowName,
      title: run.workflowName,
      status: run.status === 'ok' ? 'ok' : 'error',
      snippet: snip(run.error ?? run.output),
      conversationId: null,
      workflowId: run.workflowId,
      finishedAt: run.finishedAt ?? run.startedAt,
      reviewedAt: reviewedByKey.get(`workflow_run:${run.id}`) ?? null,
    })
  }

  for (const task of sources.scheduledTasks) {
    // One inbox item per COMPLETED run: keying on lastRunAt makes the item
    // reappear as unreviewed after each new execution of the same task.
    if (task.lastRunAt === null) continue
    if (task.lastStatus !== 'ok' && task.lastStatus !== 'error') continue
    const itemId = `${task.id}:${task.lastRunAt}`
    items.push({
      itemType: 'scheduled_task_run',
      itemId,
      sourceLabel: task.title,
      title: task.title,
      status: task.lastStatus,
      snippet: snip(task.lastError ?? task.lastOutput),
      conversationId: null,
      workflowId: null,
      finishedAt: task.lastRunAt,
      reviewedAt: reviewedByKey.get(`scheduled_task_run:${itemId}`) ?? null,
    })
  }

  return items.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, INBOX_MAX_ITEMS)
}
