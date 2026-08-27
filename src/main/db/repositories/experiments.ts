/**
 * Per-project experiment log (migration v37): structured "tried X, got Y"
 * entries that future agent sessions consult before picking a strategy — the
 * lineage memory that lets improvements compound instead of repeating failed
 * approaches. The optimizer writes entries automatically; the prompt layer
 * injects a capped excerpt for work-mode conversations in the same project.
 */

import { randomUUID } from 'node:crypto'
import type { ExperimentEntry } from '@shared/types'
import type { SqliteDriver } from '../driver'

/** Entries injected into one prompt (char-capped afterwards). */
export const EXPERIMENTS_MAX_INJECTED = 20

interface EntryRow {
  id: string
  project_id: string
  title: string
  outcome: string
  detail: string
  source: string
  created_at: number
}

function toEntry(row: EntryRow): ExperimentEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    outcome: row.outcome as ExperimentEntry['outcome'],
    detail: row.detail,
    source: row.source,
    createdAt: row.created_at,
  }
}

export interface ExperimentsRepository {
  add(input: {
    projectId: string
    title: string
    outcome: ExperimentEntry['outcome']
    detail?: string
    source?: string
  }): ExperimentEntry
  listForProject(projectId: string, limit?: number): ExperimentEntry[]
}

export function createExperimentsRepository(driver: SqliteDriver): ExperimentsRepository {
  return {
    add(input) {
      const entry: ExperimentEntry = {
        id: randomUUID(),
        projectId: input.projectId,
        title: input.title.slice(0, 300),
        outcome: input.outcome,
        detail: input.detail?.slice(0, 2_000) ?? '',
        source: input.source ?? 'manual',
        createdAt: Date.now(),
      }
      driver.run(
        `INSERT INTO experiment_entries (id, project_id, title, outcome, detail, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.projectId,
          entry.title,
          entry.outcome,
          entry.detail,
          entry.source,
          entry.createdAt,
        ]
      )
      return entry
    },

    listForProject(projectId, limit = 50) {
      return driver
        .all<EntryRow>(
          `SELECT id, project_id, title, outcome, detail, source, created_at
             FROM experiment_entries WHERE project_id = ?
            ORDER BY created_at DESC LIMIT ?`,
          [projectId, limit]
        )
        .map(toEntry)
    },
  }
}
