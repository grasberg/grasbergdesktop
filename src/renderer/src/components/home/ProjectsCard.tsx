/**
 * All organizational projects across every mode. Clicking one switches the
 * sidebar to that mode and expands the project's group there (Home stays on
 * screen — the sidebar is the project's own surface).
 */

import type { ConversationMode, Project } from '@shared/types'
import { useConversationsStore } from '@/stores/conversations'
import { useProjectsStore } from '@/stores/projects'

const MODE_LABELS: Record<ConversationMode, string> = {
  chat: 'Chat',
  work: 'Work',
}

const SHOWN = 8

export default function ProjectsCard({
  projects,
}: {
  /** null while loading. */
  projects: Project[] | null
}): React.JSX.Element {
  const reveal = (project: Project): void => {
    useConversationsStore.getState().setModeFilter(project.mode)
    useProjectsStore.getState().expand(project.id)
  }

  return (
    <section className="card home-card" aria-label="Projects">
      <div className="home-card-head">
        <h2 className="home-card-title">Projects</h2>
      </div>
      {projects === null ? (
        <div aria-hidden="true">
          <div className="home-skeleton" />
        </div>
      ) : projects.length === 0 ? (
        <div className="home-empty">
          <p>No projects yet — create one with the + next to “Projects &amp; tasks”.</p>
        </div>
      ) : (
        <>
          <ul className="home-list">
            {projects.slice(0, SHOWN).map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  className="home-row-btn"
                  title={`Show "${project.name}" in the sidebar`}
                  onClick={() => reveal(project)}
                >
                  <span className="badge">{MODE_LABELS[project.mode]}</span>
                  <span className="home-row-main">
                    <span className="home-row-title">{project.name}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {projects.length > SHOWN ? (
            <div className="home-more">+{projects.length - SHOWN} more in the sidebar</div>
          ) : null}
        </>
      )}
    </section>
  )
}
