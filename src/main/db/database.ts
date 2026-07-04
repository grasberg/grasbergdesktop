/**
 * Database bootstrap: opens the SQLite file, applies pending migrations
 * (each inside a transaction, tracked via meta key 'schema_version'), and
 * wires up the repositories.
 */

import { MIGRATIONS } from './migrations'
import { open, type SqliteDriver } from './driver'
import { createProvidersRepository, type ProvidersRepository } from './repositories/providers'
import {
  createConversationsRepository,
  type ConversationsRepository,
} from './repositories/conversations'
import { createMessagesRepository, type MessagesRepository } from './repositories/messages'
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

export interface AppDatabase {
  driver: SqliteDriver
  providers: ProvidersRepository
  conversations: ConversationsRepository
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

function applyMigrations(driver: SqliteDriver): void {
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
}

export function openDatabase(filePath: string): AppDatabase {
  const driver = open(filePath)
  try {
    applyMigrations(driver)
  } catch (error) {
    driver.close()
    throw error
  }

  return {
    driver,
    providers: createProvidersRepository(driver),
    conversations: createConversationsRepository(driver),
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
    close() {
      driver.close()
    },
  }
}
