import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Conversation, ConversationSummary } from '../../src/shared/types'

vi.mock('@/stores/chat', () => ({ useChatStore: { getState: () => ({}) } }))
vi.mock('@/stores/spaces', () => ({ useSpacesStore: { getState: () => ({ activeSpaceId: null }) } }))
vi.mock('@/stores/ui', () => ({ toastError: vi.fn(), useUiStore: { getState: () => ({}) } }))
vi.mock('@/api/uld', () => ({ unwrap: async (value: Promise<{ data: unknown }>) => (await value).data }))

import { useConversationsStore } from '../../src/renderer/src/stores/conversations'

const getConversation = vi.fn()
const ordinary = { id: 'ordinary', mode: 'chat', title: 'Ordinary', spaceId: null, agentId: null } as Conversation
const bot = { ...ordinary, id: 'bot-chat', agentId: 'bot' }
const summary = (id: string): ConversationSummary => ({
  id, mode: 'chat', title: id, updatedAt: 0, projectRef: null, snippet: null,
})

beforeEach(() => {
  vi.stubGlobal('window', { uld: { conversations: { get: getConversation } } })
  getConversation.mockReset()
  useConversationsStore.setState({ summaries: [summary('ordinary')], search: '', modeFilter: 'chat' })
})
afterEach(() => vi.unstubAllGlobals())

it('keeps a completed bot reply out of the ordinary task sidebar', async () => {
  getConversation.mockResolvedValue({ ok: true, data: bot })
  await useConversationsStore.getState().syncSummary(bot.id, 'Bot reply')
  expect(useConversationsStore.getState().summaries.map((row) => row.id)).toEqual(['ordinary'])
})

it('removes an already inserted bot row while preserving ordinary rows', async () => {
  useConversationsStore.setState({ summaries: [summary('bot-chat'), summary('ordinary')] })
  getConversation.mockResolvedValue({ ok: true, data: bot })
  await useConversationsStore.getState().syncSummary(bot.id)
  expect(useConversationsStore.getState().summaries.map((row) => row.id)).toEqual(['ordinary'])
})

it('continues to refresh ordinary conversation snippets', async () => {
  getConversation.mockResolvedValue({ ok: true, data: ordinary })
  await useConversationsStore.getState().syncSummary(ordinary.id, 'New\nreply')
  expect(useConversationsStore.getState().summaries[0]).toMatchObject({ id: 'ordinary', snippet: 'New reply' })
})
