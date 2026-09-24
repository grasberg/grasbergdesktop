/**
 * Interfaces for the renderer's zustand stores. Components depend on these
 * shapes; the store implementations in this folder must satisfy them.
 * Keep this file types-only.
 */

import type {
  AppLockSetPassphraseInput,
  AppLockStatus,
  AppSettings,
  Attachment,
  BotGroup,
  BotGroupActivation,
  BotGroupMode,
  BotRoster,
  BotsChangedEvent,
  Conversation,
  ConversationMode,
  ConversationSummary,
  Message,
  ModelInfo,
  NormalizedError,
  OAuthStatus,
  OptimizerRun,
  OptimizerStartInput,
  OptimizerVersion,
  Project,
  ProviderConfig,
  ProviderConfigInput,
  ProviderConfigPatch,
  ProviderTypeMeta,
  ResearchDepth,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTasksChangedEvent,
  ScheduledWorkflowStatus,
  Space,
  StreamEventEnvelope,
  TestConnectionResult,
  VoiceDownloadProgressEvent,
  VoiceModelId,
  VoiceStatus,
  WorkflowRunFinishedEvent,
  WorkflowRunListItem,
} from '@shared/types'
import type { LocalServerInfo } from '@shared/ipc'

export interface SettingsStoreState {
  settings: AppSettings | null
  loaded: boolean
  load(): Promise<void>
  update(patch: Partial<AppSettings>): Promise<void>
}

export interface ProvidersStoreState {
  providers: ProviderConfig[]
  types: ProviderTypeMeta[]
  /** Cached model lists per provider id. */
  modelsByProvider: Record<string, ModelInfo[]>
  modelsUpdatedAt: Record<string, number>
  loaded: boolean
  load(): Promise<void>
  create(input: ProviderConfigInput): Promise<ProviderConfig>
  update(id: string, patch: ProviderConfigPatch): Promise<void>
  remove(id: string): Promise<void>
  setKey(id: string, apiKey: string): Promise<void>
  deleteKey(id: string): Promise<void>
  test(id: string): Promise<TestConnectionResult>
  loadModels(id: string, force?: boolean): Promise<ModelInfo[]>
  /** Probes localhost for running model servers (Ollama, LM Studio, …). */
  detectLocal(): Promise<LocalServerInfo[]>
  /** Start "Sign in with ChatGPT" (opens the system browser); refreshes state. */
  oauthStart(id: string): Promise<OAuthStatus>
  /** Sign out of a provider's OAuth session; refreshes state. */
  oauthLogout(id: string): Promise<OAuthStatus>
}

export interface ConversationsStoreState {
  summaries: ConversationSummary[]
  activeId: string | null
  search: string
  /** The single current mode the sidebar is scoped to. */
  modeFilter: ConversationMode
  loaded: boolean
  /** Loads the current mode's most-recent tasks (grouped into the tree client-side). */
  load(): Promise<void>
  /**
   * Refreshes a single conversation's summary in place (title/updatedAt/snippet)
   * and floats it to the top, instead of reloading the whole list. Falls back to
   * a full load while a search filter is active. `snippet` is the latest message
   * text, if known.
   */
  syncSummary(id: string, snippet?: string): Promise<void>
  setSearch(q: string): void
  /** Switches the current mode and reloads. */
  setModeFilter(mode: ConversationMode): void
  /**
   * Creates and selects a new conversation in the given mode. Files it under
   * `projectRef` when given, otherwise standalone (unfiled).
   */
  create(mode: ConversationMode, projectRef?: string | null): Promise<Conversation>
  /** Forks a conversation at a message (whole transcript when messageId omitted), then selects the fork. */
  fork(id: string, messageId?: string): Promise<void>
  select(id: string | null): void
  rename(id: string, title: string): Promise<void>
  /** Files/unfiles a task under a project, updating the list in place. */
  setProject(id: string, projectRef: string | null): Promise<void>
  remove(id: string): Promise<void>
}

/** Private spaces (v45): the sidebar switcher + Settings → Privacy editor. */
export interface SpacesStoreState {
  spaces: Space[]
  /**
   * Renderer-session state only — every launch lands in the default space
   * (deliberate privacy posture; nothing persisted). Null = default space.
   */
  activeSpaceId: string | null
  loaded: boolean
  load(): Promise<void>
  /** Switches space: deselects the open conversation and reloads the list. */
  setActive(id: string | null): void
  create(name: string): Promise<void>
  rename(id: string, name: string): Promise<void>
  /** null = all providers. */
  setAllowlist(id: string, providerIds: string[] | null): Promise<void>
  remove(id: string): Promise<void>
}

/** App lock (v45): boot gating + the lock screen. */
export interface LockStoreState {
  status: AppLockStatus | null
  /** Error line for the lock screen (wrong passphrase / lockout), not a toast. */
  unlockError: string | null
  load(): Promise<void>
  /** False on a wrong passphrase (the error lands in unlockError). */
  unlock(passphrase: string): Promise<boolean>
  lockNow(): Promise<void>
  setPassphrase(input: AppLockSetPassphraseInput): Promise<void>
  /** Wired once at app start to window.uld.lock.onChanged. */
  handleChanged(evt: { locked: boolean }): void
}

export interface ProjectsStoreState {
  /** Projects for the currently loaded mode, newest first. */
  projects: Project[]
  /** The mode `projects` were loaded for (guards stale async responses). */
  mode: ConversationMode | null
  loaded: boolean
  /**
   * Ids of collapsed groups in the sidebar tree (the standalone "Tasks" group uses a
   * stable key). Persisted to localStorage so expand/collapse survives reloads.
   */
  collapsed: Set<string>
  /** Loads the projects for a mode into `projects`. */
  load(mode: ConversationMode): Promise<void>
  create(mode: ConversationMode, name: string): Promise<Project>
  rename(id: string, name: string): Promise<void>
  remove(id: string): Promise<void>
  /** Toggles a group's collapsed state (and persists it). */
  toggleCollapsed(id: string): void
  /** Force-expands a group (used after creating a task inside it). */
  expand(id: string): void
}

export interface ChatStoreState {
  /** Currently open conversation (null = empty state). */
  conversation: Conversation | null
  messages: Message[]
  /** Non-null while a generation is in flight. */
  streaming: { streamId: string; assistantMessageId: string } | null
  loading: boolean
  error: NormalizedError | null
  openConversation(id: string | null): Promise<void>
  send(
    content: string,
    attachments?: Attachment[],
    opts?: {
      /** Run this send as a compare ("Arena") fan-out through the given MoA preset. */
      comparePresetId?: string
      /** Run this send as a Deep Research run (the composer toggle). */
      research?: { depth?: ResearchDepth }
    }
  ): Promise<boolean>
  stop(): Promise<void>
  /**
   * Re-runs the last assistant message. `opts.overrides` regenerates with a
   * one-off provider/model without changing the conversation's model choice;
   * mode 'second-opinion' keeps the answer and streams the override model
   * beside it as compare columns (resolved via pickCompareWinner).
   */
  regenerate(
    messageId: string,
    opts?: {
      overrides?: { providerId?: string; modelId?: string }
      mode?: 'replace' | 'second-opinion'
    }
  ): Promise<void>
  /** Promote one advisor of a compare run to the message's answer. */
  pickCompareWinner(messageId: string, referenceIndex: number): Promise<void>
  editAndRerun(messageId: string, newContent: string): Promise<void>
  /** Update the open conversation's provider/model/systemPrompt/MoA preset. */
  updateConversation(patch: {
    providerId?: string | null
    modelId?: string | null
    systemPrompt?: string | null
    moaPresetId?: string | null
    knowledgeBaseId?: string | null
    /** Monthly spend cap in USD; null clears (v44). */
    budgetUsd?: number | null
  }): Promise<void>
  /** Wired once at app start to window.uld.chat.onStreamEvent. */
  handleStreamEvent(envelope: StreamEventEnvelope): void
  /**
   * Re-pulls a conversation main wrote to outside a stream (IM-bridge reply,
   * compaction). No-ops unless it is the open, non-streaming conversation.
   */
  handleConversationsChanged(conversationId: string): void
  clearError(): void
}

export type ToastKind = 'info' | 'success' | 'error'
export interface Toast {
  id: string
  kind: ToastKind
  message: string
}

/** An HTML/SVG snippet previewed in the sandboxed artifact drawer. */
export interface ArtifactPreview {
  title: string
  html: string
}

/**
 * Which surface fills the main area. 'home' is the boot default (the overview
 * dashboard); 'conversation' shows the active conversation's mode view and
 * falls back to Home while no conversation is selected. 'bots' is the Bot
 * Mode roster + group rooms surface (v46).
 */
export type AppView = 'home' | 'conversation' | 'workflows' | 'bots' | 'automation'

export interface UiStoreState {
  /** Resolved theme actually applied to <html data-theme>. */
  resolvedTheme: 'light' | 'dark'
  settingsOpen: boolean
  settingsTab: string
  paletteOpen: boolean
  shortcutsOpen: boolean
  /** The surface currently filling the main area. */
  view: AppView
  /**
   * Workflow the builder should open with (sidebar "Scheduled tasks" deep
   * link). Set by openWorkflows(open, workflowId); cleared by the next call.
   */
  workflowsInitialId: string | null
  /** Non-null shows the sandboxed artifact preview drawer over the chat. */
  artifactPreview: ArtifactPreview | null
  /**
   * One-shot text for the composer (starter-prompt cards). The Composer
   * consumes it into the draft, focuses the textarea, and clears it.
   */
  composerSeed: string | null
  toasts: Toast[]
  setResolvedTheme(t: 'light' | 'dark'): void
  setView(view: AppView): void
  openSettings(open: boolean, tab?: string): void
  openPalette(open: boolean): void
  openShortcuts(open: boolean): void
  seedComposer(text: string): void
  clearComposerSeed(): void
  /** Enters/leaves the Workflows surface ('workflows' ↔ 'conversation'). */
  openWorkflows(open: boolean, workflowId?: string | null): void
  openArtifactPreview(preview: ArtifactPreview | null): void
  toast(message: string, kind?: ToastKind): void
  dismissToast(id: string): void
}

export interface WorkflowsStoreState {
  /** Workflows that have a schedule (paused included) with latest-run status. */
  scheduled: ScheduledWorkflowStatus[]
  /** Latest runs across ALL workflows, newest first (bounded, truncated). */
  recentRuns: WorkflowRunListItem[]
  loaded: boolean
  /** Workflow ids with a manual "Run now" in flight (instant busy state). */
  runningIds: Record<string, true>
  /** Fetches the overview; cheap and idempotent (called on surface mounts). */
  load(): Promise<void>
  /** Runs a saved workflow now; toasts the outcome and refreshes. */
  runNow(id: string): Promise<void>
  /**
   * Pauses/resumes a schedule. Patches `scheduleEnabled` alone, so nothing
   * else in this (possibly stale) snapshot is written back over the stored
   * workflow — `status` is here for its id and the surface's own rendering.
   */
  toggleSchedule(status: ScheduledWorkflowStatus, enabled: boolean): Promise<void>
  /** Wired once at app start to window.uld.workflows.onRunFinished. */
  handleRunFinished(evt: WorkflowRunFinishedEvent): void
}

export interface ScheduledTasksStoreState {
  tasks: ScheduledTask[]
  loaded: boolean
  load(): Promise<void>
  create(input: ScheduledTaskInput): Promise<ScheduledTask | null>
  update(id: string, input: ScheduledTaskInput): Promise<ScheduledTask | null>
  setEnabled(id: string, enabled: boolean): Promise<void>
  remove(id: string): Promise<void>
  /** Runs the task now, outside its schedule (v50). */
  runNow(id: string): Promise<void>
  handleChanged(event: ScheduledTasksChangedEvent): void
}

/**
 * Bot Mode (v46): the Bots pane roster (bots + group rooms), the open room's
 * transcript, and roster actions. Loaded at boot and kept live by the one
 * app-wide push:botsChanged subscription (handleChanged) — deliveries, group
 * turns, routine mirrors and seen-stamps all land as coarse "refetch" events.
 */
export interface BotsStoreState {
  roster: BotRoster | null
  loaded: boolean
  /** Room open in the Bots view, or null = roster/empty state. */
  activeGroupId: string | null
  /** Transcript of the open room (refetched on push events). */
  groupMessages: Message[]
  /** Show hidden bots (dimmed) in the roster. */
  showHidden: boolean

  load(): Promise<void>
  /** Wired once at app start to window.uld.bots.onChanged. */
  handleChanged(event: BotsChangedEvent): void
  /** Opens the bot's canonical chat in the conversation surface. */
  openBotChat(agentId: string): Promise<void>
  /** The user is looking at the bot's chat: clears its unread state (v49). */
  markSeen(agentId: string): Promise<void>
  selectGroup(groupId: string | null): void
  createGroup(
    name: string,
    memberIds: string[],
    activation?: BotGroupActivation,
    observerIds?: string[],
    mode?: BotGroupMode,
    leadAgentId?: string | null
  ): Promise<BotGroup | null>
  /** A MoA preset as a visible ensemble room (v50); selects the new room. */
  createGroupFromMoaPreset(presetId: string): Promise<BotGroup | null>
  updateGroup(
    id: string,
    patch: {
      name?: string
      memberIds?: string[]
      activation?: BotGroupActivation
      observerIds?: string[]
      mode?: BotGroupMode
      leadAgentId?: string | null
    }
  ): Promise<boolean>
  deleteGroup(id: string): Promise<void>
  sendToGroup(groupId: string, content: string): Promise<boolean>
  stopGroup(groupId: string): Promise<void>
  setHidden(agentId: string, hidden: boolean): Promise<void>
  setShowHidden(show: boolean): void
}

/** Offline voice: whisper model management, push-to-talk STT and read-aloud. */
export interface VoiceStoreState {
  status: VoiceStatus | null
  loaded: boolean
  /** Push-to-talk capture in progress (composer mic button state). */
  recording: boolean
  /** Message currently being read aloud, null when silent. */
  speakingMessageId: string | null
  /** Latest download progress event (null when nothing is in flight). */
  downloadProgress: VoiceDownloadProgressEvent | null
  load(): Promise<void>
  download(modelId: VoiceModelId): Promise<void>
  cancelDownload(): Promise<void>
  remove(modelId: VoiceModelId): Promise<void>
  pickBinary(clear: boolean): Promise<void>
  /** Uploads a recorded WAV in chunks and returns the transcript. */
  sendRecording(wav: Uint8Array): Promise<string>
  setRecording(on: boolean): void
  /** Reads a message aloud (follows a still-streaming message live). */
  play(messageId: string): void
  stopSpeaking(): void
  /** Wired once at app start to window.uld.voice.onDownloadProgress. */
  handleDownloadProgress(e: VoiceDownloadProgressEvent): void
}

/** Optimizer runs (autonomous optimize-evaluate-commit loops per project). */
export interface OptimizerStoreState {
  runs: OptimizerRun[]
  loaded: boolean
  /** Versions per run id, loaded lazily when a run is expanded. */
  versions: Record<string, OptimizerVersion[]>
  load(): Promise<void>
  loadVersions(runId: string): Promise<void>
  start(input: OptimizerStartInput): Promise<OptimizerRun | null>
  stop(runId: string): Promise<void>
  /** Wired once at app start to window.uld.optimizer.onChanged. */
  handleChanged(event: { run: OptimizerRun }): void
}
