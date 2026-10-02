/**
 * Chat / Work / Bots as one tab row (v53): which tab is lit is derived from
 * what the main area shows, and each tab returns to where it was left.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, BotGroup, BotRoster } from '../../src/shared/types'

const openConversation = vi.fn(async () => undefined)
vi.mock('@/stores/chat', () => ({
  useChatStore: { getState: () => ({ openConversation, handleConversationsChanged: vi.fn() }) },
}))
vi.mock('@/stores/spaces', () => ({ useSpacesStore: { getState: () => ({ activeSpaceId: null }) } }))

import {
  forgetLocations,
  mainSectionFor,
  rememberLocation,
  restoreTargetFor,
  showBots,
  showMode,
} from '../../src/renderer/src/lib/main-sections'
import { useBotsStore } from '../../src/renderer/src/stores/bots'
import { useConversationsStore } from '../../src/renderer/src/stores/conversations'
import { useUiStore } from '../../src/renderer/src/stores/ui'

const roster = (botChats: string[], groups: string[] = []): BotRoster =>
  ({
    bots: botChats.map((chatConversationId, i) => ({
      agent: { id: `bot-${i}`, name: `Bot ${i}`, chatConversationId } as AgentProfile,
    })),
    groups: groups.map((id) => ({ group: { id, conversationId: `room-${id}` } as BotGroup })),
  }) as unknown as BotRoster

const getConversation = vi.fn()

beforeEach(() => {
  forgetLocations()
  getConversation.mockReset()
  openConversation.mockClear()
  vi.stubGlobal('window', {
    uld: {
      conversations: {
        get: getConversation,
        list: vi.fn(async () => ({ ok: true, data: [] })),
        onConversationsChanged: () => () => undefined,
      },
      bots: { groupMarkSeen: vi.fn(async () => ({ ok: true, data: null })), roster: vi.fn(async () => ({ ok: true, data: roster([]) })) },
    },
  })
  useUiStore.setState({ view: 'home' })
  useConversationsStore.setState({ activeId: null, modeFilter: 'chat', summaries: [], search: '' })
  useBotsStore.setState({ roster: roster(['bot-chat-1'], ['room-a']), activeGroupId: null, panel: { kind: 'none' } })
})
afterEach(() => vi.unstubAllGlobals())

describe('mainSectionFor', () => {
  it('lights Bots for the Bots surface and for a bot chat, else the mode filter', () => {
    const r = roster(['bot-chat-1'])
    expect(mainSectionFor({ view: 'bots', activeId: null, modeFilter: 'chat', roster: r })).toBe('bots')
    expect(mainSectionFor({ view: 'conversation', activeId: 'bot-chat-1', modeFilter: 'work', roster: r })).toBe('bots')
    expect(mainSectionFor({ view: 'conversation', activeId: 'c1', modeFilter: 'work', roster: r })).toBe('work')
    // A bot chat id left over behind Home does not keep Bots lit.
    expect(mainSectionFor({ view: 'home', activeId: 'bot-chat-1', modeFilter: 'chat', roster: r })).toBe('chat')
  })
})

describe('restoreTargetFor', () => {
  it('returns Bots to the bot chat or room it left, if it still exists', () => {
    const r = roster(['bot-chat-1'], ['room-a'])
    expect(restoreTargetFor('bots', { view: 'conversation', conversationId: 'bot-chat-1', groupId: null }, r)).toEqual({
      view: 'conversation', conversationId: 'bot-chat-1', groupId: null,
    })
    expect(restoreTargetFor('bots', { view: 'conversation', conversationId: 'deleted-bot', groupId: null }, r).view).toBe('bots')
    expect(restoreTargetFor('bots', { view: 'bots', conversationId: null, groupId: 'room-a' }, r).groupId).toBe('room-a')
    expect(restoreTargetFor('bots', { view: 'bots', conversationId: null, groupId: 'gone' }, r).groupId).toBeNull()
    expect(restoreTargetFor('bots', undefined, r)).toEqual({ view: 'bots', conversationId: null, groupId: null })
  })

  it('returns Chat / Work to their conversation or surface, else Home', () => {
    const r = roster(['bot-chat-1'])
    expect(restoreTargetFor('chat', { view: 'conversation', conversationId: 'c1', groupId: null }, r).conversationId).toBe('c1')
    expect(restoreTargetFor('work', { view: 'automation', conversationId: null, groupId: null }, r).view).toBe('automation')
    expect(restoreTargetFor('chat', undefined, r).view).toBe('home')
    expect(restoreTargetFor('chat', { view: 'conversation', conversationId: 'bot-chat-1', groupId: null }, r).view).toBe('home')
  })
})

describe('switching tabs', () => {
  it('Chat → Bots → Chat comes back to the same conversation', async () => {
    useUiStore.setState({ view: 'conversation' })
    useConversationsStore.setState({ activeId: 'c1' })
    rememberLocation('chat', { view: 'conversation', conversationId: 'c1', groupId: null })

    showBots()
    expect(useUiStore.getState().view).toBe('bots')

    getConversation.mockResolvedValue({ ok: true, data: { id: 'c1', agentId: null } })
    showMode('chat')
    await vi.waitFor(() => expect(useConversationsStore.getState().activeId).toBe('c1'))
    expect(useUiStore.getState().view).toBe('conversation')
  })

  it('lands on Home instead of an error when the remembered conversation was deleted', async () => {
    useUiStore.setState({ view: 'bots' })
    rememberLocation('work', { view: 'conversation', conversationId: 'gone', groupId: null })
    getConversation.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x', retryable: false } })
    showMode('work')
    await vi.waitFor(() => expect(useUiStore.getState().view).toBe('home'))
    expect(useConversationsStore.getState().modeFilter).toBe('work')
  })

  it('Bots → Chat → Bots reopens the room; Bots while in Bots goes to the overview', () => {
    useUiStore.setState({ view: 'bots' })
    useBotsStore.setState({ activeGroupId: 'room-a' })
    rememberLocation('bots', { view: 'bots', conversationId: null, groupId: 'room-a' })
    showMode('chat')
    expect(useUiStore.getState().view).toBe('home')

    showBots()
    expect(useUiStore.getState().view).toBe('bots')
    expect(useBotsStore.getState().activeGroupId).toBe('room-a')

    useBotsStore.setState({ panel: { kind: 'new-bot' } })
    showBots()
    expect(useBotsStore.getState().activeGroupId).toBeNull()
    expect(useBotsStore.getState().panel).toEqual({ kind: 'none' })
  })

  it('between Chat and Work only the sidebar list changes, as before', () => {
    useUiStore.setState({ view: 'conversation' })
    useConversationsStore.setState({ activeId: 'c1' })
    showMode('work')
    expect(useConversationsStore.getState().modeFilter).toBe('work')
    expect(useConversationsStore.getState().activeId).toBe('c1')
    expect(useUiStore.getState().view).toBe('conversation')
  })
})
