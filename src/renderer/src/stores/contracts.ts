/**
 * Interfaces for the renderer's zustand stores. Components depend on these
 * shapes; the store implementations in this folder must satisfy them.
 * Keep this file types-only.
 */

import type {
  AppSettings,
  Attachment,
  Conversation,
  ConversationMode,
  ConversationSummary,
  Message,
  ModelInfo,
  NormalizedError,
  OAuthStatus,
  Project,
  ProviderConfig,
  ProviderConfigInput,
  ProviderConfigPatch,
  ProviderTypeMeta,
  ResearchDepth,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledWorkflowStatus,
  StreamEventEnvelope,
  TestConnectionResult,
  WorkflowRunFinishedEvent,
  WorkflowRunListItem,
} from '@shared/types'

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
  loaded: boolean
  load(): Promise<void>
  create(input: ProviderConfigInput): Promise<ProviderConfig>
  update(id: string, patch: ProviderConfigPatch): Promise<void>
  remove(id: string): Promise<void>
  setKey(id: string, apiKey: string): Promise<void>
  deleteKey(id: string): Promise<void>
  test(id: string): Promise<TestConnectionResult>
  loadModels(id: string): Promise<ModelInfo[]>
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
  select(id: string | null): void
  rename(id: string, title: string): Promise<void>
  /** Files/unfiles a task under a project, updating the list in place. */
  setProject(id: string, projectRef: string | null): Promise<void>
  remove(id: string): Promise<void>
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
  ): Promise<void>
  stop(): Promise<void>
  regenerate(messageId: string): Promise<void>
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
  }): Promise<void>
  /** Wired once at app start to window.uld.chat.onStreamEvent. */
  handleStreamEvent(envelope: StreamEventEnvelope): void
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
 * falls back to Home while no conversation is selected.
 */
export type AppView = 'home' | 'conversation' | 'workflows'

export interface UiStoreState {
  /** Resolved theme actually applied to <html data-theme>. */
  resolvedTheme: 'light' | 'dark'
  settingsOpen: boolean
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
  toasts: Toast[]
  setResolvedTheme(t: 'light' | 'dark'): void
  setView(view: AppView): void
  openSettings(open: boolean): void
  openPalette(open: boolean): void
  openShortcuts(open: boolean): void
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
  /** Pauses/resumes a schedule, preserving the rest of the workflow. */
  toggleSchedule(status: ScheduledWorkflowStatus, enabled: boolean): Promise<void>
  /** Wired once at app start to window.uld.workflows.onRunFinished. */
  handleRunFinished(evt: WorkflowRunFinishedEvent): void
}

export interface ScheduledTasksStoreState {
  tasks: ScheduledTask[]
  loaded: boolean
  load(): Promise<void>
  create(input: ScheduledTaskInput): Promise<ScheduledTask | null>
  setEnabled(id: string, enabled: boolean): Promise<void>
  remove(id: string): Promise<void>
}
