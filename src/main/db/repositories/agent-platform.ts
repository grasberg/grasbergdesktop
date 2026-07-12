import { randomUUID } from 'node:crypto'
import type { AgentRun, Checkpoint, CheckpointFile, CheckpointLite } from '@shared/types'
import type { SqliteDriver } from '../driver'

interface AgentRunRow {
  id: string
  conversation_id: string | null
  project_id: string | null
  agent_name: string | null
  task: string
  status: AgentRun['status']
  result: string
  worktree_path: string | null
  provider_id: string | null
  model_id: string | null
  started_at: number
  finished_at: number | null
}

interface CheckpointRow {
  id: string
  conversation_id: string
  project_id: string
  change_id: string | null
  label: string
  message_seq: number
  files_json: string
  created_at: number
}

interface CheckpointLiteRow {
  id: string
  conversation_id: string
  label: string
  created_at: number
  paths_json: string
}

function toRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    agentName: row.agent_name,
    task: row.task,
    status: row.status,
    result: row.result,
    worktreePath: row.worktree_path,
    providerId: row.provider_id,
    modelId: row.model_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function parseFiles(raw: string): CheckpointFile[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? (value as CheckpointFile[]) : []
  } catch {
    return []
  }
}

function parsePaths(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function toCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    changeId: row.change_id,
    label: row.label,
    messageSeq: row.message_seq,
    files: parseFiles(row.files_json),
    createdAt: row.created_at,
  }
}

export interface AgentPlatformRepository {
  runsList(conversationId?: string): AgentRun[]
  runStart(input: Omit<AgentRun, 'id' | 'status' | 'result' | 'startedAt' | 'finishedAt'>): AgentRun
  runFinish(id: string, status: Exclude<AgentRun['status'], 'running'>, result: string): AgentRun | null
  /**
   * Marks any run still in status 'running' as 'stopped' — recovery for agent
   * runs interrupted by a crash/quit. Called at app boot. Returns the number of
   * runs fixed.
   */
  markDanglingRunsAsStopped(): number
  checkpointCreate(input: Omit<Checkpoint, 'id' | 'createdAt'>): Checkpoint
  checkpointsList(conversationId: string): Checkpoint[]
  /** Listing without the file snapshots — restore reads them via checkpointGet. */
  checkpointsListLite(conversationId: string): CheckpointLite[]
  checkpointGet(id: string): Checkpoint | null
}

export function createAgentPlatformRepository(driver: SqliteDriver): AgentPlatformRepository {
  const runGet = (id: string): AgentRun | null => {
    const row = driver.get<AgentRunRow>('SELECT * FROM agent_runs WHERE id = ?', [id])
    return row ? toRun(row) : null
  }
  const checkpointGet = (id: string): Checkpoint | null => {
    const row = driver.get<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?', [id])
    return row ? toCheckpoint(row) : null
  }
  return {
    runsList(conversationId) {
      const rows = conversationId
        ? driver.all<AgentRunRow>(
            'SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 100',
            [conversationId]
          )
        : driver.all<AgentRunRow>('SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 100')
      return rows.map(toRun)
    },
    runStart(input) {
      const now = Date.now()
      const id = randomUUID()
      driver.run(
        `INSERT INTO agent_runs
           (id, conversation_id, project_id, agent_name, task, status, result,
            worktree_path, provider_id, model_id, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, 'running', '', ?, ?, ?, ?, NULL)`,
        [id, input.conversationId, input.projectId, input.agentName, input.task,
          input.worktreePath, input.providerId, input.modelId, now]
      )
      return runGet(id)!
    },
    runFinish(id, status, result) {
      driver.run(
        'UPDATE agent_runs SET status = ?, result = ?, finished_at = ? WHERE id = ?',
        [status, result, Date.now(), id]
      )
      return runGet(id)
    },
    markDanglingRunsAsStopped() {
      const result = driver.run(
        "UPDATE agent_runs SET status = 'stopped', finished_at = ? WHERE status = 'running'",
        [Date.now()]
      )
      return result.changes
    },
    checkpointCreate(input) {
      const id = randomUUID()
      const now = Date.now()
      driver.run(
        `INSERT INTO checkpoints
           (id, conversation_id, project_id, change_id, label, message_seq, files_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.conversationId, input.projectId, input.changeId, input.label,
          input.messageSeq, JSON.stringify(input.files), now]
      )
      return checkpointGet(id)!
    },
    checkpointsList(conversationId) {
      return driver
        .all<CheckpointRow>(
          'SELECT * FROM checkpoints WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 100',
          [conversationId]
        )
        .map(toCheckpoint)
    },
    checkpointsListLite(conversationId) {
      return driver
        .all<CheckpointLiteRow>(
          `SELECT id, conversation_id, label, created_at,
             CASE WHEN json_valid(files_json)
               THEN (SELECT json_group_array(json_extract(value, '$.relPath'))
                     FROM json_each(checkpoints.files_json))
               ELSE '[]' END AS paths_json
           FROM checkpoints WHERE conversation_id = ?
           ORDER BY created_at DESC LIMIT 100`,
          [conversationId]
        )
        .map((row) => ({
          id: row.id,
          conversationId: row.conversation_id,
          label: row.label,
          createdAt: row.created_at,
          filePaths: parsePaths(row.paths_json),
        }))
    },
    checkpointGet,
  }
}
