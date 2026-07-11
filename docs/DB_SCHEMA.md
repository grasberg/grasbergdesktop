# Database schema

Grasberg stores everything in a single SQLite database (driver:
`node-sqlite3-wasm`) in Electron's `userData` directory. The single source of
truth for the schema is [`src/main/db/migrations.ts`](../src/main/db/migrations.ts);
this document explains it. See [ARCHITECTURE.md](ARCHITECTURE.md) for how the
storage layer fits into the app.

## Conventions

- **Primary keys** are UUID strings (`crypto.randomUUID()`) in `TEXT` columns.
- **Timestamps** are unix epoch **milliseconds** stored as `INTEGER`
  (`created_at`, `updated_at`, `approved_at`, …).
- **Complex values** are serialized JSON in `*_json TEXT` columns
  (`params_json`, `attachments_json`, `usage_json`, …). The corresponding
  TypeScript shapes live in `src/shared/types.ts`.
- **Booleans** are `INTEGER` 0/1 (`enabled`).
- **Enumerations** are enforced with `CHECK (... IN (...))` constraints that
  mirror the union types in `src/shared/types.ts`.
- **Foreign keys** use `ON DELETE CASCADE` so deleting a parent (conversation,
  workspace, project, provider) cleans up its children.

## Migration mechanism

`MIGRATIONS` in `migrations.ts` is an ordered array of
`{ version, name, statements }`. At startup each migration with
`version > current` runs once, inside a transaction, in order. The current
version is stored in the `meta` table under key `schema_version`. Adding a
schema change means appending a new migration object — never editing an
existing one.

The schema is currently at **version 10**:

| Version | Name | Adds |
|---|---|---|
| 1 | `initial-schema` | all core tables |
| 2 | `custom-tools` | `custom_tools` table (user-defined HTTP tools) |
| 3 | `code-change-old-content` | `code_changes.old_content` (staleness guard) |
| 4 | `tool-secrets` | `tool_secrets` table (encrypted custom-tool / MCP / IM secrets) |
| 5 | `prompt-templates` | `prompt_templates` table (prompt library) |
| 6 | `conversation-summary` | `conversations.summary_text` + `summary_through_seq` (context compaction) |
| 7 | `mcp-servers` | `mcp_servers` table (MCP server configs) |
| 8 | `conversation-modes-write-design` | widens `conversations.mode` to include `write`/`design` (FK-safe rebuild, runs outside a transaction with `foreign_keys` off) |
| 9 | `documents` | `documents` table (Write docs + Design HTML prototypes) |
| 10 | `workflows` | `workflows` table (visual node-graph workflows) |
| 16 | `projects` | `projects` table (per-mode task grouping) + `conversations.project_ref` |
| 17 | `mixture-of-agents` | `conversations.moa_preset_id` + `messages.moa_references_json` (Mixture of Agents; presets live in `settings`) |
| 18 | `code-change-reverted-status` | widens `code_changes.status` CHECK with `'reverted'` (in-app undo of applied changes; table rebuild — no FK-off dance needed, `code_changes` has no FK children) |
| 24 | `two-modes-delete-legacy-content` | the five modes collapse into `chat`/`work`: DELETES all cowork/code/write/design conversations (messages/documents/code_changes included), all workspaces + items, and non-chat projects (explicit product decision; chat content and `code_projects` grants survive) |
| 25 | `two-modes-drop-mode-checks` | drops the mode CHECK on `conversations` and `projects` entirely (v13 pattern — zod enforces the enum; FK-safe rebuild for conversations) |

## Tables

### `meta`

Internal key/value store for database bookkeeping.

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | e.g. `schema_version` |
| `value` | TEXT | |

### `tool_secrets` (v4)

Encrypted secret values (safeStorage ciphertext, base64) attached to a tool
owner — a custom-tool header or an MCP server env var / header. Only ciphertext
and a masked preview are stored; plaintext never lands in the DB or crosses IPC
outward. `scope` distinguishes the owner kind so one table backs both.

| Column | Type | Notes |
|---|---|---|
| `scope` | TEXT | `custom_tool` \| `mcp_server` \| `im_bridge` (PK part) |
| `owner_id` | TEXT | owner id (custom-tool / mcp-server id, or `telegram`) (PK part) |
| `name` | TEXT | header / env var name (PK part) |
| `encrypted_value` | TEXT | safeStorage ciphertext, base64 |
| `preview` | TEXT | masked preview, safe to display |
| `updated_at` | INTEGER | unix ms |

### `prompt_templates` (v5)

Reusable saved prompts (the prompt library).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `title` | TEXT | |
| `body` | TEXT | prompt text, default `''` |
| `variables_json` | TEXT nullable | reserved for a later placeholder feature |
| `created_at`, `updated_at` | INTEGER | unix ms |

### `mcp_servers` (v7)

User-configured MCP (Model Context Protocol) servers. Their tools are namespaced
`mcp__<key>__<tool>` and registered alongside the builtins. Secret env vars
(stdio) / headers (http) live in `tool_secrets` (scope `mcp_server`); only
non-secret env/headers are stored here.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `key` | TEXT UNIQUE | short slug used in the tool namespace |
| `name` | TEXT | display name |
| `transport` | TEXT | `stdio` \| `http` (CHECK) |
| `command` | TEXT nullable | stdio command |
| `args_json` | TEXT | stdio args JSON array, default `'[]'` |
| `env_json` | TEXT | non-secret env JSON, default `'{}'` |
| `url` | TEXT nullable | http endpoint |
| `headers_json` | TEXT | non-secret headers JSON, default `'{}'` |
| `enabled` | INTEGER | 0/1, default 1 |
| `created_at`, `updated_at` | INTEGER | unix ms |

### `documents` (v9 — DORMANT since v24/v25)

The table remains (append-only migrations) but has no reader or writer since
the two-mode collapse: Work-mode deliverables are real files on disk. Old rows
were deleted by v24. Originally: Write-mode Markdown documents and Design-mode
HTML prototypes, keyed to a
conversation. A conversation has at most one `doc` and any number of `html`
prototypes.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `conversation_id` | TEXT FK → `conversations(id)` ON DELETE CASCADE | |
| `kind` | TEXT | `doc` \| `html` (CHECK) |
| `title` | TEXT | |
| `content` | TEXT | Markdown (doc) or full HTML (prototype) |
| `created_at`, `updated_at` | INTEGER | unix ms |

### `workflows` (v10)

Visual node-graph workflows. The graph is stored as JSON; the engine
(`src/main/workflows/engine.ts`) interprets it (nodes: manual, template,
ai_agent, http_request, output).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `name` | TEXT | |
| `graph_json` | TEXT | `{nodes,edges}` JSON, default empty graph |
| `created_at`, `updated_at` | INTEGER | unix ms |

### `providers`

One row per user-configured provider instance (maps to `ProviderConfig`).
Multiple instances of the same type are allowed (e.g. two different
OpenAI-compatible servers).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `type` | TEXT | `deepseek` \| `zhipu` \| `minimax` \| `openai-compatible` (CHECK) |
| `label` | TEXT | user-facing name |
| `base_url` | TEXT | API base URL |
| `default_model_id` | TEXT | default `''` |
| `enabled` | INTEGER | 0/1, default 1 |
| `extra_json` | TEXT | reserved for provider-specific options, default `'{}'` |
| `created_at`, `updated_at` | INTEGER | unix ms |

### `provider_keys`

API key material, **deliberately separate from `providers`**: the row holds
only `safeStorage` ciphertext (base64 of the encrypted bytes) plus a masked
preview like `sk-…4f2a`. The plaintext key exists only transiently in the main
process; it is never persisted unencrypted and never crosses IPC to the
renderer. Separating the table keeps ordinary provider queries free of key
material and makes "has a key?" a simple join.

| Column | Type | Notes |
|---|---|---|
| `provider_id` | TEXT PK, FK → `providers(id)` ON DELETE CASCADE | 1:0..1 with providers |
| `encrypted_key` | TEXT | base64 safeStorage ciphertext |
| `key_preview` | TEXT | masked preview, safe to display |
| `updated_at` | INTEGER | unix ms |

### `conversations`

One row per conversation in any mode (maps to `Conversation`).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `mode` | TEXT | `chat` \| `work` (no CHECK since v25 — zod enforces), default `chat` |
| `title` | TEXT | default `'New chat'` |
| `provider_id` | TEXT nullable | per-conversation override; NULL = global default |
| `model_id` | TEXT nullable | per-conversation override |
| `system_prompt` | TEXT nullable | |
| `params_json` | TEXT | `ChatParams` JSON, default `'{}'` |
| `workspace_id` | TEXT nullable | the task's workspace — goal/plans/checklists (work mode) |
| `project_id` | TEXT nullable | working folder: user-granted or the auto task workspace (work mode) |
| `project_ref` | TEXT nullable | organizational Project this task is filed under (v16); NULL = unfiled |
| `moa_preset_id` | TEXT nullable | Mixture-of-Agents preset this conversation runs through (v17); NULL = ordinary single-model. The preset itself lives in `settings.moaPresets` |
| `summary_text` | TEXT nullable | context-compaction summary of older turns (v6) |
| `summary_through_seq` | INTEGER nullable | highest message seq the summary covers (v6) |
| `created_at`, `updated_at` | INTEGER | unix ms |

Indexes: `idx_conversations_updated (updated_at DESC)` for the sidebar list,
`idx_conversations_mode (mode, updated_at DESC)` for per-mode filtering,
`idx_conversations_project (project_ref)` for per-project filtering (v16).

### `projects` (v16)

One row per organizational project (maps to `Project`): a per-mode folder that
groups conversations in the sidebar. Orthogonal to Cowork workspaces and Code
folders. A conversation links to at most one project of its own mode via
`conversations.project_ref`; deleting a project unfiles its tasks (repository
sets their `project_ref` to NULL — there is no FK/cascade).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `mode` | TEXT | `chat` \| `work` (no CHECK since v25 — zod enforces) |
| `name` | TEXT | display name |
| `created_at`, `updated_at` | INTEGER | unix ms |

Index: `idx_projects_mode (mode, updated_at DESC)` for the per-mode project list.

### `messages`

Message history (maps to `Message`). **History is linear by design**: `seq` is
a monotonically increasing order within a conversation. Regenerate replaces
the trailing assistant message; edit-and-rerun **truncates** (deletes) all
messages after the edited user message and re-runs. There is no branching
tree — that keeps queries and the UI simple, and the `code_changes` table
covers audit needs where they matter.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `conversation_id` | TEXT FK → `conversations(id)` ON DELETE CASCADE | |
| `role` | TEXT | `user` \| `assistant` \| `system` \| `tool` (CHECK) |
| `content` | TEXT | default `''` |
| `reasoning` | TEXT nullable | thinking output for reasoning models |
| `attachments_json` | TEXT nullable | `Attachment[]` JSON |
| `tool_calls_json` | TEXT nullable | `ToolCallRecord[]` JSON |
| `status` | TEXT | `complete` \| `streaming` \| `error` \| `stopped` (CHECK) |
| `error_json` | TEXT nullable | `NormalizedError` JSON (already redacted) |
| `provider_id`, `model_id` | TEXT nullable | provider/model actually used for this message (the aggregator model for a MoA message) |
| `usage_json` | TEXT nullable | `TokenUsage` JSON |
| `moa_references_json` | TEXT nullable | `MoaReferenceOutput[]` JSON — the advisor model outputs behind a Mixture-of-Agents answer (v17) |
| `seq` | INTEGER | order within the conversation |
| `created_at` | INTEGER | unix ms |

Index: `idx_messages_conv (conversation_id, seq)` — the canonical read path.

A row can persist with `status = 'streaming'` if the app dies mid-generation;
such rows are marked `stopped` at next boot.

### `settings`

App settings as key/value rows with JSON values. At read time the stored
values are **merged over `DEFAULT_SETTINGS`** (from `src/shared/types.ts`), so
new settings get defaults without a migration and only user-changed values are
persisted. Structured values ride along as JSON here too — e.g. `modeModels` and
the Mixture-of-Agents `moaPresets` (`MoaPreset[]`) / `defaultMoaPresetId` (v17,
no dedicated table).

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | `AppSettings` field name |
| `value_json` | TEXT | JSON-encoded value |

### `workspaces` (Cowork)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `name` | TEXT | |
| `goal` | TEXT nullable | |
| `status` | TEXT | `active` \| `done` \| `archived` (CHECK), default `active` |
| `created_at`, `updated_at` | INTEGER | unix ms |

### `workspace_items` (Cowork)

Notes, plans, checklists, docs and tasks inside a workspace. `origin`
distinguishes user-authored items from assistant suggestions.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `workspace_id` | TEXT FK → `workspaces(id)` ON DELETE CASCADE | |
| `kind` | TEXT | `note` \| `plan` \| `checklist` \| `doc` \| `task` (CHECK) |
| `title` | TEXT | |
| `content` | TEXT | Markdown body, default `''` |
| `status` | TEXT nullable | `todo` \| `doing` \| `done` — only for kind `task` |
| `sort` | INTEGER | manual ordering, default 0 |
| `origin` | TEXT | `user` \| `assistant` (CHECK), default `assistant` |
| `created_at`, `updated_at` | INTEGER | unix ms |

Index: `idx_workspace_items (workspace_id, sort)`.

### `code_projects` (Code mode)

Folders the user has explicitly granted access to via the native picker.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `path` | TEXT UNIQUE | absolute path |
| `name` | TEXT | display name |
| `approved_at` | INTEGER | when the user granted access (unix ms) |
| `last_opened_at` | INTEGER nullable | unix ms |

### `code_changes` (Code mode)

Proposed file changes and their audit trail. Nothing is written to disk until
the user explicitly applies a change.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `project_id` | TEXT FK → `code_projects(id)` ON DELETE CASCADE | |
| `conversation_id` | TEXT nullable | conversation that proposed it |
| `file_path` | TEXT | relative to project root |
| `change_type` | TEXT | `create` \| `edit` \| `delete` (CHECK) |
| `diff` | TEXT | unified diff for display, default `''` |
| `new_content` | TEXT nullable | full new content used when applying create/edit |
| `old_content` | TEXT nullable | file content captured at proposal time (migration v3) |
| `status` | TEXT | `proposed` \| `applied` \| `rejected` \| `reverted` (CHECK, v18), default `proposed` |
| `created_at` | INTEGER | unix ms |
| `applied_at` | INTEGER nullable | unix ms |

Index: `idx_code_changes (project_id, created_at DESC)`.

**Staleness guard:** `old_content` records what the file held when the change
was proposed. On apply, the current on-disk content is compared against it; if
the file changed in the meantime the apply is refused (the user is asked to
regenerate) so an approved diff can never silently overwrite newer content.
Legacy rows created before v3 have `old_content = NULL` and skip the check.

### `tool_permissions` / `tool_settings` (Tools)

Per-tool user decisions and enablement for the MCP-style tool registry. Tool
definitions themselves are code (built-ins) — only user state is persisted.

`tool_permissions`:

| Column | Type | Notes |
|---|---|---|
| `tool_id` | TEXT PK | |
| `decision` | TEXT | `always_allow` \| `ask` \| `deny` (CHECK) |
| `updated_at` | INTEGER | unix ms |

`tool_settings`:

| Column | Type | Notes |
|---|---|---|
| `tool_id` | TEXT PK | |
| `enabled` | INTEGER | 0/1, default 1 |
| `updated_at` | INTEGER | unix ms |

### `custom_tools` (Tools, migration v2)

User-defined HTTP tools exposed to the model alongside the built-ins. The
`ToolDefinition` id presented to the model is `custom:<id>`. Only the storage
and executor exist today; a UI to add them is a future step.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID (bare; tool id is `custom:<id>`) |
| `name` | TEXT | tool name shown to the model |
| `description` | TEXT | default `''` |
| `base_url` | TEXT | endpoint to call |
| `method` | TEXT | HTTP method, default `GET` |
| `headers_json` | TEXT | request headers JSON, default `'{}'` |
| `params_schema_json` | TEXT | JSON-Schema for arguments, default `'{}'` |
| `created_at` | INTEGER | unix ms |

## Relationship overview

```
providers 1 ── 0..1 provider_keys
conversations 1 ── * messages
workspaces 1 ── * workspace_items
workspaces 1 ── * conversations   (workspace_id, cowork mode)
code_projects 1 ── * code_changes
code_projects 1 ── * conversations (project_id, code mode)

standalone: settings, meta, tool_permissions, tool_settings, custom_tools
```

`conversations.workspace_id` / `project_id` are plain nullable columns (not FK
constraints) so a conversation can outlive its workspace/project gracefully.
# Agent platform (v26)

`agent_runs` persists background delegate status/results for the Agent Control Center. `checkpoints` stores the pre-edit file payload and conversation sequence associated with each applied code change. Both are local-only and contain no provider credentials.
