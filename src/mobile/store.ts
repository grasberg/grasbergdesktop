/**
 * The mobile app's single store: connection state, conversation list, the
 * open conversation with live streaming, and the interactive cards (tool
 * approvals / model questions) that follow the user between views.
 *
 * Pushes are hints; requests are truth — on every reconnect or 'changed'
 * push the affected data is re-fetched, so a dropped frame never leaves the
 * UI stale (and the desktop needs no replay buffer).
 */

import { create } from 'zustand'
import { CHANNELS } from '@shared/ipc'
import type { IpcResult } from '@shared/ipc'
import type { RemoteCapabilities } from '@shared/remote-protocol'
import type {
  ChatSendResult,
  Conversation,
  ConversationSummary,
  Message,
  StreamEventEnvelope,
  ToolApprovalRequest,
  UserQuestionRequest,
} from '@shared/types'
import {
  clearUrlSecret,
  desktopIdFromUrl,
  loadIdentity,
  pairOverRelay,
  pairingSecretFromUrl,
  relayUrlFromUrl,
  saveIdentity,
  Tunnel,
  type TunnelState,
} from './tunnel'

interface StreamState {
  conversationId: string
  text: string
  reasoning: string
}

interface MobileStore {
  capabilities: RemoteCapabilities | null
  tunnelState: TunnelState
  tunnelError: string | null
  appVersion: string | null
  conversations: ConversationSummary[]
  conversationsLoading: boolean
  currentId: string | null
  conversation: Conversation | null
  messages: Message[]
  streams: Record<string, StreamState>
  approvals: ToolApprovalRequest[]
  questions: UserQuestionRequest[]
  toast: string | null
  drafts: Record<string, string>
  sends: Record<string, { requestId: string; text: string; status: 'sending' | 'failed'; error?: string }>
  responding: Record<string, boolean>
  setDraft(id: string, text: string): void
  syncPending(): Promise<void>

  init(): Promise<void>
  refreshConversations(): Promise<void>
  openConversation(id: string): Promise<void>
  closeConversation(): void
  newConversation(): Promise<void>
  sendMessage(text: string): Promise<boolean>
  stopStream(streamId: string): Promise<void>
  regenerate(messageId: string): Promise<void>
  respondApproval(requestId: string, approved: boolean): Promise<boolean>
  respondQuestion(requestId: string, answer: string): Promise<boolean>
  forgetDevice(): void
  setToast(toast: string | null): void
}

let tunnel: Tunnel | null = null
let draftStorageKey: string | null = null
type PendingSnapshot = { approvals: ToolApprovalRequest[]; questions: UserQuestionRequest[] }
let pendingSync: Promise<void> | null = null
let pendingChanges: Array<(snapshot: PendingSnapshot) => PendingSnapshot> = []
function changePending(change: (snapshot: PendingSnapshot) => PendingSnapshot, set: SetState): void {
  if (pendingSync) pendingChanges.push(change)
  set(change)
}
// A terminal push can beat its send/regenerate reply. Keep a bounded recent set.
const finishedStreams = new Set<string>()
/**
 * init() runs from a React effect, and StrictMode double-fires effects in
 * development. Without this guard the second run would re-attempt pairing
 * (the first run already consumed the one-time offer → spurious error) and
 * leak the first tunnel behind the module variable. First call wins;
 * "Try again" reloads the page, which resets everything anyway.
 */
let initStarted = false

const tunnelRequest = <T>(channel: string, args: unknown[] = []): Promise<IpcResultLike<T>> => {
  if (!tunnel) {
    return Promise.resolve({
      ok: false,
      error: { code: 'network', message: 'Not connected.', retryable: true },
    })
  }
  return tunnel.request<T>(channel, args).catch(() => ({
    ok: false, error: { code: 'network', message: 'Connection interrupted. Reconnect and try again.', retryable: true },
  }))
}

const remoteListeners = new Set<(channel: string, payload: unknown) => void>()
export const requestRemote = <T>(channel: string, args: unknown[] = []): Promise<IpcResult<T>> => tunnelRequest<T>(channel, args) as Promise<IpcResult<T>>
export function subscribeRemote(callback: (channel: string, payload: unknown) => void): () => void { remoteListeners.add(callback); return () => { remoteListeners.delete(callback) } }

type IpcResultLike<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } }

export const useMobileStore = create<MobileStore>((set, get) => ({
  capabilities: null,
  tunnelState: 'connecting',
  tunnelError: null,
  appVersion: null,
  conversations: [],
  conversationsLoading: false,
  currentId: null,
  conversation: null,
  messages: [],
  streams: {},
  approvals: [],
  questions: [],
  toast: null,
  drafts: {},
  sends: {},
  responding: {},
  setDraft(id, text) { set(s => ({ drafts: { ...s.drafts, [id]: text } })) },
  syncPending() {
    if (pendingSync) return pendingSync
    pendingChanges = []
    pendingSync = Promise.resolve().then(() => tunnelRequest<PendingSnapshot>(CHANNELS.toolsPending)).then(result => {
      if (result.ok && result.data) set(pendingChanges.reduce((snapshot, change) => change(snapshot), result.data))
    }).finally(() => { pendingSync = null; pendingChanges = [] })
    return pendingSync
  },

  async init() {
    if (initStarted) return
    initStarted = true
    const secret = pairingSecretFromUrl()
    if (secret) {
      const desktopId = desktopIdFromUrl()
      const relayUrl = relayUrlFromUrl()
      set({ tunnelState: 'pairing', tunnelError: null })
      if (!desktopId || !relayUrl) {
        set({ tunnelState: 'error', tunnelError: 'This pairing link is incomplete.' })
        return
      }
      try {
        const paired = await pairOverRelay(desktopId, secret, relayUrl)
        saveIdentity({
          relayUrl,
          desktopId,
          deviceId: paired.deviceId,
          token: paired.token,
          keyBase64: paired.keyBase64,
          nextRequestSeq: paired.nextRequestSeq,
        })
        // The secret has served its purpose; it must not survive in the URL.
        clearUrlSecret()
      } catch (e) {
        set({
          tunnelState: 'error',
          tunnelError: e instanceof Error ? e.message : 'Pairing failed.',
        })
        return
      }
    }
    const identity = loadIdentity()
    if (!identity) {
      set({ tunnelState: 'unpaired', tunnelError: null })
      return
    }
    draftStorageKey = `grasberg.drafts.v1.${identity.desktopId}.${identity.deviceId}`
    try {
      const saved = JSON.parse(localStorage.getItem(draftStorageKey) ?? '{}') as Partial<MobileStore>
      const drafts = Object.fromEntries(Object.entries(saved.drafts ?? {}).filter(([id, value]) => id.length < 128 && typeof value === 'string'))
      const sends = Object.fromEntries(Object.entries(saved.sends ?? {}).filter(([, send]) =>
        typeof send?.text === 'string' && /^[0-9a-f-]{36}$/i.test(send.requestId)
      ).map(([id, send]) => [id, { ...send, status: 'failed' as const, error: 'Delivery was not confirmed. Retry safely with the same message.' }]))
      set({ drafts, sends })
    } catch { /* Storage may be unavailable in private browsing. Keep the in-memory draft. */ }
    tunnel = new Tunnel(
      identity,
      (state, error) => {
        set({ tunnelState: state, tunnelError: error })
        if (state === 'online') {
          const connectedTunnel = tunnel
          void requestRemote<RemoteCapabilities>(CHANNELS.remoteCapabilities).then(r => { if (r.ok && tunnel === connectedTunnel && tunnel) set({ capabilities: r.data }) })
          void get().refreshConversations()
          void get().syncPending()
          const id = get().currentId
          if (id) void get().openConversation(id)
        }
      },
      (channel, payload) => {
        if (channel === CHANNELS.remoteCapabilitiesChanged) {
          const capabilities = payload as RemoteCapabilities
          if (get().capabilities?.access === 'full' && capabilities.access !== 'full') { location.reload(); return }
          set({ capabilities })
        }
        for (const listener of remoteListeners) listener(channel, payload)
        handlePush(channel, payload, set, get)
      }
    )
    tunnel.connect()
  },

  async refreshConversations() {
    set({ conversationsLoading: true })
    const result = await tunnelRequest<ConversationSummary[]>(CHANNELS.convList, [{}])
    if (result.ok) set({ conversations: result.data, conversationsLoading: false })
    else set({ conversationsLoading: false })
  },

  async openConversation(id) {
    set({ currentId: id, messages: [], conversation: null })
    const [convResult, msgResult] = await Promise.all([
      tunnelRequest<Conversation>(CHANNELS.convGet, [id]),
      tunnelRequest<Message[]>(CHANNELS.convMessages, [id]),
    ])
    if (get().currentId !== id) return // the user moved on
    if (convResult.ok) set({ conversation: convResult.data })
    if (msgResult.ok) set({ messages: msgResult.data })
  },

  closeConversation() {
    set({ currentId: null, conversation: null, messages: [] })
  },

  async newConversation() {
    const result = await tunnelRequest<Conversation>(CHANNELS.convCreate, [
      { mode: 'chat', title: null },
    ])
    if (!result.ok) {
      get().setToast(result.error.message)
      return
    }
    await get().refreshConversations()
    await get().openConversation(result.data.id)
  },

  async sendMessage(text) {
    const conversationId = get().currentId
    if (!conversationId || !text.trim() || get().sends[conversationId]?.status === 'sending') return false
    const old = get().sends[conversationId]
    const requestId = old?.text === text.trim() ? old.requestId : crypto.randomUUID()
    set(s => ({ sends: { ...s.sends, [conversationId]: { requestId, text: text.trim(), status: 'sending' } } }))
    const result = await tunnelRequest<ChatSendResult>(CHANNELS.chatSend, [{ conversationId, content: text.trim(), clientRequestId: requestId }])
    if (!result.ok) {
      set(s => ({ sends: { ...s.sends, [conversationId]: { requestId, text: text.trim(), status: 'failed', error: result.error.message } } }))
      get().setToast(result.error.message)
      return false
    }
    const data = result.data
    set((state) => {
      const incoming = 'queued' in data
        ? [data.userMessage]
        : [...(data.userMessage ? [data.userMessage] : []), data.assistantMessage]
      return {
        sends: Object.fromEntries(Object.entries(state.sends).filter(([id]) => id !== conversationId)),
        drafts: state.drafts[conversationId]?.trim() === text.trim() ? { ...state.drafts, [conversationId]: '' } : state.drafts,
        messages: state.currentId === conversationId
          ? [...state.messages, ...incoming.filter((m) => !state.messages.some((existing) => existing.id === m.id))]
          : state.messages,
        streams: 'queued' in data || finishedStreams.has(data.streamId) ? state.streams : {
          ...state.streams,
          [data.streamId]: state.streams[data.streamId] ?? { conversationId, text: '', reasoning: '' },
        },
      }
    })
    if ('queued' in data && data.replayed && get().currentId === conversationId) await get().openConversation(conversationId)
    return true
  },

  async stopStream(streamId) {
    const result = await tunnelRequest<void>(CHANNELS.chatStop, [streamId])
    if (!result.ok) get().setToast(result.error.message)
  },

  async regenerate(messageId) {
    const conversationId = get().currentId
    if (!conversationId) return
    const result = await tunnelRequest<{
      streamId: string
      userMessage: Message | null
      assistantMessage: Message
    }>(CHANNELS.chatRegenerate, [{ conversationId, messageId }])
    if (!result.ok) {
      get().setToast(result.error.message)
      return
    }
    await get().openConversation(conversationId)
    if (finishedStreams.has(result.data.streamId)) return
    set((state) => ({
      streams: {
        ...state.streams,
        [result.data.streamId]: { conversationId, text: '', reasoning: '' },
      },
    }))
  },

  async respondApproval(requestId, approved) {
    if (get().responding[requestId]) return false
    set(s => ({ responding: { ...s.responding, [requestId]: true } }))
    const result = await tunnelRequest<void>(CHANNELS.toolsApprovalRespond, [
      requestId,
      approved,
      'once',
    ])
    set(s => ({ responding: { ...s.responding, [requestId]: false } }))
    if (result.ok) changePending(s => ({ ...s, approvals: s.approvals.filter(a => a.requestId !== requestId) }), set)
    if (!result.ok) get().setToast(result.error.message)
    return result.ok
  },

  async respondQuestion(requestId, answer) {
    if (get().responding[requestId]) return false
    set(s => ({ responding: { ...s.responding, [requestId]: true } }))
    const result = await tunnelRequest<void>(CHANNELS.toolsQuestionRespond, [requestId, answer])
    set(s => ({ responding: { ...s.responding, [requestId]: false } }))
    if (result.ok) changePending(s => ({ ...s, questions: s.questions.filter(q => q.requestId !== requestId) }), set)
    if (!result.ok) get().setToast(result.error.message)
    return result.ok
  },

  forgetDevice() {
    tunnel?.close()
    tunnel = null
    const identity = loadIdentity()
    if (identity) for (const key of Object.keys(localStorage)) if (key.startsWith(`grasberg.remote-draft.${identity.deviceId}.`)) localStorage.removeItem(key)
    localStorage.removeItem('grasberg.remote.identity.v1')
    if (draftStorageKey) localStorage.removeItem(draftStorageKey)
    draftStorageKey = null
    set({
      tunnelState: 'unpaired',
      capabilities: null,
      tunnelError: null,
      conversations: [],
      currentId: null,
      conversation: null,
      messages: [],
      approvals: [],
      questions: [],
      drafts: {}, sends: {}, responding: {},
    })
  },

  setToast(toast) {
    set({ toast })
  },
}))

useMobileStore.subscribe((state, previous) => {
  if (!draftStorageKey || (state.drafts === previous.drafts && state.sends === previous.sends)) return
  try { localStorage.setItem(draftStorageKey, JSON.stringify({ drafts: state.drafts, sends: state.sends })) }
  catch { /* The current draft stays in memory if device storage is full. */ }
})

type SetState = (
  partial: Partial<MobileStore> | ((state: MobileStore) => Partial<MobileStore>)
) => void
type GetState = () => MobileStore

function handlePush(channel: string, payload: unknown, set: SetState, get: GetState): void {
  if (channel === '__hello__') {
    const app = payload as { name?: string; version?: string }
    set({ appVersion: app.version ?? null })
    return
  }
  if (channel === CHANNELS.streamEvent) {
    handleStreamEvent(payload as StreamEventEnvelope, set, get)
    return
  }
  switch (channel) {
    case CHANNELS.conversationsChanged:
      void get().refreshConversations()
      if (get().currentId === (payload as { conversationId?: string })?.conversationId) {
        void get().openConversation(get().currentId!)
      }
      break
    case CHANNELS.toolApprovalRequest:
      changePending((state) => ({ ...state,
        approvals: [...state.approvals.filter((a) => a.requestId !== (payload as ToolApprovalRequest).requestId), payload as ToolApprovalRequest],
      }), set)
      break
    case CHANNELS.toolApprovalSettled:
      changePending((state) => ({ ...state,
        approvals: state.approvals.filter((a) => a.requestId !== payload),
      }), set)
      break
    case CHANNELS.userQuestionRequest:
      changePending((state) => ({ ...state,
        questions: [...state.questions.filter((q) => q.requestId !== (payload as UserQuestionRequest).requestId), payload as UserQuestionRequest],
      }), set)
      break
    case CHANNELS.userQuestionSettled:
      changePending((state) => ({ ...state,
        questions: state.questions.filter((q) => q.requestId !== payload),
      }), set)
      break
    case CHANNELS.mainNotice:
      get().setToast((payload as { message?: string })?.message ?? null)
      break
    default:
      break
  }
}

function handleStreamEvent(
  envelope: StreamEventEnvelope,
  set: SetState,
  get: GetState
): void {
  const { streamId, conversationId, event } = envelope
  if (finishedStreams.has(streamId)) return
  if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
    set((state) => {
      const current = state.streams[streamId] ?? (state.currentId === conversationId
        ? { conversationId, text: '', reasoning: '' } : undefined)
      if (!current) return state
      return {
        streams: {
          ...state.streams,
          [streamId]: {
            ...current,
            text: event.type === 'text-delta' ? current.text + event.text : current.text,
            reasoning:
              event.type === 'reasoning-delta' ? current.reasoning + event.text : current.reasoning,
          },
        },
      }
    })
    return
  }
  if (event.type === 'failover') {
    // A fallback model restarts the answer: drop the failed attempt's partial
    // text so the phone doesn't concatenate two answers.
    set((state) => {
      const current = state.streams[streamId]
      if (!current) return state
      return {
        streams: { ...state.streams, [streamId]: { ...current, text: '', reasoning: '' } },
      }
    })
    return
  }
  if (event.type === 'done' || event.type === 'error') {
    finishedStreams.add(streamId)
    if (finishedStreams.size > 256) finishedStreams.delete(finishedStreams.values().next().value!)
    set((state) => {
      const { [streamId]: _finished, ...rest } = state.streams
      return { streams: rest }
    })
    // Refresh with the persisted truth (final message, snippet, ordering).
    if (get().currentId === conversationId) void get().openConversation(conversationId)
    void get().refreshConversations()
    if (event.type === 'error') get().setToast(event.error.message)
  }
}
