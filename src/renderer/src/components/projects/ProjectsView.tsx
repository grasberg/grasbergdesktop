/**
 * Projects overview: every cowork workspace and every code project folder the
 * user has granted, in one place. Reached from the sidebar "Projects" link;
 * replaces the main area like WorkflowsView does.
 */

import { useEffect, useState } from 'react'
import type { CodeProject, ConversationMode, Workspace } from '@shared/types'
import { useConversationsStore } from '@/stores/conversations'
import { toastError, useUiStore } from '@/stores/ui'
import './projects.css'

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function ProjectsView(): React.JSX.Element {
  const openProjects = useUiStore((s) => s.openProjects)
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null)
  const [codeProjects, setCodeProjects] = useState<CodeProject[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.uld.workspaces.list().then((res) => {
      if (!cancelled) setWorkspaces(res.ok ? res.data : [])
    })
    void window.uld.code.projectsList().then((res) => {
      if (!cancelled) setCodeProjects(res.ok ? res.data : [])
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** Starts a fresh conversation in the given mode and returns to it. */
  const startConversation = (mode: ConversationMode): void => {
    useConversationsStore
      .getState()
      .create(mode)
      .then(() => openProjects(false))
      .catch((e: unknown) => {
        toastError('Could not create conversation', e)
      })
  }

  const sortedWorkspaces = (workspaces ?? [])
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const sortedCodeProjects = (codeProjects ?? [])
    .slice()
    .sort((a, b) => (b.lastOpenedAt ?? b.approvedAt) - (a.lastOpenedAt ?? a.approvedAt))

  return (
    <div className="projects">
      <header className="projects-header">
        <button type="button" className="btn-icon" aria-label="Back" onClick={() => openProjects(false)}>
          ←
        </button>
        <h2 className="projects-title">Projects</h2>
      </header>

      <div className="projects-body">
        <section aria-label="Cowork workspaces">
          <div className="projects-section-head">
            <h4 className="section-subhead">Cowork workspaces</h4>
            <button type="button" className="btn btn-ghost" onClick={() => startConversation('cowork')}>
              New workspace
            </button>
          </div>
          {workspaces === null ? (
            <p className="projects-empty">Loading…</p>
          ) : sortedWorkspaces.length === 0 ? (
            <p className="projects-empty">
              No workspaces yet. Start a Cowork conversation to create one.
            </p>
          ) : (
            <ul className="projects-list">
              {sortedWorkspaces.map((w) => (
                <li key={w.id} className="project-card">
                  <div className="project-card-main">
                    <span className="project-card-name">{w.name}</span>
                    <span className="project-card-meta">
                      {w.status}
                      {w.goal ? ` · ${w.goal}` : ''}
                    </span>
                  </div>
                  <span className="project-card-time">{formatDate(w.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Code projects">
          <div className="projects-section-head">
            <h4 className="section-subhead">Code projects</h4>
            <button type="button" className="btn btn-ghost" onClick={() => startConversation('code')}>
              New code session
            </button>
          </div>
          {codeProjects === null ? (
            <p className="projects-empty">Loading…</p>
          ) : sortedCodeProjects.length === 0 ? (
            <p className="projects-empty">
              No code projects yet. Open a folder from a Code session to add one.
            </p>
          ) : (
            <ul className="projects-list">
              {sortedCodeProjects.map((p) => (
                <li key={p.id} className="project-card">
                  <div className="project-card-main">
                    <span className="project-card-name">{p.name}</span>
                    <span className="project-card-meta">{p.path}</span>
                  </div>
                  <span className="project-card-time">
                    {formatDate(p.lastOpenedAt ?? p.approvedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
