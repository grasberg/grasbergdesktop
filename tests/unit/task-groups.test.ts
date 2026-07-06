import { describe, expect, it } from 'vitest'
import type { ConversationSummary, Project } from '@shared/types'
import { groupTasks } from '@shared/task-groups'

function project(id: string, name = id): Project {
  return { id, mode: 'chat', name, createdAt: 0, updatedAt: 0 }
}

function task(id: string, projectRef: string | null): ConversationSummary {
  return { id, mode: 'chat', title: id, updatedAt: 0, projectRef, snippet: null }
}

describe('groupTasks', () => {
  it('buckets tasks under their project, in project order', () => {
    const projects = [project('p1'), project('p2')]
    const summaries = [task('a', 'p1'), task('b', 'p2'), task('c', 'p1')]

    const { groups, noProject } = groupTasks(projects, summaries)

    expect(groups.map((g) => g.project.id)).toEqual(['p1', 'p2'])
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(['a', 'c'])
    expect(groups[1]?.tasks.map((t) => t.id)).toEqual(['b'])
    expect(noProject).toHaveLength(0)
  })

  it('preserves the input order of tasks within a group', () => {
    const projects = [project('p1')]
    const summaries = [task('newest', 'p1'), task('older', 'p1'), task('oldest', 'p1')]

    const { groups } = groupTasks(projects, summaries)

    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(['newest', 'older', 'oldest'])
  })

  it('collects unfiled tasks into noProject', () => {
    const { groups, noProject } = groupTasks(
      [project('p1')],
      [task('a', 'p1'), task('b', null), task('c', null)]
    )

    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(['a'])
    expect(noProject.map((t) => t.id)).toEqual(['b', 'c'])
  })

  it('emits an empty bucket for a project with no tasks', () => {
    const { groups } = groupTasks([project('p1'), project('empty')], [task('a', 'p1')])

    expect(groups[1]?.project.id).toBe('empty')
    expect(groups[1]?.tasks).toHaveLength(0)
  })

  it('treats a task whose project is unknown (e.g. just deleted) as unfiled', () => {
    const { groups, noProject } = groupTasks([project('p1')], [task('a', 'gone')])

    expect(groups[0]?.tasks).toHaveLength(0)
    expect(noProject.map((t) => t.id)).toEqual(['a'])
  })
})
