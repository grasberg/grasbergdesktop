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
  /**
   * Run the leading/trailing PRAGMA statements OUTSIDE a transaction. Needed for
   * table rebuilds that toggle `PRAGMA foreign_keys` (a no-op inside one). The
   * statements between them still run in a transaction (see database.ts), so the
   * PRAGMAs must sit at the edges of `statements`.
   */
  noTransaction?: boolean
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
  {
    version: 8,
    name: 'conversation-modes-write-design',
    // FK-safe rebuild of `conversations` to widen the mode CHECK. Runs outside
    // a transaction so PRAGMA foreign_keys can be toggled; the messages FK
    // (ON DELETE CASCADE) would otherwise wipe messages when the old table is
    // dropped. Column list mirrors the current schema (v1 + v6 additions).
    noTransaction: true,
    statements: [
      `PRAGMA foreign_keys = OFF`,
      `CREATE TABLE conversations_new (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat','cowork','code','write','design')),
        title TEXT NOT NULL DEFAULT 'New chat',
        provider_id TEXT,
        model_id TEXT,
        system_prompt TEXT,
        params_json TEXT NOT NULL DEFAULT '{}',
        workspace_id TEXT,
        project_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        summary_text TEXT,
        summary_through_seq INTEGER
      )`,
      `INSERT INTO conversations_new SELECT * FROM conversations`,
      `DROP TABLE conversations`,
      `ALTER TABLE conversations_new RENAME TO conversations`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_mode ON conversations(mode, updated_at DESC)`,
      `PRAGMA foreign_keys = ON`,
    ],
  },
  {
    version: 9,
    name: 'documents',
    statements: [
      // Write-mode documents and Design-mode HTML prototypes, keyed to a
      // conversation. kind 'doc' = Markdown document, 'html' = prototype.
      `CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'doc' CHECK (kind IN ('doc','html')),
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_documents_conv ON documents(conversation_id, updated_at DESC)`,
    ],
  },
  {
    version: 10,
    name: 'workflows',
    statements: [
      // Visual node-graph workflows. The graph (nodes + edges) is stored as
      // JSON; the execution engine interprets it in the main process.
      `CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workflows_updated ON workflows(updated_at DESC)`,
    ],
  },
  {
    version: 11,
    name: 'provider-types-and-auth-mode',
    // FK-safe rebuild of `providers` to widen the type CHECK (add 'openai' and
    // 'zai-coding') and add an `auth_mode` column. Runs outside a transaction so
    // PRAGMA foreign_keys can be toggled; provider_keys has ON DELETE CASCADE and
    // would otherwise be wiped when the old table is dropped. Column list mirrors
    // the v1 providers schema; auth_mode gets its DEFAULT for existing rows.
    noTransaction: true,
    statements: [
      `PRAGMA foreign_keys = OFF`,
      `CREATE TABLE providers_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('deepseek','zhipu','minimax','openai','zai-coding','openai-compatible')),
        label TEXT NOT NULL,
        base_url TEXT NOT NULL,
        default_model_id TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        extra_json TEXT NOT NULL DEFAULT '{}',
        auth_mode TEXT NOT NULL DEFAULT 'api_key' CHECK (auth_mode IN ('api_key','chatgpt_oauth')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `INSERT INTO providers_new
         (id, type, label, base_url, default_model_id, enabled, extra_json, created_at, updated_at)
       SELECT id, type, label, base_url, default_model_id, enabled, extra_json, created_at, updated_at
       FROM providers`,
      `DROP TABLE providers`,
      `ALTER TABLE providers_new RENAME TO providers`,
      `PRAGMA foreign_keys = ON`,
    ],
  },
  {
    version: 12,
    name: 'provider-oauth',
    statements: [
      // OAuth sessions for providers using a login flow (e.g. "Sign in with
      // ChatGPT"). Access + refresh tokens are safeStorage ciphertext (base64),
      // never plaintext and never returned over IPC. `account_label` is a safe,
      // token-free display value (e.g. an email/account id).
      `CREATE TABLE IF NOT EXISTS provider_oauth (
        provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
        encrypted_access TEXT NOT NULL,
        encrypted_refresh TEXT,
        account_id TEXT,
        account_label TEXT,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 13,
    name: 'provider-presets',
    // FK-safe rebuild of `providers` to (a) DROP the `type` CHECK — the enum is
    // enforced by zod at the IPC boundary, and dropping it lets the ~138
    // OpenAI-compatible presets (all type='openai-compatible') exist with no
    // per-provider ProviderType and no future migration — and (b) add a nullable
    // `preset_id` linking a provider to its generated preset (models/pricing).
    // Runs outside a transaction so PRAGMA foreign_keys can be toggled; BOTH
    // provider_keys AND provider_oauth (each ON DELETE CASCADE) must survive the
    // drop of the old table.
    noTransaction: true,
    statements: [
      `PRAGMA foreign_keys = OFF`,
      `CREATE TABLE providers_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        base_url TEXT NOT NULL,
        default_model_id TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        extra_json TEXT NOT NULL DEFAULT '{}',
        auth_mode TEXT NOT NULL DEFAULT 'api_key' CHECK (auth_mode IN ('api_key','chatgpt_oauth')),
        preset_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `INSERT INTO providers_new
         (id, type, label, base_url, default_model_id, enabled, extra_json, auth_mode, created_at, updated_at)
       SELECT id, type, label, base_url, default_model_id, enabled, extra_json, auth_mode, created_at, updated_at
       FROM providers`,
      `DROP TABLE providers`,
      `ALTER TABLE providers_new RENAME TO providers`,
      `PRAGMA foreign_keys = ON`,
    ],
  },
  {
    version: 14,
    name: 'memories',
    // Assistant memories persisted across conversations. No UNIQUE index on
    // title (upsert is select-then-update; a unique index would make user
    // edits throw on collision). source_conversation_id is provenance only —
    // no FK, conversations may be deleted out from under it.
    statements: [
      `CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_conversation_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at)`,
    ],
  },
  {
    version: 15,
    name: 'skills',
    // Agent Skills (SKILL.md) imported from folders/plugins or authored in the
    // app. No UNIQUE index on name (import upserts by name in code; a unique
    // index would make manual edits throw on collision).
    statements: [
      `CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        plugin_name TEXT,
        source_path TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name)`,
    ],
  },
  {
    version: 16,
    name: 'projects',
    // Per-mode organizational projects: a lightweight folder that groups
    // conversations within one mode. `conversations.project_ref` links a task
    // to its project (nullable = unfiled). Adding a nullable column is a plain
    // ALTER — no FK-safe rebuild is needed (that pattern is only for widening a
    // CHECK constraint). Deleting a project unfiles its tasks in application
    // code (projects repo), so no FK/cascade is declared on project_ref.
    statements: [
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('chat','cowork','code','write','design')),
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_projects_mode ON projects(mode, updated_at DESC)`,
      `ALTER TABLE conversations ADD COLUMN project_ref TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_ref)`,
    ],
  },
  {
    version: 17,
    name: 'mixture-of-agents',
    // Mixture of Agents: a conversation can opt into a MoA preset (advisor
    // models + aggregator). Presets live in AppSettings (settings repo), so no
    // table is needed — only a nullable pointer column on conversations, plus a
    // column on messages that persists the advisor outputs for the labelled
    // reference blocks. Both are plain nullable ALTERs (no FK-safe rebuild —
    // that pattern is only for widening a CHECK constraint).
    statements: [
      `ALTER TABLE conversations ADD COLUMN moa_preset_id TEXT`,
      `ALTER TABLE messages ADD COLUMN moa_references_json TEXT`,
    ],
  },
  {
    version: 18,
    name: 'code-change-reverted-status',
    // Widen the code_changes.status CHECK with 'reverted' (an applied change
    // whose pre-change content was restored). CHECKs can't be altered in
    // place, so rebuild the table. Unlike the providers rebuilds (v11/v13)
    // this needs NO noTransaction/foreign_keys-OFF dance: code_changes has no
    // FK children, so dropping it cascades nothing.
    statements: [
      `CREATE TABLE code_changes_new (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES code_projects(id) ON DELETE CASCADE,
        conversation_id TEXT,
        file_path TEXT NOT NULL,
        change_type TEXT NOT NULL CHECK (change_type IN ('create','edit','delete')),
        diff TEXT NOT NULL DEFAULT '',
        new_content TEXT,
        old_content TEXT,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','rejected','reverted')),
        created_at INTEGER NOT NULL,
        applied_at INTEGER
      )`,
      `INSERT INTO code_changes_new
         (id, project_id, conversation_id, file_path, change_type, diff,
          new_content, old_content, status, created_at, applied_at)
       SELECT id, project_id, conversation_id, file_path, change_type, diff,
          new_content, old_content, status, created_at, applied_at
       FROM code_changes`,
      `DROP TABLE code_changes`,
      `ALTER TABLE code_changes_new RENAME TO code_changes`,
      `CREATE INDEX IF NOT EXISTS idx_code_changes ON code_changes(project_id, created_at DESC)`,
    ],
  },
  {
    version: 19,
    name: 'message-compare-run',
    // Compare ("Arena") runs: NULL for ordinary messages; JSON
    // {"pickedIndex": number|null} when the message's moaReferences were
    // generated side-by-side without an aggregator.
    statements: [`ALTER TABLE messages ADD COLUMN compare_json TEXT`],
  },
  {
    version: 20,
    name: 'workflow-scheduling-and-runs',
    // Recurring workflow triggers (schedule_json = {"everyMinutes": n}) and a
    // persisted history of executions. last_run_at drives the scheduler's
    // due check across app restarts.
    statements: [
      `ALTER TABLE workflows ADD COLUMN schedule_json TEXT`,
      `ALTER TABLE workflows ADD COLUMN schedule_enabled INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE workflows ADD COLUMN last_run_at INTEGER`,
      `CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK (trigger IN ('manual','schedule')),
        status TEXT NOT NULL CHECK (status IN ('ok','error')),
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs ON workflow_runs(workflow_id, started_at DESC)`,
    ],
  },
  {
    version: 21,
    name: 'agent-profiles',
    // User-defined sub-agents: persona + optional dedicated model + optional
    // restricted toolset (tool_ids_json = JSON string array; NULL = default).
    statements: [
      `CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        tool_ids_json TEXT,
        max_rounds INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 22,
    name: 'knowledge-bases',
    // RAG: knowledge bases hold embedded text chunks (embedding = raw
    // Float32Array bytes). A conversation can attach one knowledge base;
    // retrieval happens through the knowledge_search tool.
    statements: [
      `CREATE TABLE knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE knowledge_chunks (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks ON knowledge_chunks(kb_id)`,
      `ALTER TABLE conversations ADD COLUMN knowledge_base_id TEXT`,
    ],
  },
  {
    version: 23,
    name: 'message-research-run',
    // Deep Research: persists the run's plan + consulted sources on the
    // assistant message it produced (JSON ResearchRunInfo), the exact
    // moa_references_json pattern from v17. NULL for ordinary messages; a
    // plain nullable ALTER — no FK-safe rebuild (that pattern is only for
    // widening a CHECK constraint).
    statements: [`ALTER TABLE messages ADD COLUMN research_json TEXT`],
  },
  {
    version: 24,
    name: 'two-modes-delete-legacy-content',
    // The five conversation modes collapse into 'chat' | 'work'. Per an
    // explicit product decision the legacy cowork/code/write/design content is
    // DELETED, not migrated: chat conversations survive untouched. Explicit
    // child-first deletes (no cascade reliance) inside one transaction, so a
    // crash mid-way rolls back cleanly. code_projects rows are NOT touched —
    // user-granted folders remain grants for Work mode.
    statements: [
      `DELETE FROM messages WHERE conversation_id IN
         (SELECT id FROM conversations WHERE mode <> 'chat')`,
      `DELETE FROM documents WHERE conversation_id IN
         (SELECT id FROM conversations WHERE mode <> 'chat')`,
      // conversation_id has no FK on code_changes — explicit cleanup.
      `DELETE FROM code_changes WHERE conversation_id IN
         (SELECT id FROM conversations WHERE mode <> 'chat')`,
      `DELETE FROM conversations WHERE mode <> 'chat'`,
      // Workspaces were a cowork-only concept; every owner is gone.
      `DELETE FROM workspace_items`,
      `DELETE FROM workspaces`,
      `UPDATE conversations SET workspace_id = NULL`,
      // Chat holds no files by construction in the two-mode model.
      `UPDATE conversations SET project_id = NULL WHERE mode = 'chat'`,
      `DELETE FROM projects WHERE mode <> 'chat'`,
      // Defensive unfiling: any task pointing at a deleted project.
      `UPDATE conversations SET project_ref = NULL
         WHERE project_ref IS NOT NULL
           AND project_ref NOT IN (SELECT id FROM projects)`,
    ],
  },
  {
    version: 25,
    name: 'two-modes-drop-mode-checks',
    // Drop the mode CHECK on conversations and projects entirely (the v13
    // precedent: the enum is enforced by zod at the IPC boundary, so future
    // mode changes need no migration). CHECKs can't be altered in place —
    // rebuild both tables. The conversations rebuild runs outside a
    // transaction so PRAGMA foreign_keys can be toggled: the messages and
    // documents FKs (ON DELETE CASCADE) would otherwise wipe children when the
    // old table drops. Explicit column lists, never SELECT * (v13 pattern).
    // projects has no FK children but rides along in the same migration.
    noTransaction: true,
    statements: [
      `PRAGMA foreign_keys = OFF`,
      `CREATE TABLE conversations_new (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'chat',
        title TEXT NOT NULL DEFAULT 'New chat',
        provider_id TEXT,
        model_id TEXT,
        system_prompt TEXT,
        params_json TEXT NOT NULL DEFAULT '{}',
        workspace_id TEXT,
        project_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        summary_text TEXT,
        summary_through_seq INTEGER,
        project_ref TEXT,
        moa_preset_id TEXT,
        knowledge_base_id TEXT
      )`,
      `INSERT INTO conversations_new
         (id, mode, title, provider_id, model_id, system_prompt, params_json,
          workspace_id, project_id, created_at, updated_at, summary_text,
          summary_through_seq, project_ref, moa_preset_id, knowledge_base_id)
       SELECT id, mode, title, provider_id, model_id, system_prompt, params_json,
          workspace_id, project_id, created_at, updated_at, summary_text,
          summary_through_seq, project_ref, moa_preset_id, knowledge_base_id
       FROM conversations`,
      `DROP TABLE conversations`,
      `ALTER TABLE conversations_new RENAME TO conversations`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_mode ON conversations(mode, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_ref)`,
      `CREATE TABLE projects_new (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `INSERT INTO projects_new (id, mode, name, created_at, updated_at)
       SELECT id, mode, name, created_at, updated_at FROM projects`,
      `DROP TABLE projects`,
      `ALTER TABLE projects_new RENAME TO projects`,
      `CREATE INDEX IF NOT EXISTS idx_projects_mode ON projects(mode, updated_at DESC)`,
      `PRAGMA foreign_keys = ON`,
    ],
  },
  {
    version: 26,
    name: 'agent-platform',
    // Persistent control-plane records for background agents and reversible
    // code checkpoints. Project hooks are declarative data; execution remains
    // behind the same main-process policy/approval boundary as other tools.
    statements: [
      `CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        project_id TEXT,
        agent_name TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','done','error','stopped')),
        result TEXT NOT NULL DEFAULT '',
        worktree_path TEXT,
        provider_id TEXT,
        model_id TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      )`,
      `CREATE INDEX idx_agent_runs_started ON agent_runs(started_at DESC)`,
      `CREATE INDEX idx_agent_runs_conversation ON agent_runs(conversation_id, started_at DESC)`,
      `CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        change_id TEXT,
        label TEXT NOT NULL,
        message_seq INTEGER NOT NULL DEFAULT 0,
        files_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_checkpoints_conversation ON checkpoints(conversation_id, created_at DESC)`,
    ],
  },
  {
    version: 27,
    name: 'standalone-scheduled-tasks',
    // Prompt-based tasks with their own clock schedule and result state. These
    // are deliberately independent from workflow graphs/schedules.
    statements: [
      `CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        recurrence TEXT NOT NULL CHECK (recurrence IN ('once','daily','weekly')),
        next_run_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        last_status TEXT NOT NULL DEFAULT 'idle'
          CHECK (last_status IN ('idle','running','ok','error')),
        last_output TEXT NOT NULL DEFAULT '',
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_scheduled_tasks_due
         ON scheduled_tasks(enabled, next_run_at)`,
    ],
  },
  {
    version: 28,
    name: 'scheduled-task-recurrence-uncheck',
    // Adds 'hourly' recurrence. Rebuild drops the recurrence CHECK entirely
    // (v13 pattern: zod enforces the enum at the boundary), so future values
    // need no migration. scheduled_tasks has no FK relationships — a plain
    // transactional rebuild is safe.
    statements: [
      `CREATE TABLE scheduled_tasks_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        recurrence TEXT NOT NULL,
        next_run_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        last_status TEXT NOT NULL DEFAULT 'idle'
          CHECK (last_status IN ('idle','running','ok','error')),
        last_output TEXT NOT NULL DEFAULT '',
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `INSERT INTO scheduled_tasks_new
         (id, title, prompt, recurrence, next_run_at, enabled, last_run_at,
          last_status, last_output, last_error, created_at, updated_at)
       SELECT id, title, prompt, recurrence, next_run_at, enabled, last_run_at,
          last_status, last_output, last_error, created_at, updated_at
       FROM scheduled_tasks`,
      `DROP TABLE scheduled_tasks`,
      `ALTER TABLE scheduled_tasks_new RENAME TO scheduled_tasks`,
      `CREATE INDEX idx_scheduled_tasks_due
         ON scheduled_tasks(enabled, next_run_at)`,
    ],
  },
  {
    version: 29,
    name: 'scheduled-task-preapproval',
    // Per-task standing approvals for headless runs: tool ids the user
    // consented to when creating the task, plus an optional working folder
    // (code_projects row) for file/shell tools. No FK on project_id — a
    // forgotten folder just resolves to null at run time.
    statements: [
      `ALTER TABLE scheduled_tasks ADD COLUMN approved_tools_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE scheduled_tasks ADD COLUMN project_id TEXT`,
    ],
  },
  {
    version: 30,
    name: 'inbox-state',
    // The agent inbox's only persistence: which finished background results
    // (agent runs, workflow runs, scheduled-task runs) the user marked as
    // reviewed. One composite-key row per reviewed item; unreviewed items
    // simply have no row. Deliberately NO foreign keys: the three source
    // tables prune independently and a dangling review row is harmless.
    statements: [
      `CREATE TABLE inbox_state (
         item_type TEXT NOT NULL,
         item_id TEXT NOT NULL,
         reviewed_at INTEGER NOT NULL,
         PRIMARY KEY (item_type, item_id)
       )`,
    ],
  },
  {
    version: 31,
    name: 'tool-rules',
    // Standing approval rules: the persistent form of "always allow" (and its
    // counterweight, "always ask"). Replaces the in-memory conversation grant
    // that used to die with the process. No FKs by design — scope_id points at
    // a conversation or project that may be deleted, and a dangling rule is
    // inert (it can only ever match calls made in that scope, which no longer
    // happen). Nothing is enforced by a CHECK: effect/scope are validated by
    // zod at the IPC boundary (the v13 pattern), so new values need no
    // migration.
    statements: [
      `CREATE TABLE tool_rules (
         id TEXT PRIMARY KEY,
         tool_id TEXT NOT NULL,
         effect TEXT NOT NULL,
         scope TEXT NOT NULL,
         scope_id TEXT,
         pattern TEXT,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX idx_tool_rules_tool ON tool_rules(tool_id)`,
    ],
  },
  {
    version: 32,
    name: 'agent-owned-memory',
    // Agent profiles become owners rather than just personas: a memory can
    // belong to one agent (invisible to everyone else), and a scheduled task
    // can name the agent that runs it. Both columns are nullable with no FK —
    // a deleted profile leaves its memories as shared ones and its tasks on
    // the default model, which is strictly better than cascade-deleting the
    // user's remembered facts.
    statements: [
      `ALTER TABLE memories ADD COLUMN agent_id TEXT`,
      `ALTER TABLE scheduled_tasks ADD COLUMN agent_id TEXT`,
      `CREATE INDEX idx_memories_agent ON memories(agent_id)`,
    ],
  },
  {
    version: 33,
    name: 'scheduled-task-runs',
    // Per-task run history, mirroring workflow_runs. The task row only ever
    // carries its LAST outcome, so a task that started failing three days ago
    // was invisible unless someone happened to read the inbox that day.
    // ON DELETE CASCADE: history is meaningless without its task.
    // `catch_up` records that the run was already overdue when it started —
    // the app had been closed — so the UI can say so instead of implying the
    // schedule was honoured on time.
    statements: [
      `CREATE TABLE scheduled_task_runs (
         id TEXT PRIMARY KEY,
         task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
         status TEXT NOT NULL,
         output TEXT NOT NULL DEFAULT '',
         error TEXT,
         started_at INTEGER NOT NULL,
         finished_at INTEGER NOT NULL,
         catch_up INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX idx_scheduled_task_runs ON scheduled_task_runs(task_id, started_at DESC)`,
    ],
  },
  {
    version: 34,
    name: 'activity-log',
    // Every tool call the app made, with the reason it was allowed to. No FKs
    // by design: an entry has to outlive the conversation, project or change it
    // refers to — a log that deletes itself when the evidence is deleted is not
    // a log. Arguments and results are redacted and capped before insert.
    statements: [
      `CREATE TABLE activity_log (
         id TEXT PRIMARY KEY,
         at INTEGER NOT NULL,
         conversation_id TEXT,
         agent_name TEXT,
         tool_id TEXT NOT NULL,
         tool_name TEXT NOT NULL,
         risk TEXT NOT NULL,
         decision TEXT NOT NULL,
         detail TEXT NOT NULL DEFAULT '',
         arguments TEXT NOT NULL DEFAULT '',
         result TEXT NOT NULL DEFAULT '',
         change_id TEXT
       )`,
      `CREATE INDEX idx_activity_at ON activity_log(at DESC)`,
    ],
  },
  {
    version: 35,
    name: 'workflow-webhook-trigger',
    // Per-workflow opt-in for the local trigger endpoint, plus room for the
    // 'webhook' trigger value in the run history. workflow_runs is rebuilt to
    // DROP its trigger CHECK (the v13 pattern: zod validates at the boundary,
    // so future trigger kinds need no migration). Safe as a plain transactional
    // rebuild — workflow_runs is a leaf: it references workflows, and nothing
    // references it, so no child rows can be cascaded away.
    statements: [
      `ALTER TABLE workflows ADD COLUMN webhook_enabled INTEGER NOT NULL DEFAULT 0`,
      `CREATE TABLE workflow_runs_new (
         id TEXT PRIMARY KEY,
         workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
         trigger TEXT NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('ok','error')),
         output TEXT NOT NULL DEFAULT '',
         error TEXT,
         started_at INTEGER NOT NULL,
         finished_at INTEGER NOT NULL
       )`,
      `INSERT INTO workflow_runs_new
         (id, workflow_id, trigger, status, output, error, started_at, finished_at)
       SELECT id, workflow_id, trigger, status, output, error, started_at, finished_at
       FROM workflow_runs`,
      `DROP TABLE workflow_runs`,
      `ALTER TABLE workflow_runs_new RENAME TO workflow_runs`,
      `CREATE INDEX idx_workflow_runs ON workflow_runs(workflow_id, started_at DESC)`,
    ],
  },
  {
    version: 36,
    name: 'messages-usage-index',
    // The Usage view scans messages by time window; without this index that
    // walk touches EVERY message row ever stored (all transcripts). The
    // partial index covers exactly the rows the query can use, so it stays
    // small next to the table it indexes.
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_messages_usage_created
         ON messages(created_at)
         WHERE role = 'assistant' AND usage_json IS NOT NULL`,
    ],
  },
  {
    version: 37,
    name: 'optimizer-and-experiments',
    // Autonomous optimizer runs (goal + eval command + accepted-version
    // lineage, AVO-style) and a per-project experiment log injected into
    // future sessions. project_id is intentionally NOT an FK: granted code
    // folders are user-managed and can disappear independently; stale rows
    // are simply never shown because every query is scoped to a live project.
    statements: [
      `CREATE TABLE optimizer_runs (
         id TEXT PRIMARY KEY,
         project_id TEXT NOT NULL,
         goal TEXT NOT NULL,
         eval_command TEXT NOT NULL,
         test_command TEXT,
         provider_id TEXT,
         model_id TEXT,
         max_rounds INTEGER NOT NULL DEFAULT 6,
         status TEXT NOT NULL CHECK (status IN ('running','stopped','done','failed')),
         rounds_done INTEGER NOT NULL DEFAULT 0,
         best_score REAL,
         best_version INTEGER,
         last_error TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE INDEX idx_optimizer_runs_project ON optimizer_runs(project_id, created_at DESC)`,
      `CREATE TABLE optimizer_versions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         run_id TEXT NOT NULL REFERENCES optimizer_runs(id) ON DELETE CASCADE,
         seq INTEGER NOT NULL,
         score REAL,
         accepted INTEGER NOT NULL,
         summary TEXT NOT NULL DEFAULT '',
         commit_sha TEXT,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX idx_optimizer_versions ON optimizer_versions(run_id, seq)`,
      `CREATE TABLE experiment_entries (
         id TEXT PRIMARY KEY,
         project_id TEXT NOT NULL,
         title TEXT NOT NULL,
         outcome TEXT NOT NULL CHECK (outcome IN ('improved','failed','neutral')),
         detail TEXT NOT NULL DEFAULT '',
         source TEXT NOT NULL DEFAULT 'manual',
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX idx_experiment_entries ON experiment_entries(project_id, created_at DESC)`,
    ],
  },
  {
    version: 38,
    name: 'remote-devices',
    // Phones paired to this desktop through the relay tunnel. The device's
    // long-lived access token is stored as a SHA-256 hash only (the plaintext
    // leaves the machine exactly once, E2E-encrypted, at pairing); the frame
    // key itself lives in tool_secrets (encrypted), not here. Revocation sets
    // revoked_at — rows are kept so the settings list can show history until
    // the user deletes the device.
    statements: [
      `CREATE TABLE remote_devices (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         token_hash TEXT NOT NULL,
         key_fingerprint TEXT NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL,
         last_seen_at INTEGER,
         revoked_at INTEGER
       )`,
      `CREATE INDEX idx_remote_devices_seen ON remote_devices(revoked_at, last_seen_at DESC)`,
    ],
  },
  {
    version: 39,
    name: 'optimizer-direction',
    // Which way is "better". Without this the loop assumes higher-is-better and
    // silently commits regressions for the common runtime/latency benchmark
    // (slower = larger number = accepted). A plain ADD COLUMN with a default is
    // FK-safe and needs no table rebuild; existing runs keep the old behaviour.
    statements: [
      `ALTER TABLE optimizer_runs ADD COLUMN direction TEXT NOT NULL DEFAULT 'maximize'`,
    ],
  },
  {
    version: 40,
    name: 'review-hardening-state',
    // Persist security/concurrency state that must survive an app restart:
    // remote anti-replay counters, schedule-only edit anchors, and optimizer
    // isolation metadata used to recover app-owned worktrees safely.
    statements: [
      `ALTER TABLE remote_devices ADD COLUMN last_request_seq INTEGER NOT NULL DEFAULT 0`,
      `UPDATE remote_devices SET revoked_at = COALESCE(revoked_at, created_at)`,
      `DELETE FROM tool_secrets WHERE scope = 'remote' AND owner_id <> 'relay'`,
      `ALTER TABLE workflows ADD COLUMN schedule_updated_at INTEGER`,
      `UPDATE workflows SET schedule_updated_at = updated_at WHERE schedule_updated_at IS NULL`,
      `ALTER TABLE optimizer_runs ADD COLUMN worktree_path TEXT`,
      `ALTER TABLE optimizer_runs ADD COLUMN worktree_branch TEXT`,
      `ALTER TABLE optimizer_runs ADD COLUMN base_branch TEXT`,
      `ALTER TABLE optimizer_runs ADD COLUMN base_sha TEXT`,
    ],
  },
  {
    version: 41,
    name: 'conversation-forking',
    // Fork provenance. Plain nullable ADD COLUMNs — no rebuild needed.
    // Deliberately NOT foreign keys (the workspace_id/project_id pattern) so a
    // fork outlives its deleted parent; the backlink chip simply goes inert.
    statements: [
      `ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT`,
      `ALTER TABLE conversations ADD COLUMN forked_at_message_id TEXT`,
      `CREATE INDEX idx_conversations_parent ON conversations(parent_conversation_id)`,
    ],
  },
  {
    version: 42,
    name: 'workflow-watch-trigger',
    // Per-workflow folder-watch config (WorkflowWatchConfig JSON; the enabled
    // flag lives inside it). A nullable ADD COLUMN needs no rebuild, and the
    // new 'watch' run trigger needs none either: v35 already dropped
    // workflow_runs' trigger CHECK (zod validates at the boundary).
    statements: [`ALTER TABLE workflows ADD COLUMN watch_json TEXT`],
  },
  {
    version: 43,
    name: 'notebooks',
    // Revives `documents` as Home-level living Markdown notebooks: the leaf
    // rebuild makes conversation_id nullable (a notebook belongs to no
    // conversation; legacy conversation-keyed rows keep their CASCADE
    // lifecycle) and drops the kind CHECK (v13 pattern: zod enforces the
    // enum at the boundary). A normal transactional migration — documents has
    // no FK children until document_versions is created below, inside this
    // same migration. document_versions is the model-edit undo story: the
    // repository snapshots the previous content before every content change,
    // capped at 20 versions per document (pruned on insert).
    statements: [
      `CREATE TABLE documents_new (
         id TEXT PRIMARY KEY,
         conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
         kind TEXT NOT NULL DEFAULT 'doc',
         title TEXT NOT NULL DEFAULT '',
         content TEXT NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `INSERT INTO documents_new (id, conversation_id, kind, title, content, created_at, updated_at)
         SELECT id, conversation_id, kind, title, content, created_at, updated_at FROM documents`,
      `DROP TABLE documents`,
      `ALTER TABLE documents_new RENAME TO documents`,
      `CREATE INDEX IF NOT EXISTS idx_documents_conv ON documents(conversation_id, updated_at DESC)`,
      `CREATE INDEX idx_documents_updated ON documents(updated_at DESC)`,
      `CREATE TABLE document_versions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
         content TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX idx_document_versions_doc ON document_versions(document_id, id DESC)`,
    ],
  },
  {
    version: 44,
    name: 'budget-guardrails',
    // Spend ledger for headless generation plus per-scope monthly caps. No FKs
    // on headless_usage by design — a row outlives the run it describes (the
    // inbox_state/activity_log precedent, v30/v34). est_cost_usd is NULL for
    // unpriced models; those rows never count toward a cap.
    statements: [
      `CREATE TABLE headless_usage (
         id TEXT PRIMARY KEY,
         run_kind TEXT NOT NULL,
         ref_id TEXT,
         provider_id TEXT NOT NULL,
         model_id TEXT NOT NULL,
         prompt_tokens INTEGER NOT NULL DEFAULT 0,
         completion_tokens INTEGER NOT NULL DEFAULT 0,
         cached_tokens INTEGER NOT NULL DEFAULT 0,
         est_cost_usd REAL,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX idx_headless_usage_created ON headless_usage(created_at DESC)`,
      `CREATE INDEX idx_headless_usage_ref ON headless_usage(run_kind, ref_id, created_at DESC)`,
      `ALTER TABLE conversations ADD COLUMN budget_usd REAL`,
      `ALTER TABLE workflows ADD COLUMN budget_usd REAL`,
      `ALTER TABLE scheduled_tasks ADD COLUMN budget_usd REAL`,
    ],
  },
  {
    version: 45,
    name: 'app-lock-private-spaces',
    // Private spaces: NULL space_id = the default space. No FK on space_id by
    // the inbox_state/activity_log precedent — spaces:delete is app-guarded to
    // empty spaces, so a dangling reference cannot arise. Plain nullable ADD
    // COLUMN, no rebuild needed.
    statements: [
      `CREATE TABLE spaces (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         provider_allowlist_json TEXT,
         created_at INTEGER NOT NULL
       )`,
      `ALTER TABLE conversations ADD COLUMN space_id TEXT`,
      `CREATE INDEX idx_conversations_space ON conversations(space_id)`,
    ],
  },
  {
    version: 46,
    name: 'bot-mode',
    // Bot Mode (Hermes-style): agent profiles become a roster of named bots.
    // A bot's canonical chat is a real conversation owned via
    // conversations.agent_id; messages.agent_id attributes a group-room turn
    // (and any bot-authored message) to its author. bot_groups rooms keep
    // their transcript in one conversation (bot_groups.conversation_id).
    // All pointers are deliberately WITHOUT foreign keys (the v30/v34
    // precedent): deleting an agent must never cascade-delete a transcript —
    // the app cleans up canonical chats itself on bots:delete, and a dangling
    // agent_id simply renders as an unknown author. Plain nullable/defaulted
    // ADD COLUMNs — no table rebuild needed.
    statements: [
      `ALTER TABLE agents ADD COLUMN title TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE agents ADD COLUMN avatar_json TEXT`,
      `ALTER TABLE agents ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE agents ADD COLUMN chat_conversation_id TEXT`,
      `ALTER TABLE conversations ADD COLUMN agent_id TEXT`,
      `CREATE INDEX idx_conversations_agent ON conversations(agent_id)`,
      `ALTER TABLE messages ADD COLUMN agent_id TEXT`,
      `CREATE TABLE bot_groups (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         conversation_id TEXT NOT NULL,
         needs_user INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE TABLE bot_group_members (
         group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
         agent_id TEXT NOT NULL,
         added_at INTEGER NOT NULL,
         PRIMARY KEY (group_id, agent_id)
       )`,
    ],
  },
  {
    version: 47,
    name: 'bot-gateway',
    // OpenClaw-inspired Bot Mode hardening. On agents: heartbeat_json (periodic
    // "anything need attention?" turn with a NO_REPLY quiet contract),
    // reset_json (daily/idle auto-compact of the canonical chat — compaction,
    // never deletion), message_allow_json (bot-to-bot allowlist; NULL = may
    // message every bot). On rooms: activation ('always' = open reply-or-pass
    // rounds, 'mention' = only @named bots speak) and per-member observer flags
    // (read the room, speak only when mentioned). scheduled_tasks.webhook_url
    // is an optional delivery target POSTed the run result. bot_bindings gives
    // a bot its own external chat presence (one Telegram bot per profile; the
    // token lives encrypted in tool_secrets, never here; allowed_chat_id is the
    // paired DM — for Telegram private chats the chat id IS the user id, which
    // is what makes owner-only group commands verifiable). Plain ADD COLUMNs
    // and a new leaf table — no rebuild needed.
    statements: [
      `ALTER TABLE agents ADD COLUMN heartbeat_json TEXT`,
      `ALTER TABLE agents ADD COLUMN reset_json TEXT`,
      `ALTER TABLE agents ADD COLUMN message_allow_json TEXT`,
      `ALTER TABLE bot_groups ADD COLUMN activation TEXT NOT NULL DEFAULT 'always'`,
      `ALTER TABLE bot_group_members ADD COLUMN observer INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE scheduled_tasks ADD COLUMN webhook_url TEXT`,
      `CREATE TABLE bot_bindings (
         agent_id TEXT PRIMARY KEY,
         channel TEXT NOT NULL DEFAULT 'telegram',
         enabled INTEGER NOT NULL DEFAULT 1,
         allowed_chat_id INTEGER,
         pairing_code TEXT,
         pairing_expires_at INTEGER,
         pairing_attempts INTEGER NOT NULL DEFAULT 0,
         groups_json TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    ],
  },
  {
    version: 48,
    name: 'bot-outbox',
    // Durable bot-to-bot deliveries. Before v48 a `message_agent` delivery
    // lived in a BotService in-memory queue and an app restart silently
    // dropped it. a2a_outbox is one row per delivery, pumped per target bot
    // strictly FIFO; status moves queued → delivered (the turn runs in the
    // target's chat; target_conversation_id/assistant_message_id set) →
    // replied (reply routed into conversation_id, the sender's chat) or
    // failed; cancelled when the sender profile is deleted. hop persists the
    // chain depth so the ping-pong cap survives restarts; attempts bounds the
    // single transient retry AND the single post-restart redelivery. Boot
    // recovery (BotService.recover, after markDanglingStreamingAsStopped)
    // routes a completed reply whose completion hook died with the process
    // and redelivers everything else once. from_agent_id is nullable so the
    // app itself can wake a bot through the same rails (events, later).
    // messages.handoff_json carries the visible handoff chrome (a
    // MessageHandoff) on the sender-side marker row, the target's incoming
    // turn and the routed reply; handoff_message_id points at the marker.
    // No FKs, by the v30/v34/v46 precedent — rows outlive the profiles and
    // chats they name; BotService fails/cancels rows app-side on delete.
    statements: [
      `CREATE TABLE a2a_outbox (
         id TEXT PRIMARY KEY,
         from_agent_id TEXT,
         to_agent_id TEXT NOT NULL,
         group_id TEXT,
         conversation_id TEXT,
         body TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'queued',
         hop INTEGER NOT NULL DEFAULT 1,
         attempts INTEGER NOT NULL DEFAULT 0,
         target_conversation_id TEXT,
         assistant_message_id TEXT,
         handoff_message_id TEXT,
         error TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         delivered_at INTEGER
       )`,
      `CREATE INDEX idx_a2a_outbox_target ON a2a_outbox(to_agent_id, status, created_at)`,
      `CREATE INDEX idx_a2a_outbox_sender ON a2a_outbox(from_agent_id, status)`,
      `ALTER TABLE messages ADD COLUMN handoff_json TEXT`,
    ],
  },
  {
    version: 49,
    name: 'bot-attention',
    // Attention states for the Bots roster/sidebar. agents.chat_seen_at and
    // bot_groups.seen_at record when the user last had the chat/room open;
    // "unread" = a bot-authored message newer than that. Both are backfilled
    // to the upgrade moment so nothing lights up on first launch. agent_runs
    // and headless_usage gain agent_id: a run/spend attributed to the agent
    // PROFILE (delegate(agent=…), scheduled tasks, room turns), where before
    // only the free-text agent_name / the task ref tied them together. Plain
    // ADD COLUMNs; the headless_usage backfill derives the owner from
    // scheduled_tasks.agent_id for existing task runs.
    statements: [
      `ALTER TABLE agents ADD COLUMN chat_seen_at INTEGER`,
      `UPDATE agents SET chat_seen_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000`,
      `ALTER TABLE bot_groups ADD COLUMN seen_at INTEGER`,
      `UPDATE bot_groups SET seen_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000`,
      `ALTER TABLE agent_runs ADD COLUMN agent_id TEXT`,
      `CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_id, started_at DESC)`,
      `ALTER TABLE headless_usage ADD COLUMN agent_id TEXT`,
      `CREATE INDEX idx_headless_usage_agent ON headless_usage(agent_id, created_at DESC)`,
      `UPDATE headless_usage
          SET agent_id = (SELECT t.agent_id FROM scheduled_tasks t WHERE t.id = headless_usage.ref_id)
        WHERE run_kind = 'scheduled_task' AND agent_id IS NULL`,
    ],
  },
]
