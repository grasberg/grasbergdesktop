/**
 * Groups a mode's tasks (conversations) under their organizational projects for
 * the sidebar's grouped tree. Pure and side-effect free (no runtime deps) so it
 * lives in `shared` and can be unit-tested in isolation.
 *
 * Projects are emitted in the order given (the repository already returns them
 * newest-first). Tasks keep their input order within each group (the repository
 * returns them `updated_at DESC`). Tasks whose `projectRef` does not match any
 * given project — including unfiled ones (`projectRef === null`) — land in
 * `noProject`, so a task never silently disappears if its project was just
 * deleted mid-render.
 */

import type { ConversationSummary, Project } from './types'

export interface TaskGroup {
  project: Project
  tasks: ConversationSummary[]
}

export interface GroupedTasks {
  /** One entry per project, in project order. Projects with no tasks appear empty. */
  groups: TaskGroup[]
  /** Tasks with no (or an unknown) project. Shown in the "No project" group. */
  noProject: ConversationSummary[]
}

export function groupTasks(projects: Project[], summaries: ConversationSummary[]): GroupedTasks {
  const byId = new Map<string, ConversationSummary[]>()
  for (const project of projects) byId.set(project.id, [])

  const noProject: ConversationSummary[] = []
  for (const summary of summaries) {
    const bucket = summary.projectRef !== null ? byId.get(summary.projectRef) : undefined
    if (bucket) bucket.push(summary)
    else noProject.push(summary)
  }

  const groups = projects.map((project) => ({
    project,
    tasks: byId.get(project.id) ?? [],
  }))

  return { groups, noProject }
}
