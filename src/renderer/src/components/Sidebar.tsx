import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationMode, ConversationSummary, Project } from '@shared/types'
import { newConversation } from '@/lib/new-conversation'
import { groupTasks } from '@shared/task-groups'
import { relativeTime } from '@/lib/format'
import { modKeyLabel } from '@/lib/platform'
import { botsAttentionSummary, useBotsStore } from '@/stores/bots'
import { useConversationsStore } from '@/stores/conversations'
import { useProjectsStore } from '@/stores/projects'
import { useSpacesStore } from '@/stores/spaces'
import { toastError, useUiStore } from '@/stores/ui'
import appIcon from '@/assets/icon.png'

/** Collapse key for the catch-all standalone Tasks group. */
const NO_PROJECT_KEY = '__no_project__'
/** Sentinel value for the switcher's "Manage spaces…" entry. */
const MANAGE_SPACES_VALUE = '__manage__'
const NO_PROJECT_LABEL = 'Tasks'

const MODE_TABS: ReadonlyArray<{ key: ConversationMode; label: string }> = [
  { key: 'chat', label: 'Chat' },
  { key: 'work', label: 'Work' },
]

/** Human label for the "New task" caret menu, per mode. */
const NEW_LABELS: Record<ConversationMode, string> = {
  chat: 'New chat',
  work: 'New work task',
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
                        {NO_PROJECT_LABEL}
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
  /** The project this group represents, or null for the standalone Tasks group. */
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
            <span className="task-group-name">{project ? project.name : NO_PROJECT_LABEL}</span>
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
  const view = useUiStore((s) => s.view)
  const roster = useBotsStore((s) => s.roster)
  const botsAttention = useMemo(() => (roster ? botsAttentionSummary(roster) : null), [roster])
  const spaces = useSpacesStore((s) => s.spaces)
  const activeSpaceId = useSpacesStore((s) => s.activeSpaceId)
  const [query, setQuery] = useState(useConversationsStore.getState().search)

  // Load this mode's projects on mount and whenever the current mode changes.
  useEffect(() => {
    void useProjectsStore.getState().load(modeFilter)
  }, [modeFilter])

  // Spaces feed the switcher; cheap and only re-fetched on mount.
  useEffect(() => {
    void useSpacesStore.getState().load()
  }, [])

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

  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const newProjectRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creatingProject) newProjectRef.current?.focus()
  }, [creatingProject])

  const startConversation = (mode: ConversationMode): void => {
    // A standalone task is filed under "Tasks". Make sure its new row is
    // immediately visible in the sidebar even when that group was collapsed.
    useProjectsStore.getState().expand(NO_PROJECT_KEY)
    newConversation(mode)
  }

  const startProject = (): void => {
    setNewProjectName('')
    setCreatingProject(true)
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
    <nav className={`sidebar sidebar-mode-${modeFilter}`} aria-label="Conversations">
      <div className="sidebar-brand">
        <Logo />
        <span className="sidebar-wordmark">Grasberg</span>
        <button
          type="button"
          className={`btn-icon sidebar-home-btn${view === 'home' ? ' active' : ''}`}
          aria-label="Home overview"
          aria-current={view === 'home' ? 'page' : undefined}
          title="Home"
          onClick={() => useUiStore.getState().setView('home')}
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
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
          </svg>
        </button>
        <button
          type="button"
          className={`btn-icon sidebar-home-btn${view === 'bots' ? ' active' : ''}`}
          aria-label={
            botsAttention && botsAttention.needsYou + botsAttention.unread > 0
              ? `Bots — ${botsAttention.needsYou + botsAttention.unread} need attention`
              : 'Bots'
          }
          aria-current={view === 'bots' ? 'page' : undefined}
          title={
            botsAttention && botsAttention.needsYou > 0
              ? `Bots · ${botsAttention.needsYou} need you`
              : botsAttention && botsAttention.unread > 0
                ? `Bots · ${botsAttention.unread} unread`
                : botsAttention && botsAttention.working > 0
                  ? `Bots · ${botsAttention.working} working`
                  : 'Bots'
          }
          onClick={() => useUiStore.getState().setView('bots')}
        >
          {botsAttention && botsAttention.needsYou + botsAttention.unread > 0 ? (
            <span
              className={`sidebar-bots-badge${botsAttention.needsYou > 0 ? ' is-needs-you' : ''}`}
              aria-hidden="true"
            >
              {Math.min(99, botsAttention.needsYou + botsAttention.unread)}
            </span>
          ) : botsAttention && botsAttention.working > 0 ? (
            <span className="sidebar-bots-working" aria-hidden="true" />
          ) : null}
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
            <rect x="5" y="8" width="14" height="11" rx="2" />
            <path d="M12 8V4" />
            <circle cx="12" cy="3" r="1" />
            <circle cx="9.5" cy="13" r="0.5" />
            <circle cx="14.5" cy="13" r="0.5" />
            <path d="M9.5 16.5h5" />
          </svg>
        </button>
        <button className="btn-icon sidebar-clock-btn" aria-label="Automation" title="Automation — scheduled tasks, bot routines and workflows" onClick={() => useUiStore.getState().setView('automation')}>◷</button>
      </div>

      <div className="sidebar-controls">
        {spaces.length > 0 ? (
          <select
            className={`input sidebar-space-switcher${activeSpaceId ? ' space-private' : ''}`}
            aria-label="Space"
            value={activeSpaceId ?? ''}
            onChange={(e) => {
              const value = e.target.value
              if (value === MANAGE_SPACES_VALUE) {
                useUiStore.getState().openSettings(true)
                return
              }
              useSpacesStore.getState().setActive(value === '' ? null : value)
            }}
          >
            <option value="">Default space</option>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {`🔒 ${space.name}`}
              </option>
            ))}
            <option value={MANAGE_SPACES_VALUE}>Manage spaces…</option>
          </select>
        ) : null}
        <input
          type="search"
          className="input sidebar-search"
          placeholder="Search conversations…"
          aria-label="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="mode-tabs" role="tablist" aria-label="Current mode">
          {MODE_TABS.map((tab) => {
            const active = modeFilter === tab.key
            return (
              <div
                key={tab.key}
                data-mode={tab.key}
                className={`mode-tab-item${active ? ' active' : ''}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="mode-tab"
                  onClick={() => useConversationsStore.getState().setModeFilter(tab.key)}
                >
                  {tab.label}
                </button>
                <button
                  type="button"
                  className="mode-tab-add"
                  aria-label={NEW_LABELS[tab.key]}
                  title={NEW_LABELS[tab.key]}
                  onClick={() => startConversation(tab.key)}
                >
                  {PlusIcon}
                </button>
              </div>
            )
          })}
        </div>
        <div className="mode-quick-actions" aria-label={`${modeFilter} actions`}>
          <button type="button" className="mode-quick-action" onClick={startProject}>
            {PlusIcon}
            New project
          </button>
          <button
            type="button"
            className="mode-quick-action"
            onClick={() => startConversation(modeFilter)}
          >
            {PlusIcon}
            New Task
          </button>
        </div>
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

      <div className="sidebar-footer">
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
