import { afterEach, expect, it, vi } from 'vitest'
import type { Conversation, Message } from '../../src/shared/types'

const { syncSummary } = vi.hoisted(() => ({ syncSummary: vi.fn() }))
vi.mock('@/stores/conversations', () => ({ useConversationsStore: { getState: () => ({ syncSummary }) } }))
vi.mock('@/stores/settings', () => ({ useSettingsStore: { getState: () => ({}) } }))
vi.mock('@/stores/ui', () => ({ useUiStore: { getState: () => ({}) } }))
vi.mock('@/api/uld', () => ({
  unwrap: async (value: Promise<{ data: unknown }>) => (await value).data,
  toNormalized: (error: unknown) => error,
}))

import { useChatStore } from '../../src/renderer/src/stores/chat'

afterEach(() => vi.unstubAllGlobals())

it('refreshes the sidebar snippet after selecting a comparison winner', async () => {
  const conversation = { id: 'comparison', mode: 'chat', modelId: 'winner' } as Conversation
  const message = { id: 'answer', content: 'Selected answer', status: 'complete' } as Message
  vi.stubGlobal('window', { uld: { chat: {
    pickCompareWinner: vi.fn().mockResolvedValue({ ok: true, data: { conversation, message } }),
  } } })
  useChatStore.setState({ conversation, messages: [{ ...message, content: '' }], streaming: null })
  await useChatStore.getState().pickCompareWinner(message.id, 1)
  expect(useChatStore.getState().messages[0].content).toBe('Selected answer')
  expect(syncSummary).toHaveBeenCalledWith('comparison', 'Selected answer')
})
