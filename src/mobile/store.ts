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
import type {
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

  init(): Promise<void>
  refreshConversations(): Promise<void>
  openConversation(id: string): Promise<void>
  closeConversation(): void
  newConversation(): Promise<void>
  sendMessage(text: string): Promise<void>
  stopStream(streamId: string): Promise<void>
  regenerate(messageId: string): Promise<void>
  respondApproval(requestId: string, approved: boolean): Promise<void>
  respondQuestion(requestId: string, answer: string): Promise<void>
  forgetDevice(): void
  setToast(toast: string | null): void
}

let tunnel: Tunnel | null = null
/**
 * init() runs from a React effect, and StrictMode double-fires effects in
 * development. Without this guard the second run would re-attempt pairing
 * (the first run already consumed the one-time offer → spurious error) and
 * leak the first tunnel behind the module variable. First call wins;
 * "Try again" reloads the page, which resets everything anyway.
 */
let initStarted = false

const tunnelRequest = <T>(channel: string, ...args: unknown[]): Promise<IpcResultLike<T>> => {
  if (!tunnel) {
    return Promise.resolve({
      ok: false,
      error: { code: 'network', message: 'Not connected.', retryable: true },
    })
  }
  return tunnel.request<T>(channel, args)
}

type IpcResultLike<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } }

export const useMobileStore = create<MobileStore>((set, get) => ({
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
    tunnel = new Tunnel(
      identity,
      (state, error) => {
        set({ tunnelState: state, tunnelError: error })
        if (state === 'online') void get().refreshConversations()
      },
      (channel, payload) => handlePush(channel, payload, set, get)
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
    if (!conversationId || !text.trim()) return
    const result = await tunnelRequest<{
      streamId: string
      userMessage: Message | null
      assistantMessage: Message
    }>(CHANNELS.chatSend, [{ conversationId, content: text.trim() }])
    if (!result.ok) {
      get().setToast(result.error.message)
      return
    }
    const { streamId, userMessage, assistantMessage } = result.data
    set((state) => ({
      messages: [...state.messages, ...(userMessage ? [userMessage] : []), assistantMessage],
      streams: {
        ...state.streams,
        [streamId]: { conversationId, text: '', reasoning: '' },
      },
    }))
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
    set((state) => ({
      streams: {
        ...state.streams,
        [result.data.streamId]: { conversationId, text: '', reasoning: '' },
      },
    }))
  },

  async respondApproval(requestId, approved) {
    set((state) => ({
      approvals: state.approvals.filter((a) => a.requestId !== requestId),
    }))
    const result = await tunnelRequest<void>(CHANNELS.toolsApprovalRespond, [
      requestId,
      approved,
      'once',
    ])
    if (!result.ok) get().setToast(result.error.message)
  },

  async respondQuestion(requestId, answer) {
    set((state) => ({
      questions: state.questions.filter((q) => q.requestId !== requestId),
    }))
    const result = await tunnelRequest<void>(CHANNELS.toolsQuestionRespond, [requestId, answer])
    if (!result.ok) get().setToast(result.error.message)
  },

  forgetDevice() {
    tunnel?.close()
    tunnel = null
    localStorage.removeItem('grasberg.remote.identity.v1')
    set({
      tunnelState: 'unpaired',
      tunnelError: null,
      conversations: [],
      currentId: null,
      conversation: null,
      messages: [],
      approvals: [],
      questions: [],
    })
  },

  setToast(toast) {
    set({ toast })
  },
}))

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
      set((state) => ({
        approvals: [...state.approvals.filter((a) => a.requestId !== (payload as ToolApprovalRequest).requestId), payload as ToolApprovalRequest],
      }))
      break
    case CHANNELS.toolApprovalSettled:
      set((state) => ({
        approvals: state.approvals.filter((a) => a.requestId !== payload),
      }))
      break
    case CHANNELS.userQuestionRequest:
      set((state) => ({
        questions: [...state.questions.filter((q) => q.requestId !== (payload as UserQuestionRequest).requestId), payload as UserQuestionRequest],
      }))
      break
    case CHANNELS.userQuestionSettled:
      set((state) => ({
        questions: state.questions.filter((q) => q.requestId !== payload),
      }))
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
  if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
    set((state) => {
      const current = state.streams[streamId]
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
