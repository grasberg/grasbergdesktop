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

The schema is currently at **version 50** (`src/main/db/migrations.ts` is the
authoritative, append-only list; the table below is a summary and may lag it):

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
| 26 | `agent-platform` | `agent_runs` (background delegate control plane), `checkpoints` (pre-edit snapshots), project hooks |
| 27–29 | `scheduled-tasks` | `scheduled_tasks` (standalone prompt tasks) + per-task pre-approved tools and working folder |
| 30 | `inbox-state` | `inbox_state` (reviewed-state for the Home agent inbox; no FKs by design) |
| 31 | `tool-rules` | `tool_rules` (persisted "always allow"/"always ask" standing approvals) |
| 32 | `agent-owned-memory` | `agents` as owners: `scheduled_tasks.agent_id`, `memories.agent_id` |
| 33 | `calendar-schedules` | calendar schedules + `scheduled_task_runs`/`workflow` run history |
| 34 | `activity-log` | `activity_log` (every tool call + the reason it was allowed; redacted, capped, no FKs) |
| 35 | `workflow-webhooks` | per-workflow `webhookEnabled` for the loopback trigger endpoint |
| 36 | `messages-usage-index` | partial index on `messages(created_at)` for the Usage view |
| 37 | `optimizer-and-experiments` | `optimizer_runs`, `optimizer_versions`, `experiment_entries` (AVO-style autonomous optimizer + per-project experiment log) |
| 38 | `remote-devices` | `remote_devices` (phones paired through the relay tunnel; token stored as SHA-256 hash only) |
| 39 | `optimizer-direction` | `optimizer_runs.direction` (`maximize`/`minimize`; ADD COLUMN, defaults `maximize`) |
| 40 | `review-hardening-state` | Remote request anti-replay counter and forced re-pair, workflow schedule-edit anchor, optimizer worktree/recovery metadata |
| 41 | `conversation-forking` | `conversations.parent_conversation_id` + `forked_at_message_id` (fork provenance; plain nullable pointers, not FKs — a fork outlives its parent) + `idx_conversations_parent` |
| 42 | `workflow-watch-trigger` | `workflows.watch_json` (folder-watch trigger config; nullable ADD COLUMN, enabled flag inside the JSON) |
| 43 | `notebooks` | rebuild `documents` (leaf): `conversation_id` nullable, `kind` CHECK dropped (zod enforces); new `document_versions` table, capped at 20 per doc by the repository |
| 44 | `budget-guardrails` | new `headless_usage` spend ledger (no FKs — a row outlives its run); nullable `budget_usd` REAL on `conversations`/`workflows`/`scheduled_tasks` (month-to-date estimated-spend caps) |
| 45 | `app-lock-private-spaces` | new `spaces` table; nullable `conversations.space_id` (NULL = default space; no FK — delete is app-guarded to empty spaces) + `idx_conversations_space` |
| 46 | `bot-mode` | Bot Mode (Hermes-style): `agents.title`/`avatar_json`/`hidden`/`chat_conversation_id`; `conversations.agent_id` (canonical bot chat, excluded from the sidebar listing) + `idx_conversations_agent`; `messages.agent_id` (author attribution); new `bot_groups` + `bot_group_members` tables (group rooms; one shared transcript conversation per room). All pointers deliberately without FKs — the app cleans up on delete |
| 47 | `bot-gateway` | OpenClaw-inspired Bot Mode hardening: `agents.heartbeat_json`/`reset_json`/`message_allow_json` (heartbeat, auto-compact policy, bot-to-bot allowlist); `bot_groups.activation` ('always'\|'mention') + `bot_group_members.observer`; `scheduled_tasks.webhook_url` (delivery target); new `bot_bindings` table (per-bot external Telegram presence — the token lives in `tool_secrets`, never here) |
| 48 | `bot-outbox` | new `a2a_outbox` table — durable bot-to-bot (`message_agent`) deliveries: queued → delivered → replied \| failed \| cancelled, `hop` + `attempts` persisted, `target_conversation_id`/`assistant_message_id` for boot recovery; `messages.handoff_json` (visible handoff chrome on the sender marker, the target's incoming turn and the routed reply). No FKs — app-side cleanup on delete |
| 49 | `bot-attention` | roster attention: `agents.chat_seen_at` + `bot_groups.seen_at` (when the user last looked; backfilled to the upgrade moment), `agent_runs.agent_id` + `idx_agent_runs_agent` and `headless_usage.agent_id` + `idx_headless_usage_agent` (a run/spend attributed to the agent PROFILE; task rows backfilled from `scheduled_tasks.agent_id`). Plain nullable ADD COLUMNs |
| 50 | `bot-rooms-events` | `bot_groups.mode` ('roundtable'\|'ensemble', default roundtable) + `bot_groups.lead_agent_id` (the synthesizing member of an ensemble room; nulled app-side when it leaves); `agents.webhook_enabled` + `agents.watch_json` (a bot's opt-in to being woken by the trigger endpoint / a watched folder). Plain ADD COLUMNs |

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

### `documents` (v9, revived as Notebooks in v43)

Originally Write-mode documents / Design-mode HTML prototypes (dormant after
the v24/v25 two-mode collapse); v43 rebuilt the table into Home-level living
Markdown notebooks: `conversation_id` became nullable (a notebook belongs to
no conversation and carries NULL; legacy conversation-keyed rows keep their
CASCADE lifecycle) and the `kind` CHECK was dropped (zod enforces
`doc`/`html` at the boundary). The Notes card and the
`list_documents`/`read_document`/`edit_document` tools read/write kind `doc`
rows only; surviving `html` rows are never listed.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `conversation_id` | TEXT nullable FK → `conversations(id)` ON DELETE CASCADE | NULL for notebooks (v43); legacy rows keep their conversation |
| `kind` | TEXT | `doc` \| `html` (zod-enforced since v43) |
| `title` | TEXT | |
| `content` | TEXT | Markdown (doc) or full HTML (legacy prototype) |
| `created_at`, `updated_at` | INTEGER | unix ms |

### `document_versions` (v43)

Snapshot history behind notebook edits — the repository writes the PREVIOUS
content here before every content change (model tool edits, manual UI edits
and reverts all pass through the same path), then prunes past 20 versions per
document (oldest first; the AUTOINCREMENT id makes ordering tie-proof).
Revert snapshots the current content before restoring, so a revert is itself
undoable.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | monotonic → "newest first" is `id DESC` |
| `document_id` | TEXT FK → `documents(id)` ON DELETE CASCADE | |
| `content` | TEXT | the snapshotted (previous) Markdown |
| `created_at` | INTEGER | unix ms |

### `workflows` (v10)

Visual node-graph workflows. The graph is stored as JSON; the engine
(`src/main/workflows/engine.ts`) interprets it (nodes: manual, template,
ai_agent, http_request, output).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `name` | TEXT | |
| `graph_json` | TEXT | `{nodes,edges}` JSON, default empty graph |
| `schedule_updated_at` | INTEGER nullable | last schedule/schedule-enabled edit (v40); calendar cadence anchor independent of unrelated workflow edits |
| `watch_json` | TEXT nullable | `WorkflowWatchConfig` JSON (v42): `{enabled, folderPath, glob, event: created\|changed, debounceMs?}` — folder-watch trigger, enabled flag inside; fired runs record trigger `watch` |
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
| `parent_conversation_id` | TEXT nullable | conversation this one was forked from (v41); plain pointer, not an FK — the parent may be deleted |
| `forked_at_message_id` | TEXT nullable | id of the SOURCE message the fork was taken at (v41; message ids are regenerated in the fork) |
| `space_id` | TEXT nullable | private space this conversation belongs to (v45); NULL = default space; no FK (spaces delete only when empty) |
| `agent_id` | TEXT nullable | Bot Mode (v46): the agent profile owning this canonical bot chat; NULL = ordinary conversation. Bot-owned conversations (this column set, or referenced by `bot_groups.conversation_id`) are excluded from the default listing (`includeBots` opts back in for backups) |
| `created_at`, `updated_at` | INTEGER | unix ms |

Indexes: `idx_conversations_updated (updated_at DESC)` for the sidebar list,
`idx_conversations_mode (mode, updated_at DESC)` for per-mode filtering,
`idx_conversations_project (project_ref)` for per-project filtering (v16),
`idx_conversations_parent (parent_conversation_id)` for the sibling-fork lookup (v41),
`idx_conversations_space (space_id)` for space scoping (v45).

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
| `usage_json` | TEXT nullable | `TokenUsage` JSON; may additionally carry a `failedOverFrom` key (`FailoverAttempt[]`, Reliability Autopilot hops) that the messages repository splits back out of the parsed value — its compose/split helpers are the only (de)serialization point for this column |
| `moa_references_json` | TEXT nullable | `MoaReferenceOutput[]` JSON — the advisor model outputs behind a Mixture-of-Agents answer (v17) |
| `agent_id` | TEXT nullable | Bot Mode (v46): the agent profile that authored this message (group-room turns, bot-chat turns); no FK — an unknown id renders as an unknown author |
| `handoff_json` | TEXT nullable | Bot Mode (v48): `MessageHandoff` JSON — this row is part of a bot-to-bot handoff (`direction` 'out' = the sender-side status marker, a `system`-role row the model never sees; 'in' = the target's incoming turn; 'reply' = the routed reply/failure row). `status` mirrors the `a2a_outbox` row |
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

# Budget guardrails (v44)

### `headless_usage` (v44)

Per-run token/cost ledger for headless generation (workflow nodes, scheduled
tasks, arena candidates, IM-bridge replies). No FKs by design — a row outlives
the run it describes (the `inbox_state`/`activity_log` precedent).
`est_cost_usd` is NULL for unpriced models; NULL rows are excluded from every
cap and total (`SUM` skips them). A `run_kind = 'other'` row that refs a LIVE
conversation is excluded from combined message+headless aggregates — its
`generateHeadless` reply is already counted as a message; producers of spend
NOT persisted on messages must use their own run_kind.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `run_kind` | TEXT | `workflow` \| `scheduled_task` \| `agent_run` \| `arena` \| `brief` \| `other` |
| `ref_id` | TEXT nullable | workflow/task/conversation id the run belongs to; plain pointer, not an FK |
| `provider_id` | TEXT | provider used (plain pointer) |
| `model_id` | TEXT | |
| `prompt_tokens` | INTEGER | default 0 |
| `completion_tokens` | INTEGER | default 0 |
| `cached_tokens` | INTEGER | default 0 (cache-hit prompt tokens) |
| `est_cost_usd` | REAL nullable | NULL = unpriced model, excluded from caps |
| `created_at` | INTEGER | unix ms; indexed (`idx_headless_usage_created`, `idx_headless_usage_ref`) |

### Monthly caps (v44)

`conversations.budget_usd`, `workflows.budget_usd` and
`scheduled_tasks.budget_usd` are nullable REAL columns holding a month-to-date
estimated-spend cap in USD (NULL = no cap); `AppSettings.monthlyBudgetUsd` is
the global one. Caps count only priced spend.

# App lock & private spaces (v45)

### `spaces` (v45)

Named partitions of the conversation list. A conversation's membership is
stamped at creation (`conversations.space_id`, NULL = the default space) and
never moves in v1. Private-space conversations are excluded from the default
repository listing, backups (unless explicitly included), the phone tunnel,
the Telegram bridge, notification bodies and inbox previews. NOT encryption at
rest — the SQLite file stays readable on disk.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID (backup import may preserve the original id) |
| `name` | TEXT | case-insensitively unique (enforced by the IPC handler) |
| `provider_allowlist_json` | TEXT nullable | JSON array of provider ids generation in this space may use; NULL = all providers. `providers:delete` scrubs the id, collapsing an empty list to NULL |
| `created_at` | INTEGER | unix ms |

The app-lock passphrase verifier lives in settings (`appLockHash`, scrypt
params + hash, main-owned, never the passphrase, never exported), not in a
table of its own.

# Bot Mode (v46)

Hermes-style bots built on agent profiles. A bot **is** an `agents` row: v46
adds `title` (role designation), `avatar_json` (`{emoji?, color?}`), `hidden`
(display-only roster flag — mentions, group memberships and routines keep
working) and `chat_conversation_id` (the bot's canonical chat, created lazily
by `BotService.ensureBotChat`). Deleting a profile also deletes its canonical
chat and removes it from every room (app-level cleanup — no FKs anywhere in
Bot Mode by the v30/v34 precedent).

### `bot_groups` (v46)

Group rooms of 2–6 bots. Each room's transcript is ONE ordinary
`conversations` row (`conversation_id`); member turns are assistant messages
attributed via `messages.agent_id`. Rounds are orchestrated by `BotService`:
up to 3 serial reply-or-pass rounds per user send, capped at 10 bot messages,
round 1 scoped to @mentioned members, settled by a full silent round. A member
escalating with `@user` sets `needs_user` (the "needs you" badge, cleared when
the room is opened).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID — the room's durable identity (rename changes only the display name; disband is permanent) |
| `name` | TEXT | display name (also mirrored to the transcript conversation's title) |
| `conversation_id` | TEXT | the room transcript conversation; no FK — disband removes both |
| `needs_user` | INTEGER | 1 = a member @user-escalated since the room was last opened |
| `seen_at` | INTEGER nullable | v49: when the user last opened the room (unread = a bot turn newer than this) |
| `mode` | TEXT | v50: `roundtable` (serial reply-or-pass rounds) \| `ensemble` (every member answers the latest user message in parallel as its own run, then the lead synthesizes one reply — a Mixture-of-Agents preset as a visible room; "Create bot room" on a preset makes one bot per distinct advisor model + a lead bot) |
| `lead_agent_id` | TEXT nullable | v50: the synthesizing member of an ensemble room; must be a non-observer member; NULL for round tables |
| `created_at`, `updated_at` | INTEGER | unix ms |

### `bot_group_members` (v46)

| Column | Type | Notes |
|---|---|---|
| `group_id` | TEXT FK → `bot_groups(id)` ON DELETE CASCADE | |
| `agent_id` | TEXT | member profile; no FK — profile deletion removes rows app-side |
| `added_at` | INTEGER | unix ms (also the display order) |

PK `(group_id, agent_id)`.

Bot-to-bot messaging (`message_agent` tool, canonical bot chats only) is
fire-and-forget: the reply routes back through the completion hook, with a
single transient-failure retry, typed failure reasons and a hop cap of 6. Since
v48 every delivery is a durable `a2a_outbox` row (below) — before that the
queue lived in memory and an app restart silently dropped it.

# Bot gateway (v47)

OpenClaw-inspired hardening on top of Bot Mode. On `agents`:
`heartbeat_json` (`{everyMinutes, deliver: 'chat'|'notify', prompt?}` — a
periodic open-ended turn in the canonical chat; a reply of `NO_REPLY` deletes
the turn, anything else stays and optionally notifies; runs are deferred while
the chat is busy and floored at 15 min), `reset_json`
(`{dailyHour?, idleMinutes?}` — auto-compaction of the canonical chat via the
ordinary compactNow path; never deletion), and `message_allow_json`
(bot-to-bot allowlist for `message_agent`; NULL = open, `[]` = disabled).

`bot_groups.activation` ('always' = open reply-or-pass rounds, 'mention' =
only @named bots take one turn) and `bot_group_members.observer` (reads the
room, speaks only when @mentioned) refine room behavior. A room send while
rounds run queues in memory and drains as one coalesced round-set.

`scheduled_tasks.webhook_url` is an optional delivery target: each finished
run POSTs `{taskId, title, status, output, error, finishedAt}` (redacted,
capped) — https only, plain http on localhost.

### `bot_bindings` (v47)

One external Telegram bot per agent profile. The token is safeStorage
ciphertext in `tool_secrets` (scope `im_bridge`, owner `bot:<agentId>`) —
never in this table. DM pairing is trust-on-first-use (six-digit code, 15 min
TTL, 5 attempts); groups are allowlist-only, managed by owner-only in-group
commands (`/allowgroup`, `/denygroup`, `/activation mention|always`) —
verifiable because a Telegram private-chat id equals the user id. Inbound
messages become canonical-chat turns (queue-if-busy); replies route back via
the completion hook.

| Column | Type | Notes |
|---|---|---|
| `agent_id` | TEXT PK | the bound profile; no FK — app-side cleanup on delete |
| `channel` | TEXT | 'telegram' (the only channel in v47) |
| `enabled` | INTEGER | pause/resume without losing pairing |
| `allowed_chat_id` | INTEGER nullable | the paired DM chat (= owner's user id); NULL while unpaired |
| `pairing_code`, `pairing_expires_at`, `pairing_attempts` | | one-time pairing state |
| `groups_json` | TEXT nullable | `[{id, title, activation}]` — approved groups with per-group activation |
| `created_at`, `updated_at` | INTEGER | unix ms |

The busy-send **message queue** (v47) keeps no tables: a send into a busy
conversation persists the user message immediately, counts it in memory, and
one coalesced follow-up turn (500 ms debounce, cap 20) starts after the
running stream COMPLETES — never after a Stop or error. Fetched web content
(`fetch_url`, `web_search`) is wrapped in `<<<EXTERNAL_UNTRUSTED_CONTENT>>>`
boundary markers with chat-template token literals stripped
(`src/main/services/untrusted.ts`).

# Durable bot-to-bot deliveries (v48)

### `a2a_outbox` (v48)

One row per `message_agent` delivery. `BotService` pumps rows per target bot
strictly FIFO (`created_at, rowid`), one turn in the target's canonical chat at
a time and deliberately WITHOUT the busy-send queue (a coalesced queued turn
would merge two deliveries into one reply and break 1:1 routing). `status`
moves `queued → delivered` (the turn started; `target_conversation_id`,
`assistant_message_id`, `delivered_at` set) `→ replied` (reply routed into
`conversation_id`, the sender's chat) or `failed` (`error` = `reason: detail`);
`cancelled` when the sender profile is deleted. `hop` persists the chain depth
so the hop cap survives restarts; `attempts` counts send attempts and bounds
BOTH the single transient retry and the single post-restart redelivery (max 2).

Boot recovery (`BotService.recover`, after `markDanglingStreamingAsStopped`):
a `delivered` row whose assistant message is `complete` is routed (its
completion hook died with the process); anything else is redelivered once,
then fails as `runtime_offline`. Queued rows are pumped; the 60 s maintenance
tick also drains queues stranded by a stopped/errored user turn. `from_agent_id`
is nullable so the app itself can wake a bot through the same rails (events).
No FKs; deleting a bot fails open rows addressed to it (`missing_config`) and
cancels rows it sent. Not part of backups (runtime state); settled rows older
than 30 days are pruned at boot.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `from_agent_id` | TEXT nullable | sending bot; NULL = the app (event wake); no FK |
| `to_agent_id` | TEXT | target bot; no FK |
| `group_id` | TEXT nullable | reserved (NULL) |
| `conversation_id` | TEXT nullable | the sender's canonical chat — where the reply lands; NULL for app-originated wakes |
| `body` | TEXT | the message, verbatim data (never interpreted; chat-template token literals stripped on insert) |
| `status` | TEXT | `queued` \| `delivered` \| `replied` \| `failed` \| `cancelled` (enforced in TypeScript) |
| `hop`, `attempts` | INTEGER | chain depth (cap 6) / send attempts started (max 2) |
| `target_conversation_id`, `assistant_message_id` | TEXT nullable | set on delivery; the recovery join |
| `handoff_message_id` | TEXT nullable | the sender-side marker message (`messages.handoff_json` direction 'out') |
| `error` | TEXT nullable | `reason: detail` on failure |
| `created_at`, `updated_at`, `delivered_at` | INTEGER | unix ms |

Indexes: `idx_a2a_outbox_target (to_agent_id, status, created_at)`,
`idx_a2a_outbox_sender (from_agent_id, status)`.

# Roster attention (v49)

`BotService.roster()` computes one attention state per bot and room —
`needs_you` (a pending approval/question in the bot's chat, or a room
escalation) > `unread` (a bot-authored message newer than the user's last
look) > `working` (generating, a delivery queued/in flight, a running agent
run or routine, a room round) > `idle`. The "last look" is
`agents.chat_seen_at` / `bot_groups.seen_at`, stamped by `bots:markSeen` /
`bots:groups:markSeen` while the window is focused on that chat; both are
backfilled to the upgrade moment. "Bot-authored" = an assistant row or any row
stamped with `messages.agent_id` (routed bot replies included; handoff markers
are system rows and excluded). The count of visible bots/rooms in `needs_you`
or `unread` joins the inbox count in the dock/tray badge.

`agent_runs.agent_id` and `headless_usage.agent_id` attribute a run / a
headless spend to the agent PROFILE it ran as (delegate(agent=…), scheduled
tasks, room turns) — the roster reads running runs by id instead of matching
the free-text `agent_name`; per-bot spend sums `headless_usage` by it.

# Events → bot (v50)

A bot can be woken from outside a chat. `agents.webhook_enabled` opts it in to the
loopback trigger endpoint (`POST /agent/<id>?token=…`, answered 202 once the
event is queued — the caller never waits for the reply); `agents.watch_json` is a
`WorkflowWatchConfig` (enabled flag inside) that the workflow watcher runs under
the id `agent:<id>` (queue key `workflow:agent:<id>`). Either path calls
`BotService.wake`, which inserts an `a2a_outbox` row with `from_agent_id NULL` and
`conversation_id NULL` — the same durable, per-bot FIFO as a teammate's message,
so an event queues behind a busy chat and survives a restart — whose body is the
label plus the payload wrapped in untrusted-content markers. The bot's turn runs
with its normal interactive tools and approvals; with no sender to route to, the
reply stays in the bot's chat and the user is notified instead.
