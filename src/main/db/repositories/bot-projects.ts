/**
 * Bot projects (migration v53): the ongoing pieces of work a personal agent
 * tracks toward its goal (dots "several projects at once"). The bot keeps them
 * current through the update_project tool; the user sees them on the bot's
 * profile and can edit or close them. Upserted by title per bot.
 */

import { randomUUID } from 'node:crypto'
import type { BotProject, BotProjectStatus } from '@shared/types'
import type { SqliteDriver } from '../driver'

/** Projects per bot are capped; the oldest finished ones make room. */
export const MAX_PROJECTS_PER_BOT = 30

export interface BotProjectsRepository {
  listForAgent(agentId: string): BotProject[]
  getById(id: string): BotProject | null
  /** Creates or updates (by title, case-insensitive) one of the bot's projects. */
  upsert(input: {
    agentId: string
    title: string
    status?: BotProjectStatus
    summary?: string
    nextStep?: string
  }): BotProject
  update(
    id: string,
    patch: { title?: string; status?: BotProjectStatus; summary?: string; nextStep?: string }
  ): BotProject | null
  remove(id: string): void
  removeForAgent(agentId: string): void
}

interface Row {
  id: string
  agent_id: string
  title: string
  status: string
  summary: string
  next_step: string
  created_at: number
  updated_at: number
}

const STATUSES: readonly BotProjectStatus[] = ['active', 'waiting', 'blocked', 'done']

function toStatus(value: string | undefined): BotProjectStatus {
  return STATUSES.includes(value as BotProjectStatus) ? (value as BotProjectStatus) : 'active'
}

function toProject(row: Row): BotProject {
  return {
    id: row.id,
    agentId: row.agent_id,
    title: row.title,
    status: toStatus(row.status),
    summary: row.summary,
    nextStep: row.next_step,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createBotProjectsRepository(driver: SqliteDriver): BotProjectsRepository {
  const getById = (id: string): BotProject | null => {
    const row = driver.get<Row>('SELECT * FROM bot_projects WHERE id = ?', [id])
    return row ? toProject(row) : null
  }
  return {
    listForAgent(agentId) {
      return driver
        .all<Row>(
          `SELECT * FROM bot_projects WHERE agent_id = ?
           ORDER BY CASE status WHEN 'done' THEN 1 ELSE 0 END, updated_at DESC`,
          [agentId]
        )
        .map(toProject)
    },
    getById,
    upsert(input) {
      const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 160)
      const now = Date.now()
      const existing = driver.get<Row>(
        'SELECT * FROM bot_projects WHERE agent_id = ? AND title = ? COLLATE NOCASE',
        [input.agentId, title]
      )
      if (existing) {
        driver.run(
          'UPDATE bot_projects SET status = ?, summary = ?, next_step = ?, updated_at = ? WHERE id = ?',
          [
            input.status ? toStatus(input.status) : existing.status,
            input.summary !== undefined ? input.summary.slice(0, 2000) : existing.summary,
            input.nextStep !== undefined ? input.nextStep.slice(0, 1000) : existing.next_step,
            now,
            existing.id,
          ]
        )
        return getById(existing.id) as BotProject
      }
      const count =
        driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM bot_projects WHERE agent_id = ?', [
          input.agentId,
        ])?.n ?? 0
      if (count >= MAX_PROJECTS_PER_BOT) {
        driver.run(
          `DELETE FROM bot_projects WHERE id = (
             SELECT id FROM bot_projects WHERE agent_id = ? AND status = 'done'
             ORDER BY updated_at ASC LIMIT 1)`,
          [input.agentId]
        )
      }
      const id = randomUUID()
      driver.run(
        `INSERT INTO bot_projects (id, agent_id, title, status, summary, next_step, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.agentId,
          title,
          toStatus(input.status),
          (input.summary ?? '').slice(0, 2000),
          (input.nextStep ?? '').slice(0, 1000),
          now,
          now,
        ]
      )
      return getById(id) as BotProject
    },
    update(id, patch) {
      const current = getById(id)
      if (!current) return null
      driver.run(
        'UPDATE bot_projects SET title = ?, status = ?, summary = ?, next_step = ?, updated_at = ? WHERE id = ?',
        [
          patch.title?.trim() ? patch.title.trim().slice(0, 160) : current.title,
          patch.status ? toStatus(patch.status) : current.status,
          patch.summary !== undefined ? patch.summary.slice(0, 2000) : current.summary,
          patch.nextStep !== undefined ? patch.nextStep.slice(0, 1000) : current.nextStep,
          Date.now(),
          id,
        ]
      )
      return getById(id)
    },
    remove(id) {
      driver.run('DELETE FROM bot_projects WHERE id = ?', [id])
    },
    removeForAgent(agentId) {
      driver.run('DELETE FROM bot_projects WHERE agent_id = ?', [agentId])
    },
  }
}

/** The compact text a proactive turn / the system prompt carries (active work only). */
export function summarizeProjects(projects: readonly BotProject[], max = 8): string | null {
  const open = projects.filter((p) => p.status !== 'done').slice(0, max)
  if (open.length === 0) return null
  return open
    .map((p) => {
      const parts = [`- ${p.title} [${p.status}]`]
      if (p.summary.trim()) parts.push(`: ${p.summary.trim().replace(/\s+/g, ' ').slice(0, 200)}`)
      if (p.nextStep.trim()) parts.push(` — next: ${p.nextStep.trim().replace(/\s+/g, ' ').slice(0, 160)}`)
      return parts.join('')
    })
    .join('\n')
}
