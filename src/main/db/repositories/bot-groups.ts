/**
 * Bot Mode group rooms (migration v46): 2–6 bots deliberating in one shared
 * conversation. The room's transcript lives in a `conversations` row
 * (conversation_id); membership is the join table. Pointers carry no FKs —
 * disbanding a room is an app-level operation that also removes its
 * conversation, and a member whose profile was deleted simply drops out of
 * the roster render.
 */

import { randomUUID } from 'node:crypto'
import type { BotGroup } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface BotGroupsRepository {
  list(): BotGroup[]
  getById(id: string): BotGroup | null
  getByConversation(conversationId: string): BotGroup | null
  create(input: { name: string; memberIds: string[]; conversationId: string }): BotGroup
  rename(id: string, name: string): BotGroup | null
  setMembers(id: string, memberIds: string[]): BotGroup | null
  setNeedsUser(id: string, needsUser: boolean): void
  touch(id: string, updatedAtMs: number): void
  /** Drops the agent from every room (profile deleted). */
  removeMemberEverywhere(agentId: string): void
  /** Ids of all room transcript conversations (for sidebar exclusion). */
  listConversationIds(): string[]
  remove(id: string): void
}

interface BotGroupRow {
  id: string
  name: string
  conversation_id: string
  needs_user: number
  created_at: number
  updated_at: number
}

export function createBotGroupsRepository(driver: SqliteDriver): BotGroupsRepository {
  const membersOf = (groupId: string): string[] =>
    driver
      .all<{ agent_id: string }>(
        'SELECT agent_id FROM bot_group_members WHERE group_id = ? ORDER BY added_at',
        [groupId]
      )
      .map((row) => row.agent_id)

  const toGroup = (row: BotGroupRow): BotGroup => ({
    id: row.id,
    name: row.name,
    conversationId: row.conversation_id,
    needsUser: row.needs_user === 1,
    memberIds: membersOf(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  const getById = (id: string): BotGroup | null => {
    const row = driver.get<BotGroupRow>('SELECT * FROM bot_groups WHERE id = ?', [id])
    return row ? toGroup(row) : null
  }

  const insertMembers = (groupId: string, memberIds: string[]): void => {
    const now = Date.now()
    for (const [index, agentId] of memberIds.entries()) {
      driver.run(
        'INSERT OR IGNORE INTO bot_group_members (group_id, agent_id, added_at) VALUES (?, ?, ?)',
        [groupId, agentId, now + index]
      )
    }
  }

  return {
    list() {
      return driver
        .all<BotGroupRow>('SELECT * FROM bot_groups ORDER BY updated_at DESC')
        .map(toGroup)
    },

    getById,

    getByConversation(conversationId) {
      const row = driver.get<BotGroupRow>('SELECT * FROM bot_groups WHERE conversation_id = ?', [
        conversationId,
      ])
      return row ? toGroup(row) : null
    },

    create(input) {
      const now = Date.now()
      const id = randomUUID()
      driver.run(
        `INSERT INTO bot_groups (id, name, conversation_id, needs_user, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
        [id, input.name, input.conversationId, now, now]
      )
      insertMembers(id, input.memberIds)
      return getById(id) as BotGroup
    },

    rename(id, name) {
      driver.run('UPDATE bot_groups SET name = ?, updated_at = ? WHERE id = ?', [
        name,
        Date.now(),
        id,
      ])
      return getById(id)
    },

    setMembers(id, memberIds) {
      driver.run('DELETE FROM bot_group_members WHERE group_id = ?', [id])
      insertMembers(id, memberIds)
      driver.run('UPDATE bot_groups SET updated_at = ? WHERE id = ?', [Date.now(), id])
      return getById(id)
    },

    setNeedsUser(id, needsUser) {
      driver.run('UPDATE bot_groups SET needs_user = ? WHERE id = ?', [needsUser ? 1 : 0, id])
    },

    touch(id, updatedAtMs) {
      driver.run('UPDATE bot_groups SET updated_at = ? WHERE id = ?', [updatedAtMs, id])
    },

    removeMemberEverywhere(agentId) {
      driver.run('DELETE FROM bot_group_members WHERE agent_id = ?', [agentId])
    },

    listConversationIds() {
      return driver
        .all<{ conversation_id: string }>('SELECT conversation_id FROM bot_groups')
        .map((row) => row.conversation_id)
    },

    remove(id) {
      driver.run('DELETE FROM bot_groups WHERE id = ?', [id])
    },
  }
}
