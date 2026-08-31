# Changelog

All notable user-facing changes to Grasberg. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow the installer artifact names (`Grasberg-Setup-<version>.exe`).

## Unreleased

### Added

- **Conversation forking.** "Fork from here" on any message copies the conversation and its transcript up to that point into a new conversation (model, system prompt, params and attachments carried over); forked conversations show a backlink chip to their original, with sibling forks one click away. (DB v41)
- **Watch-folder workflow triggers.** A workflow can now start when a file is created or changed in a folder you pick — glob filter, debounced and settle-checked so half-copied files never fire, with the file event (and small text-file content) delivered to the Input node. (DB v42)
- **Notebooks.** Living Markdown notes on the Home screen that both you and the assistant edit — new `list_documents`/`read_document`/`edit_document` tools (edits are approval-gated and versioned, 20 versions per note with one-click restore), plus Markdown export. (DB v43)
- **Budget guardrails + cost HUD.** Monthly spend caps on conversations, workflows and scheduled tasks plus a global cap: an interactive send asks once before continuing past a cap, background runs are skipped and recorded as failed. Headless generation now lands in a local usage ledger, the conversation header shows month-to-date estimated cost, and Settings → Usage gains a background-spend table and the budget controls (estimates only — unpriced models excluded). (DB v44)
- **Reliability autopilot.** Optional fallback model chains (Settings → Defaults): when a generation fails with a transient provider error (rate limit, outage, network, timeout) or returns an empty reply — and no tool has run yet — the app retries on the next model in the chain, annotates the answer with what it fell back from, and records the switch in the Activity log. Separate chains for interactive chats and background runs.
- **Morning brief.** A once-daily digest of unreviewed background results, recent failures and today's schedule, generated on the economy model (or a chosen agent), shown at the top of Home and optionally delivered as a desktop notification and to the paired Telegram chat (Settings → Agent platform).
- **Attachment intelligence.** PDFs extract their text layer on attach (50-page/200k-character cap, truncation noted in the text), scanned PDFs and images get a user-triggered "Extract text (OCR)" action, and a per-attachment "Send original PDF" toggle delivers the raw document to Anthropic/Google while other providers receive the extracted text.
- **Offline voice loop.** Push-to-talk dictation in the composer via a locally downloaded whisper.cpp model (SHA256-verified, managed in Settings → Voice), a Transcribe action on audio attachments (the transcript is what reaches the model — audio bytes never do), and read-aloud for assistant replies using the system voice (works while the answer is still streaming). Everything runs on-device; the microphone permission is granted only to the app's own window, and only while voice input is enabled.
- **Selection assistant.** A second global shortcut (default Ctrl+Shift+Space, configurable in Settings → Quick assistant) opens a frameless always-on-top mini window that acts on the text you copied: configurable quick actions (Explain / Translate / Rewrite / Summarize, each with an optional per-action model) stream an answer without saving anything, Esc dismisses, and "Open as conversation" turns the exchange into a real chat in the main window.
- **App lock & private spaces.** An optional scrypt passphrase locks the window on launch and after configurable idle (one IPC gate serves nothing but the lock screen while locked, and pushes are suppressed) — a privacy screen, not disk encryption. Private spaces add a sidebar switcher whose conversations are excluded from listing/search, backups (unless explicitly included on export), the phone tunnel, Telegram, notification previews and inbox previews, with an optional per-space provider allowlist enforced at generation time. Configured in Settings → Privacy. (DB v45)

## 1.1.0 — 2026-08-27

### Added

- **Remote access (phone).** Pair a phone by QR code and use the full app from mobile — conversations, live streaming, and tool approvals. The desktop dials out to a relay you host (see `relay/`); every frame is end-to-end encrypted, so the relay only routes ciphertext. Off by default; paired devices can be revoked in Settings → Bridges. (DB v38)
- **Optimizer.** A new Work-panel tab runs an autonomous improve-evaluate-commit loop on a project: an agent edits, your eval command scores the result, improvements become git commits, rejects are rolled back. Every attempt is recorded in a per-project experiment log that future sessions learn from. (DB v37)
- **Arena evolutionary rounds.** Code Arena can now run up to 5 rounds: an LLM judge picks each round's winning diff and the next round's candidates start from it.
- **Calendar schedules.** Workflows and scheduled tasks can run at fixed times ("08:00 on weekdays"), not just on intervals; missed slots run once at the next opportunity and are labeled as catch-ups. Per-task run history is kept. (DB v33)
- **Activity log.** Settings → Activity records every tool call with the reason it was allowed (auto / rule / approved / declined / blocked), redacted and capped. (DB v34)
- **Workflow trigger endpoint.** An opt-in, loopback-only, token-gated HTTP endpoint lets a git hook or CI job start a workflow. (DB v35)
- **Standing approval rules.** "Always allow" / "always ask" decisions persist as rules; a require-approval rule always outranks an allow rule. (DB v31)
- **Approvals from Telegram.** Pending tool approvals (and the assistant's `ask_user_question`) can be answered from the paired Telegram chat; the first answer from any channel wins.
- **Desktop notifications** with a tray unread badge, and an **agent inbox** on Home that gathers finished background results into one review queue.
- **Agent-owned memory.** Scheduled tasks name the agent profile that runs them, and each agent keeps its own private recollections. (DB v32)

### Changed

- Faster streaming for high-throughput local servers (SSE parsing no longer re-copies its buffer per line) and a leaner Usage view backed by a partial index. (DB v36)
- Secrets lookups and settings reads were tightened across the main process.

### Security

- The remote tunnel stores only a SHA-256 hash of each device's access token; the frame key lives in encrypted storage. The desktop never opens an inbound port for remote access.

## 1.0.0 — 2026-07

Initial public release: Chat + agentic Work mode, native adapters for OpenAI / Anthropic / Google Gemini / Amazon Bedrock plus DeepSeek, GLM/Zhipu, MiniMax and 120+ OpenAI-compatible presets, encrypted key storage, tools/MCP with a unified permission model, Mixture of Agents, Code Arena, workflows with scheduling, Telegram bridge, memory with dreaming, skills, knowledge bases, and local usage estimates.
