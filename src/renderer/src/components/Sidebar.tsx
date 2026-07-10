import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationMode, ConversationSummary, Project } from '@shared/types'
import { newConversation, newTaskInActiveMode } from '@/lib/new-conversation'
import { groupTasks } from '@shared/task-groups'
import { relativeTime } from '@/lib/format'
import { modKeyLabel } from '@/lib/platform'
import ScheduledTasks from '@/components/ScheduledTasks'
import { useConversationsStore } from '@/stores/conversations'
import { useProjectsStore } from '@/stores/projects'
import { toastError, useUiStore } from '@/stores/ui'
import appIcon from '@/assets/icon.png'

/** Collapse key for the catch-all "No project" group. */
const NO_PROJECT_KEY = '__no_project__'

const MODE_TABS: ReadonlyArray<{ key: ConversationMode; label: string }> = [
  { key: 'chat', label: 'Chat' },
  { key: 'cowork', label: 'Cowork' },
  { key: 'code', label: 'Code' },
  { key: 'write', label: 'Write' },
  { key: 'design', label: 'Design' },
]

/** Human label for the "New task" caret menu, per mode. */
const NEW_LABELS: Record<ConversationMode, string> = {
  chat: 'New chat',
  cowork: 'New cowork workspace',
  code: 'New code session',
  write: 'New document (Write)',
  design: 'New design',
}

/** The real app icon (same asset as the packaged exe/dock icon). */
function Logo({ size = 22 }: { size?: number }): React.JSX.Element {
  return (
    <img
      src={appIcon}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: 'block' }}
    />
  )
}

const PlusIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

const ChevronIcon = (
  <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M6 4l4 4-4 4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const PencilIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M11.3 1.7a1.7 1.7 0 0 1 2.4 2.4l-8.2 8.2-3.2.8.8-3.2 8.2-8.2Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </svg>
)

const TrashIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.5 6.8v4M9.5 6.8v4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
)

const FolderIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M1.8 3.5h4.4l1.5 1.8h6.5a.7.7 0 0 1 .7.7v6.3a.7.7 0 0 1-.7.7H1.8a.7.7 0 0 1-.7-.7V4.2a.7.7 0 0 1 .7-.7Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
)

interface RowProps {
  summary: ConversationSummary
  active: boolean
  projects: Project[]
}

function ConversationRow({ summary, active, projects }: RowProps): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(summary.title)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const moveRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  // Close the move-to-project menu on outside click / Escape.
  useEffect(() => {
    if (!moveOpen) return
    const onDown = (e: MouseEvent): void => {
      if (moveRef.current && !moveRef.current.contains(e.target as Node)) setMoveOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setMoveOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [moveOpen])

  const commitRename = (): void => {
    setRenaming(false)
    const next = title.trim()
    if (!next || next === summary.title) {
      setTitle(summary.title)
      return
    }
    useConversationsStore
      .getState()
      .rename(summary.id, next)
      .catch((e: unknown) => {
        setTitle(summary.title)
        toastError('Rename failed', e)
      })
  }

  const doDelete = (): void => {
    setConfirmingDelete(false)
    useConversationsStore
      .getState()
      .remove(summary.id)
      .catch((e: unknown) => {
        toastError('Delete failed', e)
      })
  }

  const moveTo = (projectRef: string | null): void => {
    setMoveOpen(false)
    if (projectRef === summary.projectRef) return
    useConversationsStore
      .getState()
      .setProject(summary.id, projectRef)
      .catch((e: unknown) => {
        toastError('Could not move the task', e)
      })
  }

  return (
    <li className={`conv-item${active ? ' active' : ''}`}>
      {renaming ? (
        <input
          ref={inputRef}
          className="input conv-rename-input"
          value={title}
          aria-label="Conversation title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitRename()
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              setTitle(summary.title)
              setRenaming(false)
            }
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="conv-item-main"
            onClick={() => {
              // Leave the Workflows surface so the conversation shows.
              useUiStore.getState().openWorkflows(false)
              useConversationsStore.getState().select(summary.id)
            }}
            aria-current={active ? 'true' : undefined}
          >
            <span className="conv-item-top">
              <span className="conv-title">{summary.title}</span>
              <span className="conv-time">{relativeTime(summary.updatedAt)}</span>
            </span>
            {summary.snippet ? <span className="conv-snippet">{summary.snippet}</span> : null}
          </button>
          {confirmingDelete ? (
            <span className="conv-confirm" role="alert">
              <span className="conv-confirm-label">Delete?</span>
              <button type="button" className="btn btn-danger conv-confirm-btn" onClick={doDelete}>
                Yes
              </button>
              <button
                type="button"
                className="btn btn-ghost conv-confirm-btn"
                onClick={() => setConfirmingDelete(false)}
              >
                No
              </button>
            </span>
          ) : (
            <span className="conv-actions">
              {projects.length > 0 ? (
                <span className="conv-move" ref={moveRef}>
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label={`Move ${summary.title} to a project`}
                    aria-haspopup="menu"
                    aria-expanded={moveOpen}
                    title="Move to project"
                    onClick={() => setMoveOpen((v) => !v)}
                  >
                    {FolderIcon}
                  </button>
                  {moveOpen ? (
                    <div className="conv-move-menu" role="menu" aria-label="Move to project">
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={summary.projectRef === null}
                        className={`conv-move-item${summary.projectRef === null ? ' active' : ''}`}
                        onClick={() => moveTo(null)}
                      >
                        No project
                      </button>
                      {projects.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={summary.projectRef === p.id}
                          className={`conv-move-item${summary.projectRef === p.id ? ' active' : ''}`}
                          onClick={() => moveTo(p.id)}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </span>
              ) : null}
              <button
                type="button"
                className="btn-icon"
                aria-label={`Rename conversation ${summary.title}`}
                title="Rename"
                onClick={() => {
                  setTitle(summary.title)
                  setRenaming(true)
                }}
              >
                {PencilIcon}
              </button>
              <button
                type="button"
                className="btn-icon"
                aria-label={`Delete conversation ${summary.title}`}
                title="Delete"
                onClick={() => setConfirmingDelete(true)}
              >
                {TrashIcon}
              </button>
            </span>
          )}
        </>
      )}
    </li>
  )
}

interface TaskGroupProps {
  /** The project this group represents, or null for the catch-all "No project". */
  project: Project | null
  tasks: ConversationSummary[]
  /** All projects in the mode (for a task row's move-to-project menu). */
  projects: Project[]
  activeId: string | null
  /** While searching, groups are force-expanded regardless of collapse state. */
  forceExpanded: boolean
}

function TaskGroup({
  project,
  tasks,
  projects,
  activeId,
  forceExpanded,
}: TaskGroupProps): React.JSX.Element {
  const groupKey = project ? project.id : NO_PROJECT_KEY
  const collapsedInStore = useProjectsStore((s) => s.collapsed.has(groupKey))
  const collapsed = forceExpanded ? false : collapsedInStore
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(project?.name ?? '')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  const toggle = (): void => useProjectsStore.getState().toggleCollapsed(groupKey)

  const addTask = (): void => {
    if (!project) return
    const mode = useConversationsStore.getState().modeFilter
    useProjectsStore.getState().expand(project.id)
    useUiStore.getState().openWorkflows(false)
    useConversationsStore
      .getState()
      .create(mode, project.id)
      .catch((e: unknown) => toastError('Could not create task', e))
  }

  const commitRename = (): void => {
    if (!project) return
    setRenaming(false)
    const next = name.trim()
    if (!next || next === project.name) {
      setName(project.name)
      return
    }
    useProjectsStore
      .getState()
      .rename(project.id, next)
      .catch((e: unknown) => {
        setName(project.name)
        toastError('Rename failed', e)
      })
  }

  const doDelete = (): void => {
    if (!project) return
    setConfirmingDelete(false)
    useProjectsStore
      .getState()
      .remove(project.id)
      .catch((e: unknown) => {
        toastError('Delete failed', e)
      })
  }

  return (
    <li className="task-group">
      {renaming && project ? (
        <div className="task-group-head">
          <input
            ref={inputRef}
            className="input conv-rename-input"
            value={name}
            aria-label="Project name"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitRename()
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                setName(project.name)
                setRenaming(false)
              }
            }}
          />
        </div>
      ) : (
        <div className="task-group-head">
          <button
            type="button"
            className="task-group-toggle-btn"
            aria-expanded={!collapsed}
            onClick={toggle}
          >
            <span className={`task-group-chevron${collapsed ? '' : ' open'}`}>{ChevronIcon}</span>
            <span className="task-group-name">{project ? project.name : 'No project'}</span>
            <span className="task-group-count">{tasks.length}</span>
          </button>
          {project ? (
            confirmingDelete ? (
              <span className="conv-confirm" role="alert">
                <span className="conv-confirm-label">Delete?</span>
                <button type="button" className="btn btn-danger conv-confirm-btn" onClick={doDelete}>
                  Yes
                </button>
                <button
                  type="button"
                  className="btn btn-ghost conv-confirm-btn"
                  onClick={() => setConfirmingDelete(false)}
                >
                  No
                </button>
              </span>
            ) : (
              <span className="conv-actions">
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={`New task in ${project.name}`}
                  title="New task in this project"
                  onClick={addTask}
                >
                  {PlusIcon}
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={`Rename project ${project.name}`}
                  title="Rename"
                  onClick={() => {
                    setName(project.name)
                    setRenaming(true)
                  }}
                >
                  {PencilIcon}
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={`Delete project ${project.name}`}
                  title="Delete (tasks are kept, just unfiled)"
                  onClick={() => setConfirmingDelete(true)}
                >
                  {TrashIcon}
                </button>
              </span>
            )
          ) : null}
        </div>
      )}
      {!collapsed ? (
        <ul className="task-group-list">
          {tasks.map((s) => (
            <ConversationRow key={s.id} summary={s} active={s.id === activeId} projects={projects} />
          ))}
          {tasks.length === 0 && project ? (
            <li className="task-group-empty">No tasks yet — use + to add one.</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  )
}

export default function Sidebar(): React.JSX.Element {
  const summaries = useConversationsStore((s) => s.summaries)
  const activeId = useConversationsStore((s) => s.activeId)
  const modeFilter = useConversationsStore((s) => s.modeFilter)
  const loaded = useConversationsStore((s) => s.loaded)
  const projects = useProjectsStore((s) => s.projects)
  const [query, setQuery] = useState(useConversationsStore.getState().search)

  // Load this mode's projects on mount and whenever the current mode changes.
  useEffect(() => {
    void useProjectsStore.getState().load(modeFilter)
  }, [modeFilter])

  // Debounced search -> store + reload.
  useEffect(() => {
    const timer = setTimeout(() => {
      const store = useConversationsStore.getState()
      if (store.search !== query) {
        store.setSearch(query)
        void store.load()
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const newProjectRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creatingProject) newProjectRef.current?.focus()
  }, [creatingProject])

  // Close the new-conversation menu on outside click / Escape.
  useEffect(() => {
    if (!newMenuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setNewMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [newMenuOpen])

  const startConversation = (mode: ConversationMode): void => {
    setNewMenuOpen(false)
    newConversation(mode)
  }

  /** New standalone (unfiled) task in the current mode. */
  const newTask = (): void => {
    setNewMenuOpen(false)
    newTaskInActiveMode()
  }

  const commitNewProject = (): void => {
    const name = newProjectName.trim()
    setCreatingProject(false)
    setNewProjectName('')
    if (!name) return
    useProjectsStore
      .getState()
      .create(modeFilter, name)
      .catch((e: unknown) => {
        toastError('Could not create the project', e)
      })
  }

  const searching = query.trim().length > 0
  const { groups, noProject } = useMemo(() => groupTasks(projects, summaries), [projects, summaries])
  // While searching, hide project groups that have no matching tasks.
  const visibleGroups = searching ? groups.filter((g) => g.tasks.length > 0) : groups

  return (
    <nav className="sidebar" aria-label="Conversations">
      <div className="sidebar-brand">
        <Logo />
        <span className="sidebar-wordmark">Grasberg</span>
      </div>

      <div className="sidebar-controls">
        <div className="sidebar-new-split" ref={newMenuRef}>
          <button
            type="button"
            className="btn btn-primary sidebar-new"
            title={`New task in ${modeFilter} (${modKeyLabel}+N)`}
            onClick={newTask}
          >
            {PlusIcon}
            New task
          </button>
          <button
            type="button"
            className="btn btn-primary sidebar-new-caret"
            aria-label="New conversation options"
            aria-haspopup="menu"
            aria-expanded={newMenuOpen}
            onClick={() => setNewMenuOpen(!newMenuOpen)}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 6l5 5 5-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {newMenuOpen ? (
            <div className="sidebar-new-menu" role="menu" aria-label="New conversation">
              {MODE_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="menuitem"
                  className="sidebar-new-item"
                  onClick={() => startConversation(tab.key)}
                >
                  {NEW_LABELS[tab.key]}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <input
          type="search"
          className="input sidebar-search"
          placeholder="Search conversations…"
          aria-label="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="mode-tabs" role="tablist" aria-label="Current mode">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={modeFilter === tab.key}
              className={`mode-tab${modeFilter === tab.key ? ' active' : ''}`}
              onClick={() => useConversationsStore.getState().setModeFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-section-head">
        <span className="sidebar-section-title">Projects &amp; tasks</span>
        <button
          type="button"
          className="btn-icon"
          aria-label="New project"
          title="New project"
          onClick={() => {
            setNewProjectName('')
            setCreatingProject(true)
          }}
        >
          {PlusIcon}
        </button>
      </div>

      <ul className="tree-list">
        {creatingProject ? (
          <li className="task-group">
            <div className="task-group-head">
              <input
                ref={newProjectRef}
                className="input conv-rename-input"
                value={newProjectName}
                placeholder="Project name"
                aria-label="New project name"
                onChange={(e) => setNewProjectName(e.target.value)}
                onBlur={commitNewProject}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitNewProject()
                  } else if (e.key === 'Escape') {
                    e.stopPropagation()
                    setCreatingProject(false)
                    setNewProjectName('')
                  }
                }}
              />
            </div>
          </li>
        ) : null}

        {visibleGroups.map((g) => (
          <TaskGroup
            key={g.project.id}
            project={g.project}
            tasks={g.tasks}
            projects={projects}
            activeId={activeId}
            forceExpanded={searching}
          />
        ))}

        {noProject.length > 0 ? (
          <TaskGroup
            key={NO_PROJECT_KEY}
            project={null}
            tasks={noProject}
            projects={projects}
            activeId={activeId}
            forceExpanded={searching}
          />
        ) : null}

        {loaded && summaries.length === 0 && searching ? (
          <li className="conv-empty">No conversations match “{query.trim()}”.</li>
        ) : loaded && summaries.length === 0 && projects.length === 0 && !creatingProject ? (
          <li className="conv-empty">No conversations yet. Start one with “New task”.</li>
        ) : null}
      </ul>

      <ScheduledTasks />

      <div className="sidebar-footer">
        <button
          type="button"
          className="btn-icon"
          aria-label="Open workflows"
          title="Workflows"
          onClick={() => useUiStore.getState().openWorkflows(true)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="6" height="6" rx="1" />
            <rect x="15" y="15" width="6" height="6" rx="1" />
            <path d="M9 6h5a2 2 0 0 1 2 2v4M15 18h-5a2 2 0 0 1-2-2v-4" />
          </svg>
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label="Open settings"
          title={`Settings (${modKeyLabel}+,)`}
          onClick={() => useUiStore.getState().openSettings(true)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <span className="sidebar-hint">
          <span className="kbd">{modKeyLabel}</span>
          <span className="kbd">K</span> commands
        </span>
      </div>
    </nav>
  )
}
