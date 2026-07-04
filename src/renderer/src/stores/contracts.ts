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
  ProviderConfig,
  ProviderConfigInput,
  ProviderConfigPatch,
  ProviderTypeMeta,
  StreamEventEnvelope,
  TestConnectionResult,
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
}

export interface ConversationsStoreState {
  summaries: ConversationSummary[]
  activeId: string | null
  search: string
  modeFilter: ConversationMode | 'all'
  loaded: boolean
  load(): Promise<void>
  setSearch(q: string): void
  setModeFilter(mode: ConversationMode | 'all'): void
  /** Creates and selects a new conversation. */
  create(mode: ConversationMode): Promise<Conversation>
  select(id: string | null): void
  rename(id: string, title: string): Promise<void>
  remove(id: string): Promise<void>
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
  send(content: string, attachments?: Attachment[]): Promise<void>
  stop(): Promise<void>
  regenerate(messageId: string): Promise<void>
  editAndRerun(messageId: string, newContent: string): Promise<void>
  /** Update the open conversation's provider/model/systemPrompt/params. */
  updateConversation(patch: {
    providerId?: string | null
    modelId?: string | null
    systemPrompt?: string | null
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

export interface UiStoreState {
  /** Resolved theme actually applied to <html data-theme>. */
  resolvedTheme: 'light' | 'dark'
  settingsOpen: boolean
  paletteOpen: boolean
  shortcutsOpen: boolean
  /** The Workflows builder surface replaces the main area when true. */
  workflowsOpen: boolean
  toasts: Toast[]
  setResolvedTheme(t: 'light' | 'dark'): void
  openSettings(open: boolean): void
  openPalette(open: boolean): void
  openShortcuts(open: boolean): void
  openWorkflows(open: boolean): void
  toast(message: string, kind?: ToastKind): void
  dismissToast(id: string): void
}
