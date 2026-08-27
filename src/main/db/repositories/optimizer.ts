/**
 * Optimizer runs and their evaluated versions (migration v37). A run is an
 * autonomous optimize-evaluate-commit loop bound to one project: every round
 * the agent edits the working tree, main runs the eval command, and only
 * attempts that pass correctness AND match-or-beat the best score so far are
 * committed (accepted). Rejected rounds are recorded too — the rejected
 * lineage is what keeps the agent from repeating itself.
 */

import { randomUUID } from 'node:crypto'
import type { OptimizerRun, OptimizerVersion } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface OptimizerStartRow {
  projectId: string
  goal: string
  evalCommand: string
  testCommand: string | null
  providerId: string | null
  modelId: string | null
  maxRounds: number
}

export interface OptimizerPatch {
  status?: OptimizerRun['status']
  roundsDone?: number
  bestScore?: number | null
  bestVersion?: number | null
  lastError?: string | null
}

interface RunRow {
  id: string
  project_id: string
  goal: string
  eval_command: string
  test_command: string | null
  provider_id: string | null
  model_id: string | null
  max_rounds: number
  status: string
  rounds_done: number
  best_score: number | null
  best_version: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

function toRun(row: RunRow): OptimizerRun {
  return {
    id: row.id,
    projectId: row.project_id,
    goal: row.goal,
    evalCommand: row.eval_command,
    testCommand: row.test_command,
    providerId: row.provider_id,
    modelId: row.model_id,
    maxRounds: row.max_rounds,
    status: row.status as OptimizerRun['status'],
    roundsDone: row.rounds_done,
    bestScore: row.best_score,
    bestVersion: row.best_version,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface OptimizerRepository {
  create(input: OptimizerStartRow): OptimizerRun
  getById(id: string): OptimizerRun | null
  list(): OptimizerRun[]
  /** Patches mutable columns and bumps updated_at; returns the fresh row. */
  update(id: string, patch: OptimizerPatch): OptimizerRun | null
  appendVersion(input: {
    runId: string
    seq: number
    score: number | null
    accepted: boolean
    summary: string
    commitSha: string | null
  }): OptimizerVersion
  listVersions(runId: string): OptimizerVersion[]
}

export function createOptimizerRepository(driver: SqliteDriver): OptimizerRepository {
  const now = (): number => Date.now()

  return {
    create(input) {
      const id = randomUUID()
      const ts = now()
      driver.run(
        `INSERT INTO optimizer_runs
           (id, project_id, goal, eval_command, test_command, provider_id, model_id,
            max_rounds, status, rounds_done, best_score, best_version, last_error,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, NULL, NULL, NULL, ?, ?)`,
        [
          id,
          input.projectId,
          input.goal,
          input.evalCommand,
          input.testCommand,
          input.providerId,
          input.modelId,
          input.maxRounds,
          ts,
          ts,
        ]
      )
      return this.getById(id)!
    },

    getById(id) {
      const row = driver.get<RunRow>('SELECT * FROM optimizer_runs WHERE id = ?', [id])
      return row ? toRun(row) : null
    },

    list() {
      return driver.all<RunRow>('SELECT * FROM optimizer_runs ORDER BY created_at DESC').map(toRun)
    },

    update(id, patch) {
      const sets: string[] = []
      const params: Array<string | number | null> = []
      if (patch.status !== undefined) {
        sets.push('status = ?')
        params.push(patch.status)
      }
      if (patch.roundsDone !== undefined) {
        sets.push('rounds_done = ?')
        params.push(patch.roundsDone)
      }
      if (patch.bestScore !== undefined) {
        sets.push('best_score = ?')
        params.push(patch.bestScore)
      }
      if (patch.bestVersion !== undefined) {
        sets.push('best_version = ?')
        params.push(patch.bestVersion)
      }
      if (patch.lastError !== undefined) {
        sets.push('last_error = ?')
        params.push(patch.lastError)
      }
      if (sets.length === 0) return this.getById(id)
      sets.push('updated_at = ?')
      params.push(now(), id)
      driver.run(`UPDATE optimizer_runs SET ${sets.join(', ')} WHERE id = ?`, params)
      return this.getById(id)
    },

    appendVersion(input) {
      driver.run(
        `INSERT INTO optimizer_versions
           (run_id, seq, score, accepted, summary, commit_sha, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.runId,
          input.seq,
          input.score,
          input.accepted ? 1 : 0,
          input.summary,
          input.commitSha,
          now(),
        ]
      )
      return {
        runId: input.runId,
        seq: input.seq,
        score: input.score,
        accepted: input.accepted,
        summary: input.summary,
        commitSha: input.commitSha,
        createdAt: now(),
      }
    },

    listVersions(runId) {
      return driver
        .all<{
          run_id: string
          seq: number
          score: number | null
          accepted: number
          summary: string
          commit_sha: string | null
          created_at: number
        }>(
          `SELECT run_id, seq, score, accepted, summary, commit_sha, created_at
             FROM optimizer_versions WHERE run_id = ? ORDER BY seq ASC`,
          [runId]
        )
        .map((row) => ({
          runId: row.run_id,
          seq: row.seq,
          score: row.score,
          accepted: row.accepted === 1,
          summary: row.summary,
          commitSha: row.commit_sha,
          createdAt: row.created_at,
        }))
    },
  }
}
