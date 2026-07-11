/**
 * Tasks tab: the task's shared goal, plans/checklists/notes (WorkspaceItems)
 * and the summarize action. The workspace itself is created lazily — by the
 * assistant (update_task_list / uld-item) or by the explicit button here.
 */

import { useState, type ReactElement } from 'react'
import { useChatStore } from '@/stores/chat'
import { useWorkspaceStore } from '@/stores/workspace'
import WorkspaceItems from './WorkspaceItems'

const SUMMARIZE_PROMPT =
  'Please summarize our progress so far: what is done, what is in flight, and what are the next steps? Update or propose checklist/task items as needed.'

function GoalCard(): ReactElement | null {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const updateGoal = useWorkspaceStore((s) => s.updateGoal)
  const [draft, setDraft] = useState<string | null>(null)

  if (!workspace) return null
  const value = draft ?? workspace.goal ?? ''

  const save = (): void => {
    setDraft(null)
    if (value.trim() === (workspace.goal ?? '').trim()) return
    void updateGoal(value)
  }

  return (
    <div className="card cowork-goal">
      <label className="cowork-goal-label" htmlFor="work-goal">
        Goal
      </label>
      <textarea
        id="work-goal"
        className="textarea cowork-goal-textarea"
        rows={3}
        value={value}
        placeholder="What are you trying to achieve?"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
      />
    </div>
  )
}

export default function TasksTab(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const streaming = useChatStore((s) => s.streaming)
  const workspace = useWorkspaceStore((s) => s.workspace)
  const loading = useWorkspaceStore((s) => s.loading)
  const [starting, setStarting] = useState(false)

  const startWorkspace = (): void => {
    const conv = useChatStore.getState().conversation
    if (!conv) return
    setStarting(true)
    void useWorkspaceStore
      .getState()
      .ensureWorkspaceForConversation(conv)
      .finally(() => setStarting(false))
  }

  if (!workspace) {
    return (
      <div className="work-tab-body">
        <div className="work-tab-empty">
          <p>
            No goal or task list yet. The assistant starts one when you give it multi-step work —
            or set it up yourself.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={starting || loading || !conversation}
            onClick={startWorkspace}
          >
            {starting ? 'Creating…' : 'Add a goal & task list'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="work-tab-body">
      <div className="work-tasks-actions">
        <button
          type="button"
          className="btn cowork-summarize"
          disabled={!conversation || streaming !== null}
          title="Ask the assistant to summarize progress and update items"
          onClick={() => void useChatStore.getState().send(SUMMARIZE_PROMPT)}
        >
          Summarize progress
        </button>
      </div>
      <GoalCard />
      <WorkspaceItems />
    </div>
  )
}
