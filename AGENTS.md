# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

Grasberg — a local-first Electron desktop client for multiple LLM providers (DeepSeek, GLM/Zhipu, MiniMax, OpenAI, Anthropic, Google Gemini, Amazon Bedrock, plus 120+ OpenAI-compatible presets). TypeScript end-to-end; React 19 + Zustand renderer; SQLite storage; safeStorage-encrypted keys.

Naming note: the product was rebranded (Universal LLM Desktop → Grasberg Desktop → **Grasberg**), but internal identifiers deliberately kept the old `uld` naming — the renderer API is `window.uld`, its type is `UldApi`, and the DB file is `uld.sqlite3`. Do not "fix" these. The current backup marker is `grasberg-backup`; the pre-rebrand `grasberg-desktop-backup` is still accepted on import (`LEGACY_BACKUP_FORMAT`).

## Commands

```bash
npm run dev          # electron-vite dev with hot reload
npm run typecheck    # tsc --noEmit for BOTH projects (tsconfig.node.json + tsconfig.web.json)
npm test             # vitest run (full suite; plain Node, no Electron needed)
npm run test:watch   # vitest watch mode
npm run build        # typecheck + mobile bundle + relay bundle + electron-vite build → out/
npm run build:mobile # just the phone web client (vite.mobile.config.ts → out/mobile)
npm run build:relay  # just the relay server (esbuild single-file → relay/relay.mjs)
npm run package:win  # build + electron-builder NSIS installer → release/
```

Run a single test file: `npx vitest run tests/unit/diff.test.ts`
Run tests by name: `npx vitest run -t "some test name"`

### Verification gates

After nontrivial changes, all four must pass:

1. `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
2. `npx vitest run`
3. `npx electron-vite build`
4. `SMOKE_TEST=1 npx electron .` — prints `SMOKE_OK` and exits 0 (skips MCP/IM connections)

## Architecture

Three build targets (electron-vite): **main** (Node), **preload** (contextBridge), **renderer** (sandboxed browser, no Node). Two tsconfig projects: `tsconfig.node.json` covers main + preload + shared; `tsconfig.web.json` covers renderer + shared. Path aliases: `@shared` → `src/shared` (everywhere, including tests), `@` → `src/renderer/src` (renderer only).

### The spine (pinned contracts)

All code targets these files; extend them deliberately, don't re-derive or restructure them:

- `src/shared/types.ts`, `ipc.ts`, `schemas.ts`, `catalog.ts` — the shared contract (no runtime deps)
- `src/main/db/migrations.ts` — single source of truth for the schema (currently v49, append-only)
- `src/main/providers/adapter.ts` — the `ProviderAdapter` interface
- `src/renderer/src/stores/contracts.ts` — renderer store contracts (every store's state interface, `BotsStoreState` included)

All IPC returns `IpcResult<T>`; every handler in `src/main/ipc/` validates its input with zod before calling a service. The renderer talks to main only via `window.uld` (implemented in `src/preload/`); stream events arrive via `webContents.send` push channels.

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

**Critical migration pattern:** SQLite cannot widen a CHECK constraint in place. To alter one on a table with FK children (e.g. `conversations`, `providers`), use the FK-safe rebuild: mark the migration `noTransaction`, wrap in `PRAGMA foreign_keys = OFF/ON`, rebuild the table, and preserve child rows. Migrations v8, v11, and v13 are the reference examples — doing this any other way cascade-deletes messages/keys. Since v13 the `providers.type` CHECK is dropped entirely (enum enforced by zod at the IPC boundary), so new providers/presets need no migration.

### Chat/streaming pipeline (`src/main/services/chat-service.ts`)

`chat.send` persists the user message + a placeholder assistant message (`status: 'streaming'`), returns a `streamId`, then runs the adapter generator and forwards `StreamEventEnvelope`s to the renderer. Stop aborts the AbortController and persists partial text as `stopped`; streaming rows are marked `stopped` at boot. Regenerate = delete trailing assistant message and re-run; edit+rerun = truncate after the edited message. History is linear (`seq` column). The chat service also owns the multi-round tool-call loop, the `delegate` sub-agent, context compaction, and headless generation (IM bridge, workflows).

**Mixture of Agents:** a conversation can opt into a MoA preset (`AppSettings.moaPresets`; composer toggle sets `conversation.moaPresetId`, or one-shot via `/moa`). `runMoaStream` fans the preset's advisor models out in parallel (`adapter.chat`, no tools, conversation text only), streams each as a `moa-reference` event + persists them on the message (`Message.moaReferences`), then delegates to the same `runStream` with the aggregator as the acting model and the advisor analyses injected into the last user turn — so the aggregator keeps the full tool loop / abort / persistence path. Advisor failures are captured, never fatal.

### Tool system (`src/main/tools/`)

One registry for built-in tools, user-defined custom HTTP tools, and real MCP servers (`@modelcontextprotocol/sdk`, stdio + HTTP transports). Everything goes through the same per-tool permission model and approval broker; sensitive/dangerous tools (`run_shell_command`, `browser`, `computer`) are opt-in via settings and filtered out of the tool list unless enabled. Browser/computer use drives a hidden sandboxed BrowserWindow (`src/main/browser/session.ts`), never the OS desktop.

### Bot Mode (`src/main/services/bots.ts`, `bot-prompts.ts`, `im/bot-channels.ts`)

A bot **is** an `agents` row (v46 added `title`/`avatar_json`/`hidden`/`chat_conversation_id`); there is no second roster table — Settings → Agents and the Bots pane edit the same profiles through one shared editor (`renderer/components/agents/AgentProfileForm.tsx`). A bot's canonical chat is a real conversation (`conversations.agent_id`, hidden from the sidebar listing) riding the ordinary `send()` pipeline; group rooms are `bot_groups` + one shared transcript conversation with `messages.agent_id` attribution. Bot-to-bot messaging (`message_agent`, canonical chats only) is durable since v48: `a2a_outbox` rows pumped per target strictly FIFO by `BotService` (queued → delivered → replied | failed | cancelled, hop + attempts persisted), settled through the completion hook and recovered at boot (`BotService.recover()` after `markDanglingStreamingAsStopped`); the sender-side handoff marker is a `system` row with `messages.handoff_json` that history building skips. Roster attention (v49: needs_you > unread > working > idle) is computed main-side in `BotService.roster()` from `agents.chat_seen_at`/`bot_groups.seen_at`, pending approvals/questions (`PendingBroker.hasPendingFor`), the outbox, running `agent_runs.agent_id` and routines; it feeds the sidebar badge, the dock badge and `push:navigate` deep links. Deliveries, rounds and routines run main-side and reach the renderer only via the coarse `push:botsChanged` refetch (subscribed once in `App.tsx`). v47 added heartbeats, auto-compact, the message allowlist, room activation/observers, the busy-send queue and per-bot Telegram bindings (`bot_bindings`; tokens in `tool_secrets`). Full column docs: `docs/DB_SCHEMA.md` (v46–v49).

### Remote access / phone tunnel (`src/main/remote/`, `src/mobile/`, `relay/`)

Full app access from a phone via a self-hosted relay. The desktop opens NO inbound port — it dials out to the relay (`RemoteService` + `RelayClient`, the same discipline as the Telegram bridge), phones connect to the relay, and every application frame between them is end-to-end encrypted (AES-256-GCM, HKDF-derived key from a one-time QR pairing secret; the relay sees ciphertext only — protocol in `src/shared/remote-protocol.ts`). Phones speak the renderer's own IPC dialect over the tunnel: `registerIpc` now returns its handler map (`src/main/ipc/handler-map.ts`) and `src/main/remote/router.ts` gates it behind an explicit channel allowlist. Push events flow through the main event bus (`src/main/events.ts`) that `broadcast()` publishes to (windows and tunnel are both subscribers). Paired devices live in `remote_devices` (migration v38, token hashes only); frame keys in `tool_secrets` scope `remote`. The phone web client is a second, tiny vite root (`src/mobile/` → `out/mobile`, served from the desktop through the relay so it's always version-matched); the relay itself is a dumb content-blind router in `relay/` (single-file bundle via `npm run build:relay`, `relay/README.md` for deployment).

## Testing conventions

Tests live in `tests/unit/` and `tests/integration/`, run against real temp SQLite databases (no Electron, no mocked DB). Provider adapter tests inject a mocked `fetch` via `ctx.fetchImpl` (helper in `tests/helpers/mock-fetch.ts`) covering SSE fixtures, error classes, abort behavior, and redaction (proving a key never appears in thrown errors).

## Packaging notes

`electron-builder.yml`; artifacts land in `release/`. Code signing is intentionally unconfigured. Cross-OS packaging is unsupported — build each OS's installer on that OS. `scripts/SevenZipWrap.cs` is preserved source for a local 7za wrapper used to work around a Windows winCodeSign extraction issue (only needed if `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign` is absent; do not clear that cache).
