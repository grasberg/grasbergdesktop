/**
 * The Work panel: one right-side aside with on-demand tabs — Files (the
 * task's folder as a tree), Changes (reviewable code changes + git), Preview
 * (sandboxed .html rendering) and Tasks (goal + plans/checklists). Files and
 * Tasks are always offered; Changes needs a folder; Preview needs .html
 * files. Grant/ProjectHeader/ContextFooter moved from the old CodeView.
 */

import { useState, type ReactElement } from 'react'
import type { Attachment } from '@shared/types'
import { unwrap } from '@/api/uld'
import { toastError } from '@/stores/ui'
import { useChatStore } from '@/stores/chat'
import { useCodeStore } from '@/stores/code'
import { useSettingsStore } from '@/stores/settings'
import ChangesPanel from '@/components/code/ChangesPanel'
import FileTree from '@/components/code/FileTree'
import { grantFolderAccess } from './WorkControls'
import PreviewTab from './PreviewTab'
import TasksTab from './TasksTab'
import TerminalTab from './TerminalTab'
import ArenaTab from './ArenaTab'
import OptimizerTab from './OptimizerTab'
import { navigateGuarded, useUnsavedChanges } from '@/hooks/useUnsavedChanges'

export type WorkTab =
  | 'files'
  | 'changes'
  | 'preview'
  | 'terminal'
  | 'arena'
  | 'optimizer'
  | 'tasks'

function FolderIcon(): ReactElement {
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
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  )
}

/** Files tab without a folder: how files appear + connect-a-folder CTA. */
function NoFolderPanel(): ReactElement {
  const [granting, setGranting] = useState(false)
  return (
    <div className="code-grant">
      <FolderIcon />
      <p className="code-grant-copy">
        This task gets its own folder automatically when the assistant creates files. To work on
        an existing folder, connect one now.
      </p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={granting}
        onClick={() => {
          setGranting(true)
          void grantFolderAccess().finally(() => setGranting(false))
        }}
      >
        {granting ? 'Opening…' : 'Connect a folder…'}
      </button>
      <p className="code-grant-hint">
        Files are only ever written through approved edits or an explicit Apply click.
      </p>
    </div>
  )
}

function ProjectHeader(): ReactElement | null {
  const project = useCodeStore((s) => s.project)
  const [changing, setChanging] = useState(false)
  if (!project) return null

  const reveal = (): void => {
    void unwrap(window.uld.code.projectReveal(project.id)).catch((e: unknown) =>
      toastError('Could not open the folder', e)
    )
  }

  return (
    <header className="code-project-header">
      <div className="code-project-name" title={project.path}>
        {project.autoCreated ? 'Task workspace' : project.name}
      </div>
      <button
        type="button"
        className="btn btn-ghost code-project-change"
        title="Show this folder in the file explorer"
        onClick={reveal}
      >
        Show in Explorer
      </button>
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
 * Files-tab footer: shows how many files are checked in the tree and offers
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

  const guard = useUnsavedChanges(formOpen && !!question.trim())

  if (selectedPaths.length === 0) return null

  const sendNow = async (attachments: Attachment[]): Promise<void> => {
    setBusy(true)
    try {
      if (!await useChatStore.getState().send(question.trim(), attachments)) return
      guard.markSaved()
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
        <button type="button" className="btn-icon" aria-label="Clear selection" onClick={() => guard.discard(clearSelection)}>
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
            <button type="button" className="btn btn-ghost" onClick={() => guard.discard(() => { setFormOpen(false); setQuestion('') })}>
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

function FilesTab(): ReactElement {
  const project = useCodeStore((s) => s.project)
  if (!project) return <NoFolderPanel />
  return (
    <>
      <ProjectHeader />
      <div className="code-tree-scroll">
        <FileTree />
      </div>
      <ContextFooter />
    </>
  )
}

export default function WorkPanel({
  activeTab,
  onTab,
  onCollapse,
  hasProject,
  htmlFiles,
  selectedHtml,
  onSelectHtml,
  htmlReloadKey,
  projectId,
}: {
  activeTab: WorkTab
  onTab: (tab: WorkTab) => void
  onCollapse: () => void
  hasProject: boolean
  htmlFiles: string[]
  selectedHtml: string | null
  onSelectHtml: (relPath: string) => void
  htmlReloadKey: number
  projectId: string | null
}): ReactElement {
  const proposedCount = useCodeStore(
    (s) => s.changes.filter((c) => c.status === 'proposed').length
  )

  const tabs: Array<{ key: WorkTab; label: string; badge?: number }> = [
    { key: 'files', label: 'Files' },
    ...(hasProject
      ? [{ key: 'changes' as const, label: 'Changes', badge: proposedCount || undefined }]
      : []),
    ...(htmlFiles.length > 0 ? [{ key: 'preview' as const, label: 'Preview' }] : []),
    ...(hasProject ? [{ key: 'terminal' as const, label: 'Terminal' }] : []),
    ...(hasProject ? [{ key: 'arena' as const, label: 'Arena' }] : []),
    ...(hasProject ? [{ key: 'optimizer' as const, label: 'Optimizer' }] : []),
    { key: 'tasks', label: 'Tasks' },
  ]
  const active = tabs.some((t) => t.key === activeTab) ? activeTab : 'files'

  return (
    <aside className="work-panel" aria-label="Workspace panel">
      <header className="work-panel-header">
        <div className="work-tabs" role="tablist" aria-label="Workspace sections">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active === tab.key}
              className={`work-tab${active === tab.key ? ' active' : ''}`}
              onClick={() => { if (active !== tab.key) navigateGuarded(() => onTab(tab.key), 'page') }}
            >
              {tab.label}
              {tab.badge ? <span className="work-tab-badge">{tab.badge}</span> : null}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn-icon"
          aria-label="Hide workspace panel"
          aria-expanded={true}
          title="Hide workspace panel"
          onClick={() => navigateGuarded(onCollapse, 'page')}
        >
          »
        </button>
      </header>

      <div className="work-panel-body">
        {active === 'files' ? <FilesTab /> : null}
        {active === 'changes' ? <ChangesPanel /> : null}
        {active === 'preview' && projectId ? (
          <PreviewTab
            projectId={projectId}
            files={htmlFiles}
            selected={selectedHtml}
            onSelect={onSelectHtml}
            reloadKey={htmlReloadKey}
          />
        ) : null}
        {active === 'terminal' ? <TerminalTab /> : null}
        {active === 'arena' ? <ArenaTab /> : null}
        {active === 'optimizer' ? <OptimizerTab projectId={projectId} /> : null}
        {active === 'tasks' ? <TasksTab /> : null}
      </div>
    </aside>
  )
}
