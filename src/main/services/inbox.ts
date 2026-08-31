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

/**
 * Structural view of the database the inbox reads. Declared here (rather than
 * importing AppDatabase) so this module stays runtime-dependency-free and
 * trivially fake-able in tests.
 */
export interface InboxDatabase {
  agentPlatform: { runsList(): AgentRun[] }
  workflows: { listRecentRunsWithNames(limit: number): WorkflowRunListItem[] }
  scheduledTasks: { list(): ScheduledTask[] }
  inbox: { reviewedByKey(): Map<string, number> }
  conversations: { listPrivateSpaceConversationIds(): string[] }
}

/** How many workflow runs the inbox looks back over. */
const WORKFLOW_RUN_LOOKBACK = 30

/** The inbox as the Home view and the unread badge both see it. */
export function collectInboxItems(db: InboxDatabase): InboxItem[] {
  return buildInboxItems(
    {
      agentRuns: db.agentPlatform.runsList(),
      workflowRuns: db.workflows.listRecentRunsWithNames(WORKFLOW_RUN_LOOKBACK),
      scheduledTasks: db.scheduledTasks.list(),
    },
    db.inbox.reviewedByKey(),
    new Set(db.conversations.listPrivateSpaceConversationIds())
  )
}

/** Badge count: results that landed and have not been reviewed yet. */
export function countUnreviewed(items: readonly InboxItem[]): number {
  return items.reduce((total, item) => (item.reviewedAt === null ? total + 1 : total), 0)
}

export function buildInboxItems(
  sources: InboxSources,
  reviewedByKey: Map<string, number>,
  privateConversationIds: ReadonlySet<string> = new Set()
): InboxItem[] {
  const items: InboxItem[] = []

  for (const run of sources.agentRuns) {
    if (run.status === 'running') continue
    // A private-space run shows without preview text: the task IS the prompt,
    // so its title falls back to the agent label (v45).
    const isPrivate = run.conversationId !== null && privateConversationIds.has(run.conversationId)
    items.push({
      itemType: 'agent_run',
      itemId: run.id,
      sourceLabel: run.agentName ?? 'Background agent',
      title: isPrivate ? (run.agentName ?? 'Background agent') : snip(run.task) || 'Background run',
      status: run.status === 'done' ? 'ok' : run.status === 'stopped' ? 'stopped' : 'error',
      snippet: isPrivate ? '' : snip(run.result),
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
