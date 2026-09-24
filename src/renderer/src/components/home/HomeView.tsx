/**
 * Home overview — the app's landing surface: scheduled workflows with live
 * status (top-left, the headline card), recent runs, recent work across every
 * mode, projects, and quick actions. Every card links deeper into the surface
 * it summarizes.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ConversationSummary, Project } from '@shared/types'
import { errorMessage, unwrap } from '@/api/uld'
import { modKeyLabel } from '@/lib/platform'
import { useWorkflowsStore } from '@/stores/workflows'
import { useProjectsStore } from '@/stores/projects'
import BriefCard from './BriefCard'
import GettingStartedCard from './GettingStartedCard'
import ScheduledCard from './ScheduledCard'
import InboxCard from './InboxCard'
import NotesCard from './NotesCard'
import RecentRunsCard from './RecentRunsCard'
import RecentWorkCard from './RecentWorkCard'
import ProjectsCard from './ProjectsCard'
import QuickActionsCard from './QuickActionsCard'
import appIcon from '@/assets/icon.png'
import './home.css'

const RECENT_WORK_LIMIT = 10

export default function HomeView(): React.JSX.Element {
  // Keep the cross-mode overview fresh when projects are edited in the sidebar.
  // Fetch all modes; the sidebar's list itself contains only the selected mode.
  const sidebarProjects = useProjectsStore((s) => s.projects)
  const [recent, setRecent] = useState<ConversationSummary[] | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    // Freshness refresh for the shared overview (boot already loaded it).
    void useWorkflowsStore.getState().load()
    void (async () => {
      try {
        const [recentWork, allProjects] = await Promise.allSettled([
          unwrap(window.uld.conversations.list({ limit: RECENT_WORK_LIMIT })),
          unwrap(window.uld.projects.list()),
        ])
        if (cancelled) return
        if (recentWork.status === 'fulfilled') setRecent(recentWork.value)
        if (allProjects.status === 'fulfilled') setProjects(allProjects.value)
        setLoadError(recentWork.status === 'rejected' ? errorMessage(recentWork.reason) : allProjects.status === 'rejected' ? errorMessage(allProjects.reason) : null)
      } catch (e) {
        if (cancelled) return
        setLoadError(errorMessage(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sidebarProjects, reload])

  const projectNameById = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p.name])),
    [projects]
  )

  return (
    <div className="home">
      {loadError && <div className="callout" role="alert">Could not refresh the overview: {loadError} <button className="btn" onClick={() => setReload(n => n + 1)}>Retry</button></div>}
      <header className="home-header">
        <img src={appIcon} width={40} height={40} alt="" aria-hidden="true" draggable={false} />
        <div className="home-header-text">
          <h1 className="home-title">Grasberg</h1>
          <p className="home-subtitle">
            Your conversations, bots and work — with the models you choose.
          </p>
        </div>
        <span className="home-kbd-hint">
          <span className="kbd">{modKeyLabel}</span>
          <span className="kbd">K</span> commands
        </span>
      </header>
      <div className="home-grid">
        <QuickActionsCard />
        <BriefCard />
        <GettingStartedCard recent={recent} />
        <ScheduledCard />
        <InboxCard />
        <NotesCard />
        <RecentRunsCard />
        <RecentWorkCard items={recent} projectNameById={projectNameById} />
        <ProjectsCard projects={projects} />
      </div>
    </div>
  )
}
