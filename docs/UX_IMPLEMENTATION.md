# UX implementation and verification

Updated 2026-09-06. Scope: the accepted desktop, phone browser, Android and iOS roadmap.
The full phone interface reuses the desktop React views and typed UldApi mapping.
Desktop services remain authoritative; Flutter packages the interface inside the native app.
The relay transports encrypted data and never supplies executable native application code.

## Implemented

| Area | Result |
| --- | --- |
| Chat and groups | Durable drafts, persisted request IDs and database receipts prevent duplicate messages after an interrupted acknowledgment. Drafts clear only after acknowledgment. Group rooms preserve drafts and respect scroll position. |
| Reconnect and approvals | Pending approvals/questions reconcile with snapshots and intervening pushes. Responses remain visible until acknowledged. Reconnect refreshes conversations and libraries. |
| Forms and dialogs | Shared focus handling, Escape/Tab behavior, discard confirmation, persistent errors and saving states. Work editors guard unsaved instructions when changing panels. |
| Models | Shared searchable picker, favorites, recent choices, capability filters, custom IDs, inheritance labels and catalog source/freshness. Providers use discovery and catalog fallbacks. |
| Bots | Identity, emoji/profile image, persona and model appear first; tools, routines, messaging and events are collapsed. Sticky save actions and mobile roster controls that work without hovering. |
| Settings | Searchable groups and keyboard tab navigation. The phone switches between section browsing and a full-width editor. |
| Automation | Scheduled prompts, bot routines and workflows share search, pause/resume, immediate runs and history. Routines can be edited without replacing their identity, budget or history. |
| Workflow builder | Guarded saves, validation before running, clear dry-run behavior, mobile panel/step navigation. Connections can be created or removed without dragging on a small canvas. |
| Provider setup | Guided model selection, connection testing, useful errors, stored-provider model refresh and explicit desktop OAuth handoff. |
| Knowledge | Embedding connection probe, compatible provider selection, per-file import results and embedding progress. |
| Voice and shortcuts | Readiness/setup guidance, native microphone permission handling and shortcut capture. Desktop-wide shortcuts are explained as desktop features on phones. |
| Backup | Preview an import before committing. Preview handles are bounded and device-bound. Existing merge rules are preserved; stored keys and security settings are excluded. |
| Work | Responsive files, preview, terminal, changes, tasks, Arena and Optimizer. Git refreshes on opening/focus and on demand. UTF-8 terminal decoding preserves characters split across chunks. |
| Optimizer | A model producing no file changes records a rejected attempt and retains the measured baseline instead of failing on an empty commit. |
| Device access | Existing pairs stay limited. Desktop grants full access once per device. Requests and in-flight responses check the grant; private chats and stored credentials stay excluded from management responses. |
| File transfer | Explicit upload/download and desktop-picker operations; owner binding, ordered idempotent chunks, size/expiry limits and checksum verification. Uploaded files can be consumed once. |
| Flutter | Packaged full interface through a nonce-bound WebView bridge. Keys stay in Dart. Secure local drafts, native file chooser/download bridge, microphone permission and guarded Android back navigation. Compact mode supports older desktops. |

## Live workflow checks

The QA harness (`scripts/qa-remote.mjs`) starts real Electron services, a loopback relay and
a local deterministic model in an empty temporary profile. User providers, API keys and
conversations are not copied. The browser was exercised at 390 x 844 pixels, with a
final workspace layout check at 1280 x 900 pixels.

Verified through computer use:

- Pairing, full-interface activation, connection loss and automatic reconnection.
- Chat draft recovery across navigation, acknowledged send and streamed Markdown/code.
- Bot creation with model/emoji selection; profile-image upload and persistence after
  restart. The final mobile form fits the viewport and keeps its save controls visible.
- Group creation with two bots, one user message, bot replies and acknowledged draft clearing.
- Settings search, mobile section navigation and provider connection/model discovery.
- Knowledge-base embedding probe and text upload/import as a document and chunks.
- Backup export, preview counts and committing a synthetic memory/prompt backup.
- Bot routine creation, pause, immediate run, history and editing while retaining pause state.
- Workflow template, actionable missing-delivery error, connection editing, successful
  model/output run and persisted history.
- Temporary Git folder, interactive file-backed HTML preview, terminal echo, branch creation,
  staging/committing a test file and updated Git status.
- Arena completion with two local candidates; Apply is disabled when no diff exists.
- Optimizer baseline evaluation: the no-change failure was reproduced, fixed with a
  regression test and checked again after restarting the final build. Three no-change
  rounds completed successfully, retained baseline score 1 and recorded rejected
  attempts without creating empty commits.

These checks validate application flows and the real encrypted transport. Deterministic
responses do not establish live account entitlements, provider billing, every account's
model availability, microphone hardware or third-party delivery integrations.

## Automated gates

- Both TypeScript projects pass.
- Full Vitest suite: 147 files / 1,477 tests pass with a clean exit. Workers are capped at
  four after an eight-worker run passed assertions but hit Vitest's progress RPC timeout.
- Flutter analyze: no issues. All 43 tests pass, including protocol interop, acknowledgment,
  packaged asset isolation and draft clearing with writes in flight.
- Final `npm run build`: both TypeScript projects, mobile client, relay and Electron
  bundles pass. `npm run bundle:check` reports `BUNDLE_OK` (1177.9 KiB).
- Isolated `npm run smoke`: `SMOKE_OK`, exit 0. The temporary profile emits a bundled
  skills fixture warning because it has a different app path; startup and migrations pass.
- `git diff --check` passes.
- The final mobile bundle was repackaged into Flutter assets. `flutter build apk --debug`
  passes and produces `mobile_flutter/build/app/outputs/flutter-apk/app-debug.apk`.
  Gradle warns that file_picker and mobile_scanner still apply the Kotlin Gradle plugin;
  this is a future Flutter compatibility warning, not a current build failure.

## Platform and release validation

Android debug compilation is available on this Windows host. No Android emulator or device
is connected: native WebView, file-picker and microphone behavior still needs a device run.
iOS compilation, signing and device testing require macOS/Xcode and were not performed here.

The complete phone interface requires a compatible desktop advertising its channels. Older
desktops keep compact mode. Remote setup, device grants, private spaces, desktop passphrase
and destructive bulk deletion remain desktop operations. OAuth sign-in opens the desktop's
authorization browser. Terminals remain line based; legacy Windows programs can use their
own output code page.

## Reproduce

```text
npm test
npm run build
npm run smoke
node scripts/qa-remote.mjs
npm run build:native-ui
cd mobile_flutter
flutter analyze
flutter test
flutter build apk --debug
```

Smoke creates a fresh temporary profile. To resume manual QA, pass the exact
grasberg-remote-qa-* directory printed by the harness; its marker is verified.
Never use the harness with a normal profile. It auto-grants full access to devices
paired with that synthetic profile and binds its three services to loopback only.
