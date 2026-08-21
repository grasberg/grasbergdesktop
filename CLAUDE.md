# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Grasberg — a local-first Electron desktop client for multiple LLM providers (DeepSeek, GLM/Zhipu, MiniMax, OpenAI, Anthropic, Google Gemini, Amazon Bedrock, plus 120+ OpenAI-compatible presets). TypeScript end-to-end; React 19 + Zustand renderer; SQLite storage; safeStorage-encrypted keys.

Naming note: the product was rebranded (Universal LLM Desktop → Grasberg Desktop → **Grasberg**), but internal identifiers deliberately kept the old `uld` naming — the renderer API is `window.uld`, its type is `UldApi`, and the DB file is `uld.sqlite3`. Do not "fix" these. The current backup marker is `grasberg-backup`; the pre-rebrand `grasberg-desktop-backup` is still accepted on import (`LEGACY_BACKUP_FORMAT`).

## Commands

```bash
npm run dev          # electron-vite dev with hot reload
npm run typecheck    # tsc --noEmit for BOTH projects (tsconfig.node.json + tsconfig.web.json)
npm test             # vitest run (full suite; plain Node, no Electron needed)
npm run test:watch   # vitest watch mode
npm run build        # typecheck + electron-vite build → out/
npm run verify       # full gate: test → build → bundle:check → smoke (what CI runs)
npm run verify:fast  # typecheck + unit tests only (quick iteration)
npm run package:win  # build + electron-builder NSIS installer → release/
```

Run a single test file: `npx vitest run tests/unit/diff.test.ts`
Run tests by name: `npx vitest run -t "some test name"`

### Verification gates

After nontrivial changes run `npm run verify`; CI (`.github/workflows/verify.yml`) runs the same chain on windows-latest. To isolate a failure, the individual gates:

1. `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
2. `npx vitest run`
3. `npx electron-vite build` (then `npm run bundle:check` for the renderer size budget)
4. `npm run smoke` — spawns Electron with `SMOKE_TEST=1`, asserts `SMOKE_OK` within 30 s (skips MCP/IM connections)

## Architecture

Three build targets (electron-vite): **main** (Node), **preload** (contextBridge), **renderer** (sandboxed browser, no Node). Two tsconfig projects: `tsconfig.node.json` covers main + preload + shared; `tsconfig.web.json` covers renderer + shared. Path aliases: `@shared` → `src/shared` (everywhere, including tests), `@` → `src/renderer/src` (renderer only). Deeper reference docs: `docs/ARCHITECTURE.md`, `docs/DB_SCHEMA.md`.

### The spine (pinned contracts)

All code targets these files; extend them deliberately, don't re-derive or restructure them:

- `src/shared/types.ts`, `ipc.ts`, `schemas.ts`, `catalog.ts` — the shared contract (no runtime deps)
- `src/main/db/migrations.ts` — single source of truth for the schema (currently v35, append-only)
- `src/main/providers/adapter.ts` — the `ProviderAdapter` interface
- `src/renderer/src/stores/contracts.ts` — renderer store contracts

All IPC returns `IpcResult<T>`; every handler in `src/main/ipc/` validates its input with zod before calling a service. The renderer talks to main only via `window.uld` (implemented in `src/preload/`); stream events arrive via `webContents.send` push channels.

### Conversation modes (two since v24/v25)

`ConversationMode = 'chat' | 'work'`. **Chat** is a plain conversation. **Work** is the agentic mode: one `WorkView` (renderer `components/work/`) with an on-demand right panel — Files (directory tree), Changes (reviewable code-change pipeline + git), Preview (sandboxed `.html` rendering), Terminal (user-driven pipes-based console, `src/main/terminal/terminal-service.ts` — deliberately NO node-pty, sessions per conversation, the model can never reach it), Arena (Code Arena, see below), Tasks (goal + plans/checklists). A Work task without a user-connected folder gets its own workspace folder (`{userData}/data/workspaces/<conversationId>/`) lazily on the first file write: `WorkspaceRootService` (`src/main/code/workspace-root.ts`) creates the dir, registers it as a `code_projects` row and links `conversation.projectId`, so the entire existing code pipeline (tree, path jail, diffs, git) works on it unchanged. Auto workspaces are the ONLY folders the app ever deletes (path-prefix check); user grants are never touched. The legacy cowork/code/write/design modes were collapsed in v24 (legacy content deleted by explicit product decision) and their mode CHECKs dropped in v25 (v13 pattern: zod enforces the enum). Backups from before v3 import legacy modes as `work`.

Remote git lives in `src/main/code/git-service.ts` (surfaced in the Changes panel's `CommitBar`) with hard safety rules: pushes never force and pushing the default branch requires explicit confirmation; pulls are fast-forward-only and require a clean worktree; remote URLs must be HTTPS/SSH with no embedded credentials; PR creation shells out to the `gh` CLI (test seam: `deps.githubCommand`). GitHub depth beyond that: the read-only `github` tool (issues, PR view/diff, CI runs, failing-step logs) and `git_write` action `pr_review` — all `gh`-argv-based in git-service, never a shell.

**Code Arena** (`src/main/services/arena.ts`): race the same task on 2–4 models, each headless (`generateForWorkflow` with pre-approved file tools) in its own app-owned worktree (`GitService.createWorktree`), diffs captured per candidate (`captureWorktreeDiff`); applying the winner routes every file through the audited CodeChange pipeline. Arena metadata is in-memory; candidates persist as `agent_runs` rows (visible in the Home inbox). Discard deletes ONLY worktrees under the app-owned worktrees dir (path-prefix check).

**Sandbox levels** (`ChatParams.sandboxLevel`, work mode): 'read-only' refuses every mutating tool (standing posture, prompt section in `prompts.ts`), 'workspace-write' (default, unset) = the classic path-jailed behavior, 'full' additionally lets run_shell_command use an absolute cwd. Enforced in `executor.ts` next to the plan-mode gate; inherited by delegate sub-agents.

### Security invariants

- Renderer is sandboxed: `contextIsolation: true`, `sandbox: true`, no Node integration.
- API keys never cross IPC outward: renderer sends a key once, main encrypts with `safeStorage` and stores ciphertext in SQLite; only `hasKey` + a masked preview return. All provider HTTP happens in main.
- Any error text that could contain a key must pass through `redact()` (`src/main/providers/redact.ts`) before being logged, persisted, or displayed.
- Provider base URLs must be `https://` (plain `http://` only for localhost).

### Provider layer (`src/main/providers/`)

`openai-compatible.ts` is the battle-tested base class: request shaping, SSE parsing, streaming + non-streaming, tool-call assembly from deltas, zod validation, error normalization to `ProviderError` codes, retry with backoff honoring `Retry-After`. DeepSeek/Zhipu/MiniMax/OpenAI/Z.ai subclasses only override quirks (~30 lines each). `anthropic.ts`, `google.ts`, `bedrock.ts` are native adapters implementing `ProviderAdapter` from scratch (their own wire formats; Bedrock uses a bearer token, not SigV4). `registry.ts` memoizes one stateless instance per type; `resolveAdapter(type, authMode)` picks the ChatGPT-OAuth Codex adapter for `openai` + oauth.

The 120+ OpenAI-compatible presets are data, not code: `src/shared/presets.generated.ts` (~398 KB, tuple-encoded) is **generated — never hand-edit**. Regenerate from the models.dev catalog via `scripts/generate-presets.ts` (bundle with esbuild then run with node; there is no tsx in this repo). Pure mapping logic lives in `src/shared/presets.build.ts` (unit-tested); the facade is `src/shared/presets.ts`. One `openai-compatible` adapter instance serves all presets via `AdapterContext.modelCatalog`.

To add a provider, follow `docs/ADDING_A_PROVIDER.md` — including its PR checklist (streaming, abort, error normalization, redaction, mocked-fetch unit tests via `ctx.fetchImpl`).

### Database (`src/main/db/`)

`node-sqlite3-wasm` (real SQLite compiled to WASM, synchronous API, zero native compilation — this is why the test suite runs in plain Node on Windows). Wrapped by `driver.ts`, accessed through repositories. Migrations are append-only in `migrations.ts`.

**Critical migration pattern:** SQLite cannot widen a CHECK constraint in place. To alter one on a table with FK children (e.g. `conversations`, `providers`), use the FK-safe rebuild: mark the migration `noTransaction`, wrap in `PRAGMA foreign_keys = OFF/ON`, rebuild the table, and preserve child rows. Migrations v8, v11, v13 and v25 are the reference examples — doing this any other way cascade-deletes messages/keys. Since v13 the `providers.type` CHECK is dropped entirely (enum enforced by zod at the IPC boundary); v25 did the same for `conversations.mode` and `projects.mode`, so mode changes need no migration.

### Chat/streaming pipeline (`src/main/services/chat-service.ts`)

`chat.send` persists the user message + a placeholder assistant message (`status: 'streaming'`), returns a `streamId`, then runs the adapter generator and forwards `StreamEventEnvelope`s to the renderer. Stop aborts the AbortController and persists partial text as `stopped`; streaming rows are marked `stopped` at boot. Regenerate = delete trailing assistant message and re-run; edit+rerun = truncate after the edited message. History is linear (`seq` column). Text/reasoning deltas are coalesced by `StreamDeltaBuffer` (`src/main/services/stream-delta-buffer.ts`, ~32 ms windows, flushed before any non-delta event) before being pushed to the renderer. The chat service also owns the multi-round tool-call loop, the `delegate` sub-agent, context compaction, and headless generation (IM bridge, workflows).

**Mixture of Agents:** a conversation can opt into a MoA preset (`AppSettings.moaPresets`; composer toggle sets `conversation.moaPresetId`, or one-shot via `/moa`). `runMoaStream` fans the preset's advisor models out in parallel (`adapter.chat`, no tools, conversation text only), streams each as a `moa-reference` event + persists them on the message (`Message.moaReferences`), then delegates to the same `runStream` with the aggregator as the acting model and the advisor analyses injected into the last user turn — so the aggregator keeps the full tool loop / abort / persistence path. Advisor failures are captured, never fatal.

### Tool system (`src/main/tools/`)

One registry for built-in tools, user-defined custom HTTP tools, and real MCP servers (`@modelcontextprotocol/sdk`, stdio + HTTP transports). Everything goes through the same per-tool permission model and approval broker; on top of the per-tool permission sit **standing approval rules** (`tool_rules`, v31 — the persisted form of "always allow"/"always ask", matched in `src/main/tools/tool-rules.ts`), where a matching `require_approval` rule outranks everything and an `allow` rule only ever removes a dialog. A pending approval is also pushed to the desktop notifier and, when `remoteApprovalsEnabled` is on, to the paired Telegram chat with Allow/Deny buttons — both channels are live at once and the first answer wins. `ask_user_question` rides the same rails, so a background or scheduled run can raise its hand instead of guessing (one button per option; the options stay app-side and only an index travels through Telegram), and a headless run with no channel is told to use its own judgement rather than stalling; sensitive/dangerous tools (`run_shell_command`, `browser`, `computer`) are opt-in via settings and filtered out of the tool list unless enabled. Browser/computer use drives a hidden sandboxed BrowserWindow (`src/main/browser/session.ts`), never the OS desktop.

### Top-level views and background execution

The renderer routes on `ui.view` (`AppView = 'home' | 'conversation' | 'workflows'`); boot lands on the Home overview. Home and Workflows are surfaces above conversations, not conversation modes.

Three independent background-execution systems — don't conflate them:

- **Workflows** (`src/main/workflows/`): visual node graphs (React Flow) executed in-process by `engine.ts` — independent nodes run in parallel by dependency level (max 3 concurrent), aborts propagate via a linked AbortController; `runner.ts` owns run history + push events and is shared by manual, scheduled and triggered runs. A schedule is either an INTERVAL ("every N minutes") or a CALENDAR one ("08:00 on weekdays", v33); the two anchor differently and `nextRunAt` in `@shared/workflow-status.ts` is the SINGLE definition of "due" that both `scheduler.ts` and every UI label read from. `trigger-server.ts` (v35) is the app's only inbound network surface: loopback-only, token-gated, off by default, and it starts only workflows that individually set `webhookEnabled` — the request body becomes the graph's Input node output.
- **Scheduled tasks** (`src/main/scheduled-tasks/`): standalone prompt tasks (`scheduled_tasks` table, v27–v29; once/hourly/daily/weekly recurrence), deliberately independent of workflow graphs; a 30 s clock scheduler runs due prompts headlessly. Each execution is recorded in `scheduled_task_runs` (v33, capped at 20 per task) — the task row only carries its LAST outcome, so without the history a task that started failing days ago stays invisible. A run that was already overdue at launch is flagged `catchUp`: a missed slot runs ONCE at the next opportunity, and the UI says so rather than implying the schedule was kept. The model can create them from chat via the `schedule_task` tool; since v29 each task carries its own pre-approved tool ids and optional working folder, which the scheduler passes into `generateForWorkflow`.
- **Background agents** (v26): `agent_runs` is the persistent control plane for background `delegate` runs (stoppable from Settings); `checkpoints` stores pre-edit file snapshots for reversible code changes. Project hooks are declarative DB rows executed behind the same approval boundary as tools. Since v32 an **agent profile** (`agents`, v21) is an owner, not just a persona: a scheduled task names the agent that runs it (`scheduled_tasks.agent_id`, also settable from the `schedule_task` tool's `agent` argument), and `memories.agent_id` gives that agent its own recollection — injected only into its own headless runs, unique per owner by title, and deliberately excluded from dreaming so consolidation can never merge one agent's facts into another's.

Both schedulers share one `ScheduledRunQueue` (`src/main/scheduling/run-queue.ts`: bounded concurrency of 2, key-deduped) so scheduled workflows and prompt tasks can't stampede providers.

All headless generation funnels through the chat service: `generateForWorkflow` (one-shot — workflows, scheduled tasks, git commit-message suggestions, arena candidates) and `generateHeadless` (conversation reply — Telegram bridge). New headless callers should reuse these, not spawn their own adapter loops. `generateForWorkflow`'s `economy: true` opt routes internal plumbing (commit messages, dreaming, compaction) to `AppSettings.economyProviderId/ModelId` when set; explicit ids and agent profiles always win.

The **agent inbox** (Home) unifies finished background results — agent runs, workflow runs, scheduled-task runs — into one review queue: pure aggregation in `src/main/services/inbox.ts`, reviewed-state in the `inbox_state` table (v30, no FKs by design). The **Activity** tab (Settings) is the audit trail beside it: `activity_log` (v34) records EVERY tool call with the reason it was allowed — 'auto' | 'rule' | 'approved' | 'declined' | 'blocked' — written from the one choke point in `tools/executor.ts`, redacted and capped, with no FKs so an entry outlives the conversation or change it refers to. `DesktopNotifier` (`src/main/services/notify.ts`) turns those same events into OS notifications and the tray unread badge — Electron-free by design, so its routing rules (never notify about a focused window; always keep the badge honest; redact every body) stay unit-testable. The **Usage tab** (Settings) is a local estimate-only spend summary: `messages.usageSince` + `@shared/usage-summary.ts` against the static price list.

## Testing conventions

Tests live in `tests/unit/` and `tests/integration/`, run against real temp SQLite databases (no Electron, no mocked DB). Provider adapter tests inject a mocked `fetch` via `ctx.fetchImpl` (helper in `tests/helpers/mock-fetch.ts`) covering SSE fixtures, error classes, abort behavior, and redaction (proving a key never appears in thrown errors).

## Packaging notes

`electron-builder.yml`; artifacts land in `release/`. Code signing is intentionally unconfigured. Cross-OS packaging is unsupported — build each OS's installer on that OS. `scripts/SevenZipWrap.cs` is preserved source for a local 7za wrapper used to work around a Windows winCodeSign extraction issue (only needed if `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign` is absent; do not clear that cache).
