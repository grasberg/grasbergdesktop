/**
 * The three main functions — Chat, Work and Bots — as ONE tab row at the top
 * of the sidebar. Chat and Work are conversation modes (the sidebar lists
 * that mode's conversations); Bots is the bot roster, with a bot's chat, a
 * group room or a bot form in the main area.
 *
 * Which tab is lit is DERIVED from what the main area shows, so every way
 * into a bot chat (a notification, Settings → Agents, the palette) lights
 * the Bots tab without bookkeeping. Each tab remembers where it was, so
 * switching away and back returns to the same chat or room.
 */

import type { BotRoster, ConversationMode } from '@shared/types'
import type { AppView, BotsPanel } from '@/stores/contracts'
import { navigateGuarded } from '@/hooks/useUnsavedChanges'
import { useBotsStore } from '@/stores/bots'
import { useConversationsStore } from '@/stores/conversations'
import { useUiStore } from '@/stores/ui'

export type MainSection = ConversationMode | 'bots'

export interface SectionState {
  view: AppView
  activeId: string | null
  modeFilter: ConversationMode
  roster: BotRoster | null
}

/** True when the conversation is a bot's canonical chat. */
export function isBotChat(conversationId: string | null, roster: BotRoster | null): boolean {
  return (
    conversationId !== null &&
    (roster?.bots.some((row) => row.agent.chatConversationId === conversationId) ?? false)
  )
}

/** The lit tab: Bots while the Bots surface or a bot's chat fills the main area. */
export function mainSectionFor(state: SectionState): MainSection {
  if (state.view === 'bots') return 'bots'
  if (state.view === 'conversation' && isBotChat(state.activeId, state.roster)) return 'bots'
  return state.modeFilter
}

export function useMainSection(): MainSection {
  const view = useUiStore((s) => s.view)
  const activeId = useConversationsStore((s) => s.activeId)
  const modeFilter = useConversationsStore((s) => s.modeFilter)
  const roster = useBotsStore((s) => s.roster)
  return mainSectionFor({ view, activeId, modeFilter, roster })
}

/** What a tab was showing when the user left it. */
export interface SectionLocation {
  view: AppView
  conversationId: string | null
  groupId: string | null
}

const lastLocation: Partial<Record<MainSection, SectionLocation>> = {}

/** Called by the sidebar whenever the main area changes (tracks every route in). */
export function rememberLocation(section: MainSection, location: SectionLocation): void {
  lastLocation[section] = location
}

/** Test seam. */
export function forgetLocations(): void {
  for (const key of Object.keys(lastLocation) as MainSection[]) delete lastLocation[key]
}

/**
 * Where a return to `section` should land, given what is still there: the
 * same bot chat / room / conversation, the surface it was on, or the tab's
 * start page (the Bots overview, or Home for Chat and Work).
 */
export function restoreTargetFor(
  section: MainSection,
  location: SectionLocation | undefined,
  roster: BotRoster | null
): SectionLocation {
  if (section === 'bots') {
    if (location?.view === 'conversation' && isBotChat(location.conversationId, roster)) {
      return { view: 'conversation', conversationId: location.conversationId, groupId: null }
    }
    const groupId =
      location?.view === 'bots' && location.groupId && roster?.groups.some((row) => row.group.id === location.groupId)
        ? location.groupId
        : null
    return { view: 'bots', conversationId: null, groupId }
  }
  if (location?.view === 'conversation' && location.conversationId && !isBotChat(location.conversationId, roster)) {
    return { view: 'conversation', conversationId: location.conversationId, groupId: null }
  }
  if (location && location.view !== 'conversation' && location.view !== 'bots') {
    return { view: location.view, conversationId: null, groupId: null }
  }
  return { view: 'home', conversationId: null, groupId: null }
}

function currentSection(): MainSection {
  return mainSectionFor({
    view: useUiStore.getState().view,
    activeId: useConversationsStore.getState().activeId,
    modeFilter: useConversationsStore.getState().modeFilter,
    roster: useBotsStore.getState().roster,
  })
}

/** Opens the Bots overview (or a bot form) in the main area. */
function showBotsSurface(groupId: string | null): void {
  const bots = useBotsStore.getState()
  bots.selectGroup(groupId)
  useUiStore.getState().setView('bots')
}

/**
 * The Bots tab. From another tab it returns to the bot chat or room you left;
 * clicking it while already in Bots goes back to the overview.
 */
export function showBots(): void {
  const already = currentSection() === 'bots'
  navigateGuarded(() => {
    const bots = useBotsStore.getState()
    if (already) {
      bots.setPanel({ kind: 'none' })
      showBotsSurface(null)
      return
    }
    const target = restoreTargetFor('bots', lastLocation.bots, bots.roster)
    if (target.view === 'conversation' && target.conversationId) {
      useConversationsStore.getState().select(target.conversationId)
      return
    }
    showBotsSurface(target.groupId)
  }, 'page')
}

/**
 * The Chat / Work tabs. Between Chat and Work this only switches the sidebar
 * list, exactly as before; coming from Bots it also returns the main area to
 * where that tab was left.
 */
export function showMode(mode: ConversationMode): void {
  const conversations = useConversationsStore.getState()
  if (currentSection() !== 'bots') {
    conversations.setModeFilter(mode)
    return
  }
  navigateGuarded(() => {
    const target = restoreTargetFor(mode, lastLocation[mode], useBotsStore.getState().roster)
    useConversationsStore.getState().setModeFilter(mode)
    const conversationId = target.conversationId
    if (target.view === 'conversation' && conversationId) {
      // The conversation may have been deleted meanwhile: check first, so a
      // tab switch never lands on an error page.
      void window.uld.conversations.get(conversationId).then(
        (res) => {
          if (res.ok && !res.data.agentId) useConversationsStore.getState().select(conversationId)
          else useUiStore.getState().setView('home')
        },
        () => useUiStore.getState().setView('home')
      )
      return
    }
    useUiStore.getState().setView(target.view)
  }, 'page')
}

/** Opens a bot form (or the personal-agent setup) in the Bots main area. */
export function openBotsPanel(panel: Exclude<BotsPanel, { kind: 'none' }>): void {
  navigateGuarded(() => {
    useBotsStore.getState().setPanel(panel)
    showBotsSurface(null)
  }, 'page')
}
