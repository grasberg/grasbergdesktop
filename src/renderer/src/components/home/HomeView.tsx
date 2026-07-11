/**
 * Home overview — the app's landing surface: scheduled workflows with live
 * status (top-left, the headline card), recent runs, recent work across every
 * mode, projects, and quick actions. Every card links deeper into the surface
 * it summarizes.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ConversationSummary, Project } from '@shared/types'
import { unwrap } from '@/api/uld'
import { modKeyLabel } from '@/lib/platform'
import { useWorkflowsStore } from '@/stores/workflows'
import ScheduledCard from './ScheduledCard'
import RecentRunsCard from './RecentRunsCard'
import RecentWorkCard from './RecentWorkCard'
import ProjectsCard from './ProjectsCard'
import QuickActionsCard from './QuickActionsCard'
import appIcon from '@/assets/icon.png'
import './home.css'

const RECENT_WORK_LIMIT = 10

export default function HomeView(): React.JSX.Element {
  // Cross-mode lists used only here: fetched per mount, independent of the
  // (mode-scoped, 300-row) sidebar store.
  const [recent, setRecent] = useState<ConversationSummary[] | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)

  useEffect(() => {
    let cancelled = false
    // Freshness refresh for the shared overview (boot already loaded it).
    void useWorkflowsStore.getState().load()
    void (async () => {
      try {
        const [recentWork, allProjects] = await Promise.all([
          unwrap(window.uld.conversations.list({ limit: RECENT_WORK_LIMIT })),
          unwrap(window.uld.projects.list()),
        ])
        if (cancelled) return
        setRecent(recentWork)
        setProjects(allProjects)
      } catch {
        // Cards degrade to their empty states; the sidebar already toasts
        // load failures for conversations.
        if (cancelled) return
        setRecent([])
        setProjects([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const projectNameById = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p.name])),
    [projects]
  )

  return (
    <div className="home">
      <header className="home-header">
        <img src={appIcon} width={40} height={40} alt="" aria-hidden="true" draggable={false} />
        <div className="home-header-text">
          <h1 className="home-title">Grasberg</h1>
          <p className="home-subtitle">
            One local-first home for DeepSeek, GLM, MiniMax and any OpenAI-compatible model.
          </p>
        </div>
        <span className="home-kbd-hint">
          <span className="kbd">{modKeyLabel}</span>
          <span className="kbd">K</span> commands
        </span>
      </header>
      <div className="home-grid">
        <ScheduledCard />
        <RecentRunsCard />
        <RecentWorkCard items={recent} projectNameById={projectNameById} />
        <ProjectsCard projects={projects} />
        <QuickActionsCard />
      </div>
    </div>
  )
}
