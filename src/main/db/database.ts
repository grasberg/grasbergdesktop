/**
 * Database bootstrap: opens the SQLite file, applies pending migrations
 * (each inside a transaction, tracked via meta key 'schema_version'), and
 * wires up the repositories.
 */

import { existsSync, rmSync } from 'node:fs'
import { MIGRATIONS } from './migrations'
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
import { createDocumentsRepository, type DocumentsRepository } from './repositories/documents'
import { createWorkflowsRepository, type WorkflowsRepository } from './repositories/workflows'
import { createMemoriesRepository, type MemoriesRepository } from './repositories/memories'
import { createSkillsRepository, type SkillsRepository } from './repositories/skills'
import { createAgentsRepository, type AgentsRepository } from './repositories/agents'
import { createKnowledgeRepository, type KnowledgeRepository } from './repositories/knowledge'

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
  documents: DocumentsRepository
  workflows: WorkflowsRepository
  memories: MemoriesRepository
  skills: SkillsRepository
  agents: AgentsRepository
  knowledge: KnowledgeRepository
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

  // FK-safe table rebuilds (noTransaction migrations) toggle PRAGMA
  // foreign_keys and DROP/RENAME tables outside a transaction, so a crash
  // mid-rebuild cannot roll back and can leave the schema half-built. Before
  // upgrading a NON-EMPTY database across any such migration, snapshot the file
  // with VACUUM INTO so a corrupted rebuild is recoverable. A fresh DB
  // (current === 0) has nothing to lose, so it is skipped (also keeps tests and
  // in-memory DBs backup-free). The snapshot is removed once all migrations
  // succeed.
  const needsSnapshot =
    current > 0 &&
    filePath !== ':memory:' &&
    pending.some((m) => m.version > current && m.noTransaction)
  let snapshotPath: string | null = null
  if (needsSnapshot) {
    snapshotPath = `${filePath}.pre-v${current}.bak`
    try {
      if (existsSync(snapshotPath)) rmSync(snapshotPath, { force: true })
      driver.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`)
    } catch {
      // If the snapshot cannot be written, proceed anyway — the migration is
      // still the same operation it always was; we just lack the safety copy.
      snapshotPath = null
    }
  }

  for (const migration of pending) {
    if (migration.version <= current) continue
    if (migration.noTransaction) {
      // The statements manage foreign_keys / atomicity themselves (used for
      // FK-safe table rebuilds). Not wrapped in a transaction.
      for (const statement of migration.statements) driver.exec(statement)
      recordVersion(migration.version)
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
    documents: createDocumentsRepository(driver),
    workflows: createWorkflowsRepository(driver),
    memories: createMemoriesRepository(driver),
    skills: createSkillsRepository(driver),
    agents: createAgentsRepository(driver),
    knowledge: createKnowledgeRepository(driver),
    close() {
      driver.close()
    },
  }
}
