/**
 * Cowork mode: the regular chat in the center plus a collapsible workspace
 * panel on the right (workspace name, shared goal, and the item list).
 * The panel binds to the open conversation's workspace, creating one on
 * demand, and refreshes its items whenever a generation completes (assistant
 * proposals are parsed main-side on stream completion).
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import ChatView from '@/components/chat/ChatView'
import { useChatStore } from '@/stores/chat'
import { useCoworkStore } from '@/stores/cowork'
import WorkspaceItems from './WorkspaceItems'
import './cowork.css'

const SUMMARIZE_PROMPT =
  'Please summarize our progress so far: what is done, what is in flight, and what are the next steps? Update or propose checklist/task items as needed.'

function WorkspaceName(): ReactElement | null {
  const workspace = useCoworkStore((s) => s.workspace)
  const renameWorkspace = useCoworkStore((s) => s.renameWorkspace)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!workspace) return null

  const commit = (): void => {
    setEditing(false)
    void renameWorkspace(draft)
  }

  if (editing) {
    return (
      <input
        className="input cowork-name-input"
        value={draft}
        autoFocus
        aria-label="Workspace name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className="cowork-name"
      title="Rename workspace"
      onClick={() => {
        setDraft(workspace.name)
        setEditing(true)
      }}
    >
      {workspace.name}
    </button>
  )
}

function GoalCard(): ReactElement | null {
  const workspace = useCoworkStore((s) => s.workspace)
  const updateGoal = useCoworkStore((s) => s.updateGoal)
  const [draft, setDraft] = useState('')
  const workspaceId = workspace?.id ?? null
  const goal = workspace?.goal ?? ''

  // Re-seed the draft when a different workspace loads or the goal changes
  // underneath us (e.g. refresh after a stream).
  useEffect(() => {
    setDraft(goal)
  }, [workspaceId, goal])

  if (!workspace) return null

  const save = (): void => {
    if (draft.trim() === (workspace.goal ?? '').trim()) return
    void updateGoal(draft)
  }

  return (
    <div className="card cowork-goal">
      <label className="cowork-goal-label" htmlFor="cowork-goal">
        Goal
      </label>
      <textarea
        id="cowork-goal"
        className="textarea cowork-goal-textarea"
        rows={3}
        value={draft}
        placeholder="What are you trying to achieve?"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
      />
    </div>
  )
}

export default function CoworkView(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const streaming = useChatStore((s) => s.streaming)
  const [panelOpen, setPanelOpen] = useState(true)

  const conversationId = conversation?.id ?? null

  // Bind the workspace to the open conversation (create + link on demand).
  useEffect(() => {
    if (!conversationId) return
    const current = useChatStore.getState().conversation
    if (current && current.id === conversationId) {
      void useCoworkStore.getState().ensureWorkspaceForConversation(current)
    }
  }, [conversationId])

  // When a stream completes (streaming -> null), assistant-proposed items may
  // have been persisted main-side — pick them up.
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (wasStreaming.current && streaming === null) {
      void useCoworkStore.getState().refresh()
    }
    wasStreaming.current = streaming !== null
  }, [streaming])

  const summarize = (): void => {
    void useChatStore.getState().send(SUMMARIZE_PROMPT)
  }

  return (
    <div className="cowork-view">
      <div className="cowork-center">
        <ChatView />
      </div>

      {panelOpen ? (
        <aside className="cowork-panel" aria-label="Workspace panel">
          <header className="cowork-panel-header">
            <WorkspaceName />
            <button
              type="button"
              className="btn cowork-summarize"
              disabled={!conversation || streaming !== null}
              title="Ask the assistant to summarize progress and update items"
              onClick={summarize}
            >
              Summarize progress
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Hide workspace panel"
              aria-expanded={true}
              title="Hide workspace panel"
              onClick={() => setPanelOpen(false)}
            >
              »
            </button>
          </header>
          <div className="cowork-panel-body">
            <GoalCard />
            <WorkspaceItems />
          </div>
        </aside>
      ) : (
        <div className="cowork-panel-collapsed">
          <button
            type="button"
            className="btn-icon"
            aria-label="Show workspace panel"
            aria-expanded={false}
            title="Show workspace panel"
            onClick={() => setPanelOpen(true)}
          >
            «
          </button>
        </div>
      )}
    </div>
  )
}
