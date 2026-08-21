/**
 * Database bootstrap: opens the SQLite file, applies pending migrations
 * (each inside a transaction, tracked via meta key 'schema_version'), and
 * wires up the repositories.
 */

import { existsSync, rmSync } from 'node:fs'
import { MIGRATIONS, type Migration } from './migrations'
import { open, type SqliteDriver } from './driver'
import { createProvidersRepository, type ProvidersRepository } from './repositories/providers'
import {
  createConversationsRepository,
  type ConversationsRepository,
} from './repositories/conversations'
import { createMessagesRepository, type MessagesRepository } from './repositories/messages'
import { createProjectsRepository, type ProjectsRepository } from './repositories/projects'
import { createSettingsRepository, type SettingsRepository } from './repositories/settings'
import { createWorkspacesRepository, type WorkspacesRepository } from './repositories/workspaces'
import { createCodeRepository, type CodeRepository } from './repositories/code'
import { createToolsRepository, type ToolsRepository } from './repositories/tools'
import {
  createCustomToolsRepository,
  type CustomToolsRepository,
} from './repositories/custom-tools'
import { createSecretsRepository, type SecretsRepository } from './repositories/secrets'
import {
  createPromptTemplatesRepository,
  type PromptTemplatesRepository,
} from './repositories/prompt-templates'
import { createMcpServersRepository, type McpServersRepository } from './repositories/mcp-servers'
import { createWorkflowsRepository, type WorkflowsRepository } from './repositories/workflows'
import { createInboxRepository, type InboxRepository } from './repositories/inbox'
import { createMemoriesRepository, type MemoriesRepository } from './repositories/memories'
import { createSkillsRepository, type SkillsRepository } from './repositories/skills'
import { createAgentsRepository, type AgentsRepository } from './repositories/agents'
import { createToolRulesRepository, type ToolRulesRepository } from './repositories/tool-rules'
import {
  createScheduledTasksRepository,
  type ScheduledTasksRepository,
} from './repositories/scheduled-tasks'
import { createKnowledgeRepository, type KnowledgeRepository } from './repositories/knowledge'
import {
  createAgentPlatformRepository,
  type AgentPlatformRepository,
} from './repositories/agent-platform'

export interface AppDatabase {
  driver: SqliteDriver
  providers: ProvidersRepository
  conversations: ConversationsRepository
  projects: ProjectsRepository
  messages: MessagesRepository
  settings: SettingsRepository
  workspaces: WorkspacesRepository
  code: CodeRepository
  tools: ToolsRepository
  customTools: CustomToolsRepository
  secrets: SecretsRepository
  prompts: PromptTemplatesRepository
  mcpServers: McpServersRepository
  workflows: WorkflowsRepository
  memories: MemoriesRepository
  skills: SkillsRepository
  agents: AgentsRepository
  /** Standing approval rules ("always allow" / "always ask"). */
  toolRules: ToolRulesRepository
  knowledge: KnowledgeRepository
  agentPlatform: AgentPlatformRepository
  scheduledTasks: ScheduledTasksRepository
  inbox: InboxRepository
  close(): void
}

const SCHEMA_VERSION_KEY = 'schema_version'

function readSchemaVersion(driver: SqliteDriver): number {
  const row = driver.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    SCHEMA_VERSION_KEY,
  ])
  if (!row) return 0
  const version = Number.parseInt(row.value, 10)
  return Number.isFinite(version) && version > 0 ? version : 0
}

const isPragma = (statement: string): boolean => /^\s*PRAGMA\b/i.test(statement)

/**
 * Apply an FK-safe rebuild (`noTransaction`) migration. `PRAGMA foreign_keys` is
 * only a no-op INSIDE a transaction, so exactly the leading/trailing PRAGMAs run
 * bare — this is SQLite's documented rebuild procedure (foreign_keys = OFF;
 * BEGIN; rebuild; COMMIT; foreign_keys = ON). Everything between them, plus the
 * version bump, is therefore atomic: a crash or a failing statement rolls the
 * whole rebuild back instead of leaving a half-built schema behind.
 *
 * Constraint on such migrations: PRAGMAs belong at the edges of `statements`; one
 * placed in the middle would silently be a no-op.
 */
function applyRebuildMigration(
  driver: SqliteDriver,
  migration: Migration,
  recordVersion: (version: number) => void
): void {
  const statements = migration.statements
  let first = 0
  while (first < statements.length && isPragma(statements[first])) first++
  let last = statements.length
  while (last > first && isPragma(statements[last - 1])) last--

  for (let i = 0; i < first; i++) driver.exec(statements[i])
  try {
    driver.transaction(() => {
      for (let i = first; i < last; i++) driver.exec(statements[i])
      recordVersion(migration.version)
    })
  } finally {
    for (let i = last; i < statements.length; i++) driver.exec(statements[i])
  }
}

function applyMigrations(driver: SqliteDriver, filePath: string): void {
  // The meta table must exist before we can read the version; this matches
  // the DDL in migration 1 and is idempotent.
  driver.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')

  let current = readSchemaVersion(driver)
  const pending = [...MIGRATIONS].sort((a, b) => a.version - b.version)
  const recordVersion = (version: number): void => {
    driver.run(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [SCHEMA_VERSION_KEY, String(version)]
    )
  }

  // FK-safe table rebuilds (noTransaction migrations) DROP and recreate tables
  // with foreign_keys disabled. The rebuild itself is atomic (see
  // applyRebuildMigration), but before upgrading a NON-EMPTY database across any
  // such migration we still snapshot the file with VACUUM INTO, as a last resort
  // for a DB that ends up damaged anyway. A fresh DB (current === 0) has nothing
  // to lose, so it is skipped (also keeps tests and in-memory DBs backup-free).
  // The snapshot is removed once all migrations succeed.
  const needsSnapshot =
    current > 0 &&
    filePath !== ':memory:' &&
    pending.some((m) => m.version > current && m.noTransaction)
  let snapshotPath: string | null = null
  if (needsSnapshot) {
    snapshotPath = `${filePath}.pre-v${current}.bak`
    try {
      // An existing snapshot for this from-version was taken before an earlier,
      // failed attempt at the same upgrade: it predates whatever went wrong, so
      // it is never overwritten with the current (possibly damaged) file.
      if (!existsSync(snapshotPath)) {
        driver.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`)
      }
    } catch {
      // If the snapshot cannot be written, proceed anyway — the migration is
      // still the same operation it always was; we just lack the safety copy.
      snapshotPath = null
    }
  }

  for (const migration of pending) {
    if (migration.version <= current) continue
    if (migration.noTransaction) {
      applyRebuildMigration(driver, migration, recordVersion)
    } else {
      driver.transaction(() => {
        for (const statement of migration.statements) driver.exec(statement)
        recordVersion(migration.version)
      })
    }
    current = migration.version
  }

  // All migrations succeeded — the pre-migration snapshot is no longer needed.
  if (snapshotPath) {
    try {
      rmSync(snapshotPath, { force: true })
    } catch {
      // Best-effort cleanup; a leftover .bak is harmless.
    }
  }
}

export function openDatabase(filePath: string): AppDatabase {
  const driver = open(filePath)
  try {
    applyMigrations(driver, filePath)
  } catch (error) {
    driver.close()
    throw error
  }

  return {
    driver,
    providers: createProvidersRepository(driver),
    conversations: createConversationsRepository(driver),
    projects: createProjectsRepository(driver),
    messages: createMessagesRepository(driver),
    settings: createSettingsRepository(driver),
    workspaces: createWorkspacesRepository(driver),
    code: createCodeRepository(driver),
    tools: createToolsRepository(driver),
    customTools: createCustomToolsRepository(driver),
    secrets: createSecretsRepository(driver),
    prompts: createPromptTemplatesRepository(driver),
    mcpServers: createMcpServersRepository(driver),
    workflows: createWorkflowsRepository(driver),
    memories: createMemoriesRepository(driver),
    skills: createSkillsRepository(driver),
    agents: createAgentsRepository(driver),
    toolRules: createToolRulesRepository(driver),
    knowledge: createKnowledgeRepository(driver),
    agentPlatform: createAgentPlatformRepository(driver),
    scheduledTasks: createScheduledTasksRepository(driver),
    inbox: createInboxRepository(driver),
    close() {
      driver.close()
    },
  }
}
