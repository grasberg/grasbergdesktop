import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { ConvUpdateRequest } from '@shared/ipc'
import type { Attachment } from '@shared/types'
import ChatView from '@/components/chat/ChatView'
import { toNormalized, unwrap } from '@/api/uld'
import { useChatStore } from '@/stores/chat'
import { useCodeStore } from '@/stores/code'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import ChangesPanel from './ChangesPanel'
import FilePreview from './FilePreview'
import FileTree from './FileTree'
import './code.css'

/** convUpdate patch extended with projectId (accepted by newer main builds). */
type PatchWithProject = ConvUpdateRequest['patch'] & { projectId?: string | null }

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
 * conversation. Defensive: older main builds may not support projectOpen or
 * a projectId patch — both paths degrade to a toast.
 */
async function grantFolderAccess(): Promise<void> {
  const conversation = useChatStore.getState().conversation
  if (!conversation) return
  const project = await useCodeStore.getState().openProjectViaPicker()
  if (!project) return
  try {
    const patch: PatchWithProject = { projectId: project.id }
    await unwrap(window.uld.conversations.update({ id: conversation.id, patch }))
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
 * Code mode layout: project tree (left), the unchanged chat experience
 * (center) and proposed changes (right, collapsible). Rendered by the app
 * shell whenever the open conversation has mode 'code'.
 */
export default function CodeView(): ReactElement {
  const conversation = useChatStore((s) => s.conversation)
  const streaming = useChatStore((s) => s.streaming)
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

  // Refresh proposed changes each time a generation finishes (streaming
  // transitions non-null -> null): the assistant may have proposed new diffs.
  const prevStreaming = useRef(streaming)
  useEffect(() => {
    const finished = prevStreaming.current !== null && streaming === null
    prevStreaming.current = streaming
    if (finished) void useCodeStore.getState().loadChanges()
  }, [streaming])

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
