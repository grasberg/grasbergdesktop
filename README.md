# Grasberg Desktop

**Grasberg Desktop** is a local-first, cross-platform desktop client for working with multiple large-language-model providers — DeepSeek, GLM / Zhipu AI, MiniMax, and any OpenAI-compatible API (Ollama, vLLM, LM Studio, OpenRouter, …) — behind one polished interface. Your conversations live in a local SQLite database, your API keys are encrypted with your operating system's own key store, and nothing leaves your machine except the requests you send to the providers you configure. It offers three modes: **Chat** (streaming conversations with Markdown, reasoning display and model switching), **Cowork** (goal-oriented workspaces with notes, plans and checklists), and **Code** (ask questions about a local project and review diff proposals before anything touches disk).

> **Screenshots** — placeholder: add screenshots of Chat mode (light + dark), the model selector, and Settings → Providers here once the UI is finalized.

## Features

- **Multi-provider** — first-class adapters for DeepSeek, GLM / Zhipu AI and MiniMax, plus a generic OpenAI-compatible provider type for anything else.
- **Streaming chat** — token-by-token streaming with stop, regenerate, and edit-and-rerun; reasoning/thinking output shown separately for models that emit it (e.g. `deepseek-reasoner`).
- **Secure key storage** — API keys are encrypted at rest with Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux libsecret) and never leave the main process.
- **Local-first** — all history, settings and provider config in a local SQLite database. No accounts, no cloud sync, no telemetry.
- **Model catalog + live listing** — known models with capability badges (tools, vision, reasoning, context length); live `/models` listing where the provider supports it, with catalog fallback.
- **Markdown rendering** — GitHub-flavored Markdown with syntax-highlighted code blocks.
- **Per-conversation overrides** — provider, model, system prompt and sampling parameters per conversation, with sensible global defaults.
- **Three modes** — **Chat** (streaming conversations), **Cowork** (goal-oriented workspaces with notes, plans, checklists and progress summaries; clear separation of your instructions from assistant suggestions and saved notes), and **Code** (open a local folder only with explicit permission, browse the file tree, ask questions about the project, and review proposed changes as diffs that are written to disk only when you click Apply — with a staleness guard that refuses to overwrite a file that changed since the change was proposed).
- **Tool system with real MCP** — built-in tools (file search, a BM25 `repo_map` code locator, read file, list directory, fetch URL, shell-command *suggestions* that are never executed), user-defined **custom HTTP tools**, and connections to external **MCP (Model Context Protocol) servers** over stdio or HTTP. Every tool goes through the same per-tool permission model; sensitive tools require explicit approval, and models without tool calling fall back to manual instructions.
- **Vision / image input** — attach images to vision-capable models (sent as OpenAI content parts; images are stored on disk, not inline in the database).
- **Prompt library** — save reusable prompts and insert them into the composer or set one as a conversation's system prompt.
- **Context compaction** — optionally auto-summarize long conversations so they stay within the model's context window.
- **Cost estimate & export** — an approximate per-message cost next to token usage, and one-click export of a conversation to Markdown or JSON.
- **Light / dark / system theme**, command palette, keyboard shortcuts, onboarding wizard.

## Why Electron (not Tauri)?

- **TypeScript end-to-end.** One language across main process, preload and renderer — no Rust core to maintain alongside the frontend.
- **First-party encrypted key storage.** Electron's built-in [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) uses DPAPI on Windows, the Keychain on macOS and libsecret on Linux, with no third-party plugin.
- **Mature cross-platform packaging.** electron-builder produces NSIS installers, DMGs, AppImages and debs from one config.
- **Zero native-toolchain friction for contributors.** `npm install && npm run dev` is all it takes — no Rust toolchain required.

The trade-off is larger binaries (~90 MB). We consider that acceptable for a desktop power tool; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full decision matrix and process model.

## Getting started

Prerequisites: **Node.js 20+** and **npm**.

```bash
npm install
npm run dev
```

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start the app in development mode (electron-vite, hot reload) |
| `npm run build` | Typecheck both tsconfig projects, then build main/preload/renderer to `out/` |
| `npm start` | Preview the built app (`electron-vite preview`) |
| `npm run typecheck` | `tsc --noEmit` against `tsconfig.node.json` and `tsconfig.web.json` |
| `npm test` | Run the Vitest suite once (`npm run test:watch` for watch mode) |
| `npm run package:win` | Build + package a Windows NSIS installer into `release/` |
| `npm run package:mac` | Build + package macOS DMG + ZIP into `release/` |
| `npm run package:linux` | Build + package Linux AppImage + deb into `release/` |

## Building installers

Packaging is configured in [`electron-builder.yml`](electron-builder.yml); artifacts land in `release/`.

- **Windows:** `npm run package:win` → NSIS installer (per-user, install location choosable).
- **macOS:** `npm run package:mac` → DMG + ZIP.
- **Linux:** `npm run package:linux` → AppImage + deb.

> **Note:** cross-OS packaging is generally not supported — build Windows installers on Windows, DMGs on macOS, and Linux packages on Linux (or use a CI matrix with one runner per OS). **Code signing is intentionally unconfigured**; add your own certificates/notarization config to `electron-builder.yml` before distributing builds publicly.

## Provider setup

Add a provider in **Settings → Providers**, pick a type, and paste an API key. Keys are encrypted immediately and only a masked preview (like `sk-…4f2a`) is ever shown again.

| Provider | Where to get a key | Default base URL |
|---|---|---|
| DeepSeek | <https://platform.deepseek.com> | `https://api.deepseek.com/v1` |
| GLM / Zhipu AI | <https://open.bigmodel.cn> | `https://open.bigmodel.cn/api/paas/v4` |
| MiniMax | <https://platform.minimax.io> | `https://api.minimax.io/v1` |
| OpenAI-compatible (custom) | your server / vendor | — (you provide it) |

Notes:

- **Zhipu international:** users on the international platform (<https://api.z.ai>) can add an **OpenAI-compatible (custom)** provider with their z.ai base URL.
- **MiniMax China mainland:** use `api.minimaxi.com` via an **OpenAI-compatible (custom)** provider.
- **Anything else:** any OpenAI-compatible server works via the custom type — Ollama, vLLM, LM Studio, OpenRouter, and so on. Point it at the server's `/v1` base URL.

## Security & privacy

- API keys are encrypted at rest via Electron `safeStorage` (OS keychain-backed) and stored only as ciphertext in SQLite. They are never sent to the renderer, never logged, and error messages pass through a redaction step before being persisted or displayed. If OS encryption is unavailable at first launch (e.g. a locked Linux keyring), keys are held in a clearly-marked reversible fallback and automatically re-encrypted once the key store becomes available.
- **Provider base URLs must use `https://`** (plain `http://` is allowed only for `localhost`/`127.0.0.1`), so your Bearer key is never sent in cleartext to a remote host.
- No telemetry, no analytics, no phone-home. The only network traffic is to the provider endpoints you configure.
- Everything is stored locally in SQLite under Electron's per-user data directory:
  - Windows: `%APPDATA%\Grasberg Desktop`
  - macOS: `~/Library/Application Support/Grasberg Desktop`
  - Linux: `~/.config/Grasberg Desktop`
- The renderer is fully sandboxed (`contextIsolation: true`, `sandbox: true`, no Node integration) and talks to the main process only through a typed, validated IPC surface.

## Project structure

```
src/
  shared/      types.ts ipc.ts schemas.ts catalog.ts   ← the contract (no runtime deps)
  main/        Electron main process
    db/          SQLite (node-sqlite3-wasm), migrations, repositories
    providers/   adapter interface + per-provider adapters + registry
    keys/        safeStorage-backed keystore
    services/    chat orchestration (streams, stop, regenerate, tool loop)
    code/        Code-mode project access, file tree, diff apply gate
    tools/       MCP-style tool registry, executor, permissions
    ipc/         zod-validated IPC handlers
  preload/     contextBridge implementation of window.uld
  renderer/    React 19 + Zustand UI (Chat, Cowork, Code, Settings)
tests/         Vitest unit + integration tests
docs/          ARCHITECTURE.md · DB_SCHEMA.md · ADDING_A_PROVIDER.md
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the process model and streaming pipeline, and [docs/DB_SCHEMA.md](docs/DB_SCHEMA.md) for the database schema.

## Testing

```bash
npm test
```

Unit tests cover the provider adapters (mocked `fetch`: SSE parsing, error normalization, retries, key redaction), the database repositories and migrations, the unified-diff and change-block parsers, Code-mode path-traversal / symlink-escape guards, and the tool registry, executor and approval broker. Integration tests cover the chat flow and the multi-round tool-call loop. The suite runs with `node-sqlite3-wasm` against real temp databases (no Electron required).

## Status

All three modes and the tool system are implemented and covered by the test suite:

1. **Chat mode** — multi-provider streaming chat, secure keys, SQLite history, settings, onboarding, themes, command palette.
2. **Code mode** — explicit folder grant, file tree, project Q&A, diff proposals with apply/reject gates, staleness guard, and change history. The app never writes to a project file or executes a command without an explicit click; terminal commands are only ever presented as copyable suggestions.
3. **Cowork mode + tool system** — workspaces with notes/plans/checklists/tasks/docs and progress summaries, plus a tool registry (built-ins, custom HTTP tools and real MCP servers) with per-tool permissions and graceful fallback for non-tool-calling models.
4. **Beyond the MVP** — vision/image input, a `repo_map` code locator, custom-HTTP-tool and MCP-server management UIs, a prompt library, context compaction, cost estimates, and conversation export are all implemented.

### Possible next steps

- Richer diff viewer and multi-file change sets.
- MCP OAuth transports and a "search mode" for servers exposing very many tools.
- Image generation and speech (input/output).

## Contributing

The most common contribution is a new provider adapter — see [docs/ADDING_A_PROVIDER.md](docs/ADDING_A_PROVIDER.md) for a step-by-step walkthrough. Bug reports and PRs welcome.

## License

[MIT](LICENSE) © 2026 Grasberg Desktop contributors.
