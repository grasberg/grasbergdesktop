/**
 * Shared encode/decode for the update_task_list wire format (no runtime deps).
 *
 * The executor persists the assistant's task list as a markdown checklist in
 * the 'Task list' workspace item; the renderer's TaskListStrip parses it back.
 * Both sides must agree byte-for-byte, so the format lives here:
 *
 *   - [ ] a pending task
 *   - [ ] the active task ⟵ in progress
 *   - [x] a completed task
 */

export type TaskListStatus = 'pending' | 'in_progress' | 'completed'

export interface TaskListItem {
  content: string
  status: TaskListStatus
}

/** Suffix marking the in-progress task (preceded by one space when encoded). */
export const TASK_IN_PROGRESS_MARKER = '⟵ in progress'

/** Parsed shape of one checklist line. */
export interface ParsedTaskLine {
  text: string
  done: boolean
  inProgress: boolean
}

/** Encodes tasks into the persisted checklist markdown (lines joined by '\n'). */
export function encodeTaskList(tasks: readonly TaskListItem[]): string {
  const lines: string[] = []
  for (const task of tasks) {
    if (task.status === 'completed') lines.push('- [x] ' + task.content)
    else if (task.status === 'in_progress') {
      lines.push('- [ ] ' + task.content + ' ' + TASK_IN_PROGRESS_MARKER)
    } else lines.push('- [ ] ' + task.content)
  }
  return lines.join('\n')
}

/** Decodes checklist markdown; non-checklist lines are skipped. */
export function parseTaskList(markdown: string): ParsedTaskLine[] {
  const parsed: ParsedTaskLine[] = []
  for (const line of markdown.split('\n')) {
    const match = /^- \[( |x)\] (.*)$/.exec(line.trim())
    if (!match) continue
    const inProgress = match[2].endsWith(TASK_IN_PROGRESS_MARKER)
    parsed.push({
      text: inProgress ? match[2].slice(0, -TASK_IN_PROGRESS_MARKER.length).trim() : match[2],
      done: match[1] === 'x',
      inProgress,
    })
  }
  return parsed
}
