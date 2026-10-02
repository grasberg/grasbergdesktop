# Grasberg — Architecture

## Stack decision: Electron (over Tauri)

| Criterion | Electron ✅ | Tauri |
|---|---|---|
| Language | TypeScript end-to-end (goal requires TS throughout) | Rust core + TS frontend |
| Secure key storage | `safeStorage` built in (DPAPI / Keychain / kwallet-libsecret) | Plugin (stronghold/keyring) |
| SQLite | Any Node driver in main process | Rust plugin or sidecar |
| Packaging 3 OSes | electron-builder, mature | Good, but Rust toolchain required per-OS |
| Contributor onboarding | `npm install && npm run dev` | Requires Rust toolchain |
| Trade-off | Larger binaries (~90 MB) | Smaller binaries |

We accept larger binaries in exchange for a single-language codebase, first-party
encrypted key storage, and zero native-toolchain friction. See README for the
user-facing summary.

**SQLite driver:** `node-sqlite3-wasm` — real SQLite compiled to WASM with a
synchronous API and direct file persistence. Zero native compilation, identical
behavior on macOS/Windows/Linux and inside Vitest. The storage layer is behind
a thin repository interface, so swapping in `better-sqlite3` (native, faster)
is a one-file change if ever needed.

## Process model

```
┌────────────────────────── renderer (sandboxed, no Node) ─────────────────────┐
│ React 19 + Zustand. Talks to main ONLY via window.uld (typed, contextBridge) │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ ipcRenderer.invoke → IpcResult<T>
                                       │ webContents.send  ← stream events
┌──────────────────────────────────────┴───────────────────────────────────────┐
│ main process                                                                 │
│  ipc/        thin handlers: validate (zod) → call service → IpcResult        │
│  services/   chat orchestration (streams, stop, regenerate, edit+rerun)      │
│  providers/  adapter registry: DeepSeek | Zhipu | MiniMax | OpenAI-compat    │
│  keys/       safeStorage encrypt/decrypt; keys never cross IPC outward       │
│  db/         node-sqlite3-wasm + migrations + repositories                   │
│  tools/      one registry: built-in, custom HTTP, real MCP; approval gate   │
│  code/       project folder access, file tree, diff apply gate, git         │
│  services/bots.ts  Bot Mode: roster, durable outbox, rooms, attention        │
│  im/         Telegram (owner bridge + per-bot bindings)                      │
│  workflows/ scheduled-tasks/  background execution + one shared run queue    │
└───────────────────────────────────────────────────────────────────────────────┘
```

Security posture:
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Renderer never sees API keys: it sends a key once (`providers.setKey`), main
  encrypts with `safeStorage` and stores the ciphertext in SQLite; only
  `hasKey` + a masked preview (`sk-…4f2a`) ever travel back.
- All provider HTTP happens in main. Error messages pass through a redaction
  step that strips anything resembling a key before persisting/logging.
- No telemetry. Nothing leaves the machine except calls to the providers the
  user configured.

## Folder structure

```
src/
  shared/       types.ts ipc.ts schemas.ts catalog.ts   ← the contract (no runtime deps)
  main/
    index.ts                 app lifecycle, window, security
    db/                      driver.ts database.ts migrations.ts repositories/*
    providers/               adapter.ts errors.ts redact.ts retry.ts sse.ts
                             openai-compatible.ts deepseek.ts zhipu.ts minimax.ts registry.ts
    keys/                    keystore.ts
    services/                chat-service.ts (stream lifecycle, persistence)
                             bots.ts bot-prompts.ts (Bot Mode) notify.ts inbox.ts …
    im/                      telegram.ts bot-channels.ts (per-bot bindings)
    workflows/ scheduled-tasks/ scheduling/   background execution
    ipc/                     register.ts (zod-validated handlers)
  preload/      index.ts     contextBridge implementation of UldApi
  renderer/
    index.html
    src/        main.tsx App.tsx
      api/      typed access to window.uld
      stores/   zustand: settings, providers, conversations, chat, ui, bots, …
                (state interfaces in stores/contracts.ts)
      components/  Sidebar, chat/ (ChatView, Composer, HandoffCard, …),
                   bots/ (BotsView, cards), agents/ (AgentProfileForm — the one
                   editor for agents = bots), settings/, work/, workflows/, home/
      styles/   theme.css (CSS variables, light+dark), app.css
tests/          unit/ (providers, db, redaction)  integration/
docs/           ARCHITECTURE.md DB_SCHEMA.md ADDING_A_PROVIDER.md
```

## Provider abstraction

All four built-in families speak the OpenAI chat-completions dialect, so there
is one battle-tested base class (`openai-compatible.ts`) that handles:
request shaping, SSE parsing, streaming + non-streaming, tool-call assembly
from deltas, zod response validation, error normalization (`ProviderError`
with codes `auth | rate_limit | invalid_request | context_length | server |
network | timeout | aborted | not_supported | unknown`), and retry with
exponential backoff + jitter honoring `Retry-After` (never retries mid-stream
or non-retryable codes).

DeepSeek/Zhipu/MiniMax subclasses only override: default base URL quirks,
model listing (DeepSeek has `/models`; Zhipu/MiniMax fall back to the static
catalog in `shared/catalog.ts`), and provider-specific fields
(e.g. `reasoning_content` for DeepSeek R1). A new provider is ~30 lines; see
`docs/ADDING_A_PROVIDER.md`.

## Streaming pipeline

1. Renderer calls `chat.send` → main persists the user message + a placeholder
   assistant message (`status: 'streaming'`), returns `{streamId, ...}`.
2. Chat service runs the adapter generator, accumulates text, and forwards
   `StreamEventEnvelope`s over one push channel; renderer appends deltas.
3. `chat.stop(streamId)` aborts the AbortController; partial text is persisted
   with `status: 'stopped'`.
4. On completion/error the final message is persisted and a `done`/`error`
   event carries it to the renderer. History survives restarts mid-stream
   (streaming rows are marked `stopped` at boot).

Regenerate = delete trailing assistant message, re-run. Edit+rerun = truncate
messages after the edited user message, re-run. History is linear by design
(seq column); the code-change history table covers audit needs in Code mode.

## Data (SQLite, WAL)

See `docs/DB_SCHEMA.md` and `src/main/db/migrations.ts` (single source of
truth, currently **v49**, append-only). Table families: conversations /
messages / spaces; providers + encrypted keys + tool secrets; tools,
permissions, standing rules, activity log; workflows, scheduled tasks and
their run history; agents (= bots), `bot_groups`, `bot_bindings`,
`a2a_outbox`; memories, skills, documents, knowledge; optimizer +
experiments; remote devices; inbox state; headless usage ledger. DB file
lives in Electron `userData`.

## Implementation status

All planned phases are implemented and covered by the test suite (1,300+
tests; both tsconfig projects typecheck clean; `electron-vite build` and a
headless smoke launch succeed). Conversation modes collapsed to Chat | Work in
v24; the surfaces above conversations are Home, Workflows and Bots.

1. **Chat (MVP)** ✅ — provider layer (4 adapters), secure keys, SQLite storage,
   settings, onboarding, dark/light/system theme, streaming UI, model selector
   with capability badges, command palette, keyboard shortcuts.
2. **Code mode** ✅ — explicit folder grant → file tree → read files → Q&A →
   diff proposals with apply/reject gates → change history. Never writes or
   executes without a click; writes are guarded by realpath containment (no
   symlink escape) and a staleness check.
3. **Cowork mode + tools** ✅ — workspaces, notes/plans/checklists/tasks/docs
   with user/assistant origin separation and progress summaries; MCP-style tool
   registry with per-tool permissions, an approval broker, and graceful manual
   fallback when a model lacks tool calling.
4. **Quality gates** ✅ — zod at every boundary, Vitest unit tests for adapters
   (mocked fetch: SSE, errors, retries, redaction), repositories/migrations,
   diff and change-block parsers, path-traversal/symlink guards, and the tool
   registry/executor/approval broker; integration tests for the chat flow and
   the multi-round tool loop. `npm run build` typechecks both tsconfig projects.
5. **Automation & bots** ✅ — workflows (graphs, schedules, watch folders, a
   loopback trigger endpoint), scheduled prompt tasks, background agent runs
   and the agent inbox; Bot Mode (v46–v49): a roster of named bots built on
   agent profiles, canonical chats, durable bot-to-bot deliveries with visible
   handoffs, group rooms, heartbeats, per-bot Telegram bindings, attention
   states and deep-linked notifications.
6. **Personal agent** ✅ (v53, parity with OpenAI dots, xAI Grok Bot and Meta
   Muse) — see the section below.

## Personal-agent layer (v53)

Capability map against the three products (✅ = in Grasberg):

| Capability | dots | Grok Bot | Muse | Grasberg |
|---|---|---|---|---|
| Named always-on agent with persona, avatar, goal | ✅ | ✅ | ✅ | ✅ bots + `goal`, tray/login item |
| Projects tracked toward the goal | ✅ | | | ✅ `bot_projects`, `update_project` |
| Proactive work is read-only; proposes actions | ✅ | | ✅ | ✅ autonomous policy + `suggest_action` |
| Rule behaviours: act / act if requested / ask / hand off / never | ✅ | | | ✅ `ToolRuleEffect` + natural-language drafting |
| Read vs write per connector | | ✅ | ✅ (Sentinel) | ✅ `mcp_servers.access` (`readOnlyHint` trusted only on read-access servers) |
| Auto-review of outward actions | ✅ | | | ✅ economy-model reviewer |
| Passwords / payments always handed to the user | ✅ | ✅ | ✅ | ✅ sensitive fields → handoff, `hand_off` |
| Credential vault (model never sees passwords) | ✅ | ✅ | ✅ | ✅ `browser_logins` + `login` action |
| Watch the agent's computer, take over, hand back | ✅ | | ✅ | ✅ live frames + take over |
| Teach a task by demonstration → skill | | ✅ | | ✅ teach-a-task, `create_skill` |
| Connect apps (plugins / connectors) | ✅ 4000+ | ✅ | ✅ | ✅ catalog (incl. Zapier) + MCP OAuth |
| Slack / Teams / WhatsApp / email presence | ✅ Slack, Teams | | ✅ WhatsApp, email | ✅ Slack, Discord, Telegram, own email address |
| Learns from feedback | ✅ | | ✅ | ✅ thumbs/comments → agent memory |
| Pause, reset, anomaly stop | ✅ | | | ✅ pause/resume/reset + anomaly monitor |
| Control the user's own desktop | ✅ (local access) | | ✅ (Mac) | ✅ Windows `desktop` tool, Ctrl+Alt+Esc kill |
| Voice conversation | ✅ calls | | ✅ glasses | ✅ hands-free voice call (local STT) |
| Teams of agents with handoffs | roadmap | ✅ | | ✅ Bot Mode rooms + `message_agent` |

Deliberately not replicated: hosted cloud VMs (Grasberg is local-first; the
app runs in the tray), smart-glasses / pendant hardware, phone calls and SMS
(no telephony provider), WhatsApp (requires a verified business webhook).

Safety model in one paragraph: everything an agent does without a human click
is either read-only (proactive turns), covered by an explicit rule, or — when
it reaches outside the app — reviewed by a second model that can only ask or
stop. Secrets (logins, channel tokens, OAuth grants) live encrypted in
`tool_secrets` and are used by main, never shown to a model. The anomaly
monitor pauses a bot that loops, and the desktop tool has a global kill
switch. New inbound network surface: none permanent — the OAuth callback
listener exists only during a sign-in, on loopback.

Who counts as "the user" for permissions: only a verified owner (a paired
Slack / Discord / Telegram DM, the owner in a group, the desktop, the paired
phone). Every email — sender addresses can be forged — and every message from
another channel member runs under the channel-event policy: "act if
requested" rules ask, outward calls get auto-review, messaging a teammate
asks, and the member's text reaches the model wrapped as untrusted data.
