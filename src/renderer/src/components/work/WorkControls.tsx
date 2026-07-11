/**
 * Work-mode per-conversation controls above the chat: plan mode, auto-accept
 * edits, and the read-only task-list strip. Also exports the shared
 * connect-a-folder flow used by the Files tab. Moved from the old CodeView;
 * styling stays in code.css (.code-center-bar / .code-plan-toggle /
 * .code-tasklist).
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { parseTaskList, type ParsedTaskLine } from '@shared/tasklist'
import { toNormalized, unwrap } from '@/api/uld'
import { useOnGenerationSettled } from '@/hooks/useOnGenerationSettled'
import { useChatStore } from '@/stores/chat'
import { useCodeStore } from '@/stores/code'
import { useUiStore } from '@/stores/ui'

/**
 * Picks a folder, registers it as a project and links it to the open
 * conversation.
 */
export async function grantFolderAccess(): Promise<void> {
  const conversation = useChatStore.getState().conversation
  if (!conversation) return
  const project = await useCodeStore.getState().openProjectViaPicker()
  if (!project) return
  try {
    await unwrap(
      window.uld.conversations.update({ id: conversation.id, patch: { projectId: project.id } })
    )
    // Refresh the chat store's copy of the conversation (projectId changed).
    await useChatStore.getState().openConversation(conversation.id)
    if (useChatStore.getState().conversation?.projectId !== project.id) {
      useUiStore
        .getState()
        .toast('This build could not link the folder to the conversation.', 'error')
    }
  } catch (e) {
    useUiStore.getState().toast(toNormalized(e).message, 'error')
  }
}

/**
 * Read-only view of the assistant's update_task_list checklist (stored as the
 * 'Task list' workspace item). Refreshes when a generation finishes.
 */
function TaskListStrip(): ReactElement | null {
  const conversationId = useChatStore((s) => s.conversation?.id ?? null)
  const [tasks, setTasks] = useState<ParsedTaskLine[]>([])
  const [open, setOpen] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    if (!conversationId) {
      setTasks([])
      return
    }
    try {
      // Re-fetch the conversation: the tool may have linked a workspace
      // mid-stream, so the chat store's copy can be stale.
      const conv = await unwrap(window.uld.conversations.get(conversationId))
      if (!conv.workspaceId) {
        setTasks([])
        return
      }
      const items = await unwrap(window.uld.workspaces.itemsList(conv.workspaceId))
      const item = items.find((i) => i.kind === 'checklist' && i.title === 'Task list')
      if (!item) {
        setTasks([])
        return
      }
      setTasks(parseTaskList(item.content))
    } catch {
      // The strip is cosmetic — never toast for it.
    }
  }, [conversationId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useOnGenerationSettled(() => void refresh())

  if (tasks.length === 0) return null
  const doneCount = tasks.filter((t) => t.done).length

  return (
    <div className="code-center-bar">
      <div className="code-tasklist">
        <button
          type="button"
          className="code-tasklist-head"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="code-tasklist-title">Tasks</span>
          <span className="code-tasklist-count">
            {doneCount}/{tasks.length}
          </span>
          <span aria-hidden>{open ? '▾' : '▸'}</span>
        </button>
        {open ? (
          <ul className="code-tasklist-items">
            {tasks.map((task, index) => (
              <li
                key={`${index}-${task.text}`}
                className={`code-tasklist-item${task.done ? ' done' : ''}${task.inProgress ? ' active' : ''}`}
              >
                <span aria-hidden>{task.done ? '☑' : '☐'}</span> {task.text}
                {task.inProgress ? <em> — in progress</em> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

/** Only renders a bar above the chat when a task list exists. */
export default function WorkControls(): ReactElement {
  return <TaskListStrip />
}
