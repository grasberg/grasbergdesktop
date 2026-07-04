/**
 * SQLite schema, applied sequentially. Each migration runs once inside a
 * transaction; the current version lives in `meta` under key 'schema_version'.
 *
 * Conventions:
 * - ids are UUID strings (crypto.randomUUID)
 * - timestamps are unix epoch milliseconds (INTEGER)
 * - complex values are JSON in *_json TEXT columns
 */

export interface Migration {
  version: number
  name: string
  statements: string[]
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('deepseek','zhipu','minimax','openai-compatible')),
        label TEXT NOT NULL,
        base_url TEXT NOT NULL,
        default_model_id TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        extra_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,

      // API keys, encrypted with Electron safeStorage (OS keychain-backed).
      // Stored as base64 of the encrypted bytes. Never leaves the main process.
      `CREATE TABLE IF NOT EXISTS provider_keys (
        provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
        encrypted_key TEXT NOT NULL,
        key_preview TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat','cowork','code')),
        title TEXT NOT NULL DEFAULT 'New chat',
        provider_id TEXT,
        model_id TEXT,
        system_prompt TEXT,
        params_json TEXT NOT NULL DEFAULT '{}',
        workspace_id TEXT,
        project_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_mode ON conversations(mode, updated_at DESC)`,

      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
        content TEXT NOT NULL DEFAULT '',
        reasoning TEXT,
        attachments_json TEXT,
        tool_calls_json TEXT,
        status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','streaming','error','stopped')),
        error_json TEXT,
        provider_id TEXT,
        model_id TEXT,
        usage_json TEXT,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq)`,

      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      )`,

      // Cowork
      `CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','archived')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS workspace_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('note','plan','checklist','doc','task')),
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        status TEXT CHECK (status IN ('todo','doing','done')),
        sort INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'assistant' CHECK (origin IN ('user','assistant')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workspace_items ON workspace_items(workspace_id, sort)`,

      // Code mode
      `CREATE TABLE IF NOT EXISTS code_projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        approved_at INTEGER NOT NULL,
        last_opened_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS code_changes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES code_projects(id) ON DELETE CASCADE,
        conversation_id TEXT,
        file_path TEXT NOT NULL,
        change_type TEXT NOT NULL CHECK (change_type IN ('create','edit','delete')),
        diff TEXT NOT NULL DEFAULT '',
        new_content TEXT,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','rejected')),
        created_at INTEGER NOT NULL,
        applied_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_code_changes ON code_changes(project_id, created_at DESC)`,

      // Tools
      `CREATE TABLE IF NOT EXISTS tool_permissions (
        tool_id TEXT PRIMARY KEY,
        decision TEXT NOT NULL CHECK (decision IN ('always_allow','ask','deny')),
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tool_settings (
        tool_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'custom-tools',
    statements: [
      // User-defined HTTP tools exposed to the model alongside the builtins.
      // `id` is the bare UUID; the ToolDefinition id is 'custom:<uuid>'.
      `CREATE TABLE IF NOT EXISTS custom_tools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        base_url TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'GET',
        headers_json TEXT NOT NULL DEFAULT '{}',
        params_schema_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 3,
    name: 'code-change-old-content',
    statements: [
      // Baseline file content captured at proposal time, used to detect that a
      // file changed on disk before an approved change is applied.
      `ALTER TABLE code_changes ADD COLUMN old_content TEXT`,
    ],
  },
  {
    version: 4,
    name: 'tool-secrets',
    statements: [
      // Encrypted secret values (safeStorage ciphertext, base64) attached to a
      // tool owner: a custom HTTP tool header, or an MCP server env var/header.
      // Only ciphertext + a masked preview are stored; plaintext never lands in
      // the DB and never crosses IPC outward. `scope` distinguishes the owner
      // kind so the same table backs both custom tools and MCP servers.
      `CREATE TABLE IF NOT EXISTS tool_secrets (
        scope TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        preview TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, owner_id, name)
      )`,
    ],
  },
  {
    version: 5,
    name: 'prompt-templates',
    statements: [
      // Reusable saved prompts a user can insert into the composer or set as a
      // conversation's system prompt. `variables_json` is reserved for a later
      // placeholder feature; null in v1.
      `CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        variables_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_templates_updated ON prompt_templates(updated_at DESC)`,
    ],
  },
  {
    version: 6,
    name: 'conversation-summary',
    statements: [
      // Context compaction: a running summary of older messages plus the
      // highest message seq it covers. Messages with seq <= summary_through_seq
      // are replaced by the summary when building the provider history.
      `ALTER TABLE conversations ADD COLUMN summary_text TEXT`,
      `ALTER TABLE conversations ADD COLUMN summary_through_seq INTEGER`,
    ],
  },
  {
    version: 7,
    name: 'mcp-servers',
    statements: [
      // User-configured MCP (Model Context Protocol) servers. Their tools are
      // namespaced 'mcp__<key>__<tool>' and registered alongside the builtins.
      // Secret env vars (stdio) / headers (http) live in tool_secrets
      // (scope 'mcp_server'); only NON-secret env/headers are stored here.
      `CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        transport TEXT NOT NULL CHECK (transport IN ('stdio','http')),
        command TEXT,
        args_json TEXT NOT NULL DEFAULT '[]',
        env_json TEXT NOT NULL DEFAULT '{}',
        url TEXT,
        headers_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
]
