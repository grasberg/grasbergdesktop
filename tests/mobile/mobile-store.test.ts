import { beforeEach, expect, it, vi } from 'vitest'
import type { Message } from '../../src/shared/types'
const { request, bridge } = vi.hoisted(() => ({
  request: vi.fn<(...args: unknown[]) => Promise<{ ok: true; data: unknown } | { ok: false; error: { code: string; message: string; retryable: boolean } }>>(async () => ({ ok: true, data: null })),
  bridge: { push: (_channel: string, _payload: unknown) => {} },
}))
vi.mock('../../src/mobile/tunnel', () => ({
  pairingSecretFromUrl: () => null,
  loadIdentity: () => ({}),
  Tunnel: class {
    constructor(_identity: unknown, _state: unknown, push: typeof bridge.push) { bridge.push = push }
    connect() {}
    request = request
  },
}))
import { useMobileStore } from '../../src/mobile/store'
import { CHANNELS } from '../../src/shared/ipc'

const userMessage = { id: 'u', role: 'user', content: 'queued' } as Message
const assistantMessage = { id: 'a', role: 'assistant', content: '' } as Message
beforeEach(async () => {
  request.mockReset().mockResolvedValue({ ok: true, data: null })
  await useMobileStore.getState().init()
  useMobileStore.setState({ currentId: 'c', messages: [], streams: {}, drafts: {}, sends: {}, approvals: [], questions: [], responding: {} })
})

it('passes IPC arguments in one array', async () => {
  await useMobileStore.getState().openConversation('c')
  expect(request).toHaveBeenCalledWith(CHANNELS.convGet, ['c'])
  expect(request).toHaveBeenCalledWith(CHANNELS.convMessages, ['c'])
})

it('handles queued replies without inventing a message or stream, including push races', async () => {
  request.mockResolvedValue({ ok: true, data: { queued: true, userMessage } })
  useMobileStore.setState({ messages: [userMessage] })
  await useMobileStore.getState().sendMessage('queued')
  expect(request).toHaveBeenCalledWith(CHANNELS.chatSend, [{ conversationId: 'c', content: 'queued', clientRequestId: expect.any(String) }])
  expect(useMobileStore.getState().messages).toEqual([userMessage])
  expect(useMobileStore.getState().streams).toEqual({})
  bridge.push(CHANNELS.streamEvent, { streamId: 'drained', conversationId: 'c', event: { type: 'text-delta', text: 'Hello' } })
  expect(useMobileStore.getState().streams.drained).toEqual({ conversationId: 'c', text: 'Hello', reasoning: '' })
  await useMobileStore.getState().stopStream('drained')
  expect(request).toHaveBeenCalledWith(CHANNELS.chatStop, ['drained'])
})

const offline = { ok: false as const, error: { code: 'network', message: 'offline', retryable: true } }
it('keeps a failed draft and reuses its request id, clearing only the acknowledged draft', async () => {
  const store = useMobileStore.getState()
  store.setDraft('c', 'hello')
  request.mockResolvedValueOnce(offline)
  expect(await store.sendMessage('hello')).toBe(false)
  const first = useMobileStore.getState().sends.c.requestId
  expect(useMobileStore.getState().drafts.c).toBe('hello')
  request.mockImplementationOnce(async () => {
    store.setDraft('c', 'a new thought')
    return { ok: true, data: { queued: true, userMessage } }
  })
  expect(await store.sendMessage('hello')).toBe(true)
  expect(request).toHaveBeenLastCalledWith(CHANNELS.chatSend, [expect.objectContaining({ clientRequestId: first })])
  expect(useMobileStore.getState().drafts.c).toBe('a new thought')
})

it('blocks duplicate clicks and releases the pending state after a transport exception', async () => {
  let reject!: (error: Error) => void
  request.mockImplementationOnce(() => new Promise((_, no) => { reject = no }))
  const sending = useMobileStore.getState().sendMessage('hello')
  expect(await useMobileStore.getState().sendMessage('hello')).toBe(false)
  reject(new Error('socket closed'))
  expect(await sending).toBe(false)
  expect(request).toHaveBeenCalledTimes(1)
  expect(useMobileStore.getState().sends.c.status).toBe('failed')
})

it('keeps failed approval answers and reconciles pushes that arrive during the snapshot', async () => {
  const approval = { requestId: 'r1', conversationId: 'c' }
  bridge.push(CHANNELS.toolApprovalRequest, approval)
  request.mockResolvedValueOnce(offline)
  expect(await useMobileStore.getState().respondApproval('r1', true)).toBe(false)
  expect(useMobileStore.getState().approvals).toEqual([approval])
  request.mockImplementationOnce(async () => {
    bridge.push(CHANNELS.toolApprovalSettled, 'r1')
    bridge.push(CHANNELS.userQuestionRequest, { requestId: 'q2', conversationId: 'c' })
    return { ok: true, data: { approvals: [approval], questions: [] } }
  })
  await useMobileStore.getState().syncPending()
  expect(useMobileStore.getState().approvals).toEqual([])
  expect(useMobileStore.getState().questions).toEqual([{ requestId: 'q2', conversationId: 'c' }])
})

it('keeps a normal response and deltas arriving before the send reply', async () => {
  bridge.push(CHANNELS.streamEvent, { streamId: 's', conversationId: 'c', event: { type: 'text-delta', text: 'Hello' } })
  request.mockResolvedValue({ ok: true, data: { streamId: 's', userMessage, assistantMessage } })
  useMobileStore.setState({ messages: [userMessage, assistantMessage] })
  await useMobileStore.getState().sendMessage('hello')
  expect(useMobileStore.getState().messages).toEqual([userMessage, assistantMessage])
  expect(useMobileStore.getState().streams.s.text).toBe('Hello')
})

it.each([true, false])('does not insert a late send response into a different conversation (queued=%s)', async (queued) => {
  request.mockImplementationOnce(async () => {
    useMobileStore.setState({ currentId: 'other', messages: [] })
    return { ok: true, data: queued ? { queued: true, userMessage } : { streamId: 's', userMessage, assistantMessage } }
  })
  await useMobileStore.getState().sendMessage('hello')
  expect(useMobileStore.getState().messages).toEqual([])
})

it.each(['done', 'error'])('does not recreate a stream when %s beats its send reply', async (type) => {
  const streamId = `terminal-${type}`
  request.mockImplementationOnce(async () => {
    bridge.push(CHANNELS.streamEvent, { streamId, conversationId: 'other', event: { type, error: { message: 'failed' } } })
    return { ok: true, data: { streamId, userMessage, assistantMessage } }
  })
  await useMobileStore.getState().sendMessage('hello')
  expect(useMobileStore.getState().streams[streamId]).toBeUndefined()
})
