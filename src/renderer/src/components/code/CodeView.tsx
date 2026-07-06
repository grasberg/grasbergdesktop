import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { Attachment, ChatParams } from '@shared/types'
import { parseTaskList, type ParsedTaskLine } from '@shared/tasklist'
import ChatView from '@/components/chat/ChatView'
import { toNormalized, unwrap } from '@/api/uld'
import { useOnGenerationSettled } from '@/hooks/useOnGenerationSettled'
import { useChatStore } from '@/stores/chat'
import { useCodeStore } from '@/stores/code'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import ChangesPanel from './ChangesPanel'
import FilePreview from './FilePreview'
import FileTree from './FileTree'
import './code.css'

function ShieldIcon(): ReactElement {
  return (
    <svg
      className="code-grant-icon"
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3l7 3v5c0 4.6-2.9 8.1-7 10-4.1-1.9-7-5.4-7-10V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )
}

/**
 * Picks a folder, registers it as a project and links it to the open
 * conversation.
 */
async function grantFolderAccess(): Promise<void> {
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

function GrantPanel(): ReactElement {
  const [granting, setGranting] = useState(false)
  return (
    <div className="code-grant">
      <ShieldIcon />
      <p className="code-grant-copy">Code mode reads a folder only after you grant access.</p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={granting}
        onClick={() => {
          setGranting(true)
          void grantFolderAccess().finally(() => setGranting(false))
        }}
      >
        {granting ? 'Opening…' : 'Open a folder…'}
      </button>
      <p className="code-grant-hint">
        Files are never modified and commands are never run without an explicit Apply click.
      </p>
    </div>
  )
}

function ProjectHeader(): ReactElement | null {
  const project = useCodeStore((s) => s.project)
  const [changing, setChanging] = useState(false)
  if (!project) return null
  return (
    <header className="code-project-header">
      <div className="code-project-name" title={project.path}>
        {project.name}
      </div>
      <button
        type="button"
        className="btn btn-ghost code-project-change"
        disabled={changing}
        onClick={() => {
          setChanging(true)
          void grantFolderAccess().finally(() => setChanging(false))
        }}
      >
        {changing ? 'Opening…' : 'Change folder'}
      </button>
    </header>
  )
}

/**
 * Left-pane footer: shows how many files are checked in the tree and offers
 * "Attach & ask" — an inline form whose question is sent through the normal
 * chat pipeline with the selected files as attachments. When
 * warnBeforeSendingFiles is on, an inline confirm lists the files first.
 */
function ContextFooter(): ReactElement | null {
  const selectedPaths = useCodeStore((s) => s.selectedPaths)
  const clearSelection = useCodeStore((s) => s.clearSelection)
  const streaming = useChatStore((s) => s.streaming)
  const settings = useSettingsStore((s) => s.settings)

  const [formOpen, setFormOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [pending, setPending] = useState<Attachment[] | null>(null)
  const [busy, setBusy] = useState(false)

  if (selectedPaths.length === 0) return null

  const sendNow = async (attachments: Attachment[]): Promise<void> => {
    setBusy(true)
    try {
      await useChatStore.getState().send(question.trim(), attachments)
      setQuestion('')
      setPending(null)
      setFormOpen(false)
      clearSelection()
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!question.trim() || streaming || busy) return
    setBusy(true)
    const attachments = await useCodeStore.getState().readSelectedAsAttachments()
    setBusy(false)
    if (!attachments || attachments.length === 0) return
    if (settings?.warnBeforeSendingFiles) {
      setPending(attachments)
      return
    }
    await sendNow(attachments)
  }

  return (
    <footer className="code-context">
      <div className="code-context-summary">
        <span>
          {selectedPaths.length} file{selectedPaths.length === 1 ? '' : 's'} selected
        </span>
        <button type="button" className="btn-icon" aria-label="Clear selection" onClick={clearSelection}>
          ×
        </button>
      </div>

      {!formOpen && (
        <button
          type="button"
          className="btn code-context-openform"
          disabled={streaming !== null}
          onClick={() => setFormOpen(true)}
        >
          Attach &amp; ask
        </button>
      )}

      {formOpen && !pending && (
        <div className="code-context-form">
          <textarea
            className="textarea code-context-textarea"
            rows={3}
            value={question}
            placeholder="Ask about the selected files…"
            aria-label="Question about the selected files"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div className="code-context-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!question.trim() || streaming !== null || busy}
              onClick={() => void submit()}
            >
              {busy ? 'Reading…' : 'Send'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {pending && (
        <div className="code-context-confirm" role="alertdialog" aria-label="Confirm sending files">
          <p className="code-context-confirm-text">
            The contents of these files will be sent to the provider:
          </p>
          <ul className="code-context-confirm-list">
            {pending.map((a) => (
              <li key={a.id} title={a.name}>
                {a.name}
              </li>
            ))}
          </ul>
          <div className="code-context-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void sendNow(pending)}
            >
              {busy ? 'Sending…' : 'Send files'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </footer>
  )
}

/**
 * Toggles plan mode on the open conversation (params.planMode). While on,
 * main appends the plan-mode prompt section and refuses mutating tools.
 */
function PlanModeToggle(): ReactElement | null {
  const conversation = useChatStore((s) => s.conversation)
  const [busy, setBusy] = useState(false)
  if (!conversation) return null
  const active = conversation.params.planMode === true

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      const params: ChatParams = { ...conversation.params }
      if (active) delete params.planMode
      else params.planMode = true
      const updated = await unwrap(
        window.uld.conversations.update({ id: conversation.id, patch: { params } })
      )
      useChatStore.setState({ conversation: updated })
    } catch (e) {
      useUiStore.getState().toast(`Could not toggle plan mode: ${toNormalized(e).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className={`btn btn-ghost code-plan-toggle${active ? ' active' : ''}`}
      title="Plan mode: the assistant investigates read-only and presents a plan before making changes"
      aria-pressed={active}
      disabled={busy}
      onClick={() => void toggle()}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3 2.5h10v11H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      Plan mode{active ? ' on' : ''}
    </button>
  )
}

/**
 * Toggles auto-accept edits on the open conversation (params.autoAcceptEdits).
 * While on, edit_file/write_file run without the per-call approval dialog;
 * every other tool still asks. Ignored while plan mode is active.
 */
function AutoAcceptEditsToggle(): ReactElement | null {
  const conversation = useChatStore((s) => s.conversation)
  const [busy, setBusy] = useState(false)
  if (!conversation) return null
  const active = conversation.params.autoAcceptEdits === true

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      const params: ChatParams = { ...conversation.params }
      if (active) delete params.autoAcceptEdits
      else params.autoAcceptEdits = true
      const updated = await unwrap(
        window.uld.conversations.update({ id: conversation.id, patch: { params } })
      )
      useChatStore.setState({ conversation: updated })
    } catch (e) {
      useUiStore
        .getState()
        .toast(`Could not toggle auto-accept edits: ${toNormalized(e).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className={`btn btn-ghost code-plan-toggle${active ? ' active' : ''}`}
      title="Auto-accept edits: file edits apply without the per-call approval dialog (other tools still ask)"
      aria-pressed={active}
      disabled={busy}
      onClick={() => void toggle()}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M2.5 8.5l3.5 3.5 7-8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      Auto-accept edits{active ? ' on' : ''}
    </button>
  )
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
  )
}

/**
 * Code mode layout: project tree (left), the unchanged chat experience
 * (center) and proposed changes (right, collapsible). Rendered by the app
 * shell whenever the open conversation has mode 'code'.
 */
export default function CodeView(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const project = useCodeStore((s) => s.project)
  const proposedCount = useCodeStore(
    (s) => s.changes.filter((c) => c.status === 'proposed').length
  )
  const [changesOpen, setChangesOpen] = useState(true)

  const conversationId = conversation?.id ?? null
  const projectId = conversation?.projectId ?? null

  // Resolve the linked project whenever the conversation (or its projectId,
  // set by the grant flow) changes.
  useEffect(() => {
    if (!conversationId) {
      useCodeStore.getState().reset()
      return
    }
    const conv = useChatStore.getState().conversation
    if (conv && conv.id === conversationId) {
      void useCodeStore.getState().loadForConversation(conv)
    }
  }, [conversationId, projectId])

  // Refresh proposed changes AND the file tree each time a generation finishes:
  // the assistant may have proposed new diffs, and approved edit_file/write_file
  // calls have already written to disk, so the tree would otherwise stay stale
  // (e.g. still showing "This folder is empty" after files were created).
  useOnGenerationSettled(() => {
    void useCodeStore.getState().loadChanges()
    void useCodeStore.getState().loadTree()
  })

  return (
    <div className={`code-view ${changesOpen ? '' : 'code-view-collapsed'}`}>
      <aside className="code-pane code-pane-left" aria-label="Project files">
        {project && projectId ? (
          <>
            <ProjectHeader />
            <div className="code-tree-scroll">
              <FileTree />
            </div>
            <ContextFooter />
          </>
        ) : (
          <GrantPanel />
        )}
      </aside>

      <section className="code-pane code-pane-center" aria-label="Conversation">
        <div className="code-center-bar">
          <PlanModeToggle />
          <AutoAcceptEditsToggle />
          <TaskListStrip />
        </div>
        <ChatView />
      </section>

      <aside className="code-pane code-pane-right" aria-label="Proposed changes">
        {changesOpen ? (
          <>
            <button
              type="button"
              className="btn-icon code-changes-collapse"
              aria-label="Collapse changes panel"
              title="Collapse changes panel"
              onClick={() => setChangesOpen(false)}
            >
              ⟩
            </button>
            <ChangesPanel />
          </>
        ) : (
          <button
            type="button"
            className="code-changes-rail"
            aria-label={`Show proposed changes (${proposedCount})`}
            title="Show proposed changes"
            onClick={() => setChangesOpen(true)}
          >
            <span aria-hidden>⟨</span>
            {proposedCount > 0 && <span className="code-changes-rail-count">{proposedCount}</span>}
            <span className="code-changes-rail-label" aria-hidden>
              Changes
            </span>
          </button>
        )}
      </aside>

      <FilePreview />
    </div>
  )
}
