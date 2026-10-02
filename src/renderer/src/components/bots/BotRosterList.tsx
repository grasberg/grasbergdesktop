/**
 * The bot roster as the sidebar's list while the Bots tab is active (Bots is
 * the third main function beside Chat and Work): bots and group rooms in one
 * activity-ordered list, the active-now strip, attention chips, and the
 * per-row edit / hide / delete menu. Clicking a bot opens its chat in the
 * main area; clicking a room opens it in the Bots surface.
 */

import { useMemo, type ReactElement } from 'react'
import type { BotAttention } from '@shared/types'
import { unwrap } from '@/api/uld'
import { ConfirmButton } from '@/components/common/controls'
import { navigateGuarded } from '@/hooks/useUnsavedChanges'
import { relativeTime } from '@/lib/format'
import { openBotsPanel } from '@/lib/main-sections'
import { useBotsStore } from '@/stores/bots'
import { useConversationsStore } from '@/stores/conversations'
import { toastError, useUiStore } from '@/stores/ui'
import { BotAvatarBadge } from './BotAvatarBadge'
import './bots.css'

function AttentionChip({ attention }: { attention: BotAttention }): ReactElement | null {
  if (attention === 'needs_you') return <span className="bots-needs-you">needs you</span>
  if (attention === 'unread') return <span className="bots-unread-chip">new</span>
  return null
}

export default function BotRosterList(): ReactElement {
  const roster = useBotsStore((s) => s.roster)
  const loaded = useBotsStore((s) => s.loaded)
  const search = useBotsStore((s) => s.search)
  const showHidden = useBotsStore((s) => s.showHidden)
  const activeGroupId = useBotsStore((s) => s.activeGroupId)
  const view = useUiStore((s) => s.view)
  const activeId = useConversationsStore((s) => s.activeId)

  const bots = useMemo(() => roster?.bots ?? [], [roster])
  const groups = useMemo(() => roster?.groups ?? [], [roster])
  const hiddenCount = bots.filter((row) => row.agent.hidden).length
  const activeNow = bots.filter((row) => row.active && !row.agent.hidden)

  const query = search.trim().toLowerCase()
  const rows = useMemo(() => {
    const visibleBots = bots.filter(
      (row) =>
        (showHidden || !row.agent.hidden) &&
        (!query ||
          row.agent.name.toLowerCase().includes(query) ||
          row.agent.title.toLowerCase().includes(query))
    )
    const visibleGroups = groups.filter((row) => !query || row.group.name.toLowerCase().includes(query))
    return [
      ...visibleBots.map((row) => ({ kind: 'bot' as const, at: row.lastMessageAt ?? row.agent.createdAt, row })),
      ...visibleGroups.map((row) => ({ kind: 'group' as const, at: row.lastMessageAt ?? row.group.createdAt, row })),
    ].sort((a, b) => b.at - a.at)
  }, [bots, groups, showHidden, query])

  const openBot = (agentId: string): void =>
    navigateGuarded(() => {
      const store = useBotsStore.getState()
      store.setPanel({ kind: 'none' })
      void store.openBotChat(agentId)
    }, 'page')

  const openRoom = (groupId: string): void =>
    navigateGuarded(() => {
      const store = useBotsStore.getState()
      store.setPanel({ kind: 'none' })
      store.selectGroup(groupId)
      useUiStore.getState().setView('bots')
    }, 'page')

  return (
    <div className="sidebar-bots">
      {activeNow.length > 0 ? (
        <div className="bots-active-strip" aria-label="Active now">
          {activeNow.map((row) => (
            <button
              key={row.agent.id}
              type="button"
              className="bots-active-chip"
              title={`${row.agent.name} is working`}
              onClick={() => openBot(row.agent.id)}
            >
              <BotAvatarBadge agent={row.agent} size={22} />
              <span>{row.agent.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <ul className="tree-list bots-list sidebar-bots-list" aria-label="Bots and group rooms">
        {rows.map((entry) =>
          entry.kind === 'bot' ? (
            <li
              key={`bot-${entry.row.agent.id}`}
              className={`bots-row${entry.row.agent.hidden ? ' hidden-bot' : ''}${entry.row.agent.enabled ? '' : ' disabled-bot'}${entry.row.attention === 'unread' || entry.row.attention === 'needs_you' ? ' has-attention' : ''}${view === 'conversation' && activeId !== null && activeId === entry.row.agent.chatConversationId ? ' selected' : ''}`}
            >
              <button
                type="button"
                className="bots-row-main"
                aria-current={
                  view === 'conversation' && activeId !== null && activeId === entry.row.agent.chatConversationId
                    ? 'page'
                    : undefined
                }
                onClick={() => openBot(entry.row.agent.id)}
              >
                <span className="bots-row-avatar">
                  <BotAvatarBadge agent={entry.row.agent} />
                  {entry.row.attention === 'working' ? <span className="bots-active-dot" title="Working" /> : null}
                </span>
                <span className="bots-row-text">
                  <span className="bots-row-name">
                    {entry.row.agent.name}
                    {entry.row.agent.title ? <span className="bots-row-title">{entry.row.agent.title}</span> : null}
                    <AttentionChip attention={entry.row.attention} />
                    {entry.row.agent.paused ? (
                      <span className="bots-paused-chip" title={entry.row.agent.pausedReason ?? 'Paused'}>
                        paused
                      </span>
                    ) : null}
                    {entry.row.openSuggestions > 0 ? (
                      <span className="bots-suggestion-chip" title="Suggestions and steps waiting for you">
                        💡 {entry.row.openSuggestions}
                      </span>
                    ) : null}
                  </span>
                  <span className="bots-row-snippet">{entry.row.snippet ?? 'No messages yet — say hi.'}</span>
                </span>
                {entry.row.lastMessageAt ? <time>{relativeTime(entry.row.lastMessageAt)}</time> : null}
              </button>
              <span className="bots-row-menu">
                <button
                  type="button"
                  title="Edit bot"
                  aria-label={`Edit ${entry.row.agent.name}`}
                  onClick={() => openBotsPanel({ kind: 'edit-bot', agent: entry.row.agent })}
                >
                  ✎
                </button>
                <button
                  type="button"
                  title={entry.row.agent.hidden ? 'Unhide bot' : 'Hide bot (display only)'}
                  aria-label={entry.row.agent.hidden ? `Unhide ${entry.row.agent.name}` : `Hide ${entry.row.agent.name}`}
                  onClick={() => void useBotsStore.getState().setHidden(entry.row.agent.id, !entry.row.agent.hidden)}
                >
                  {entry.row.agent.hidden ? '🙈' : '—'}
                </button>
                <ConfirmButton
                  label="✕"
                  prompt={`Delete ${entry.row.agent.name}? Its chat and memberships go too.`}
                  onConfirm={async () => {
                    try {
                      const wasOpen = activeId !== null && activeId === entry.row.agent.chatConversationId
                      await unwrap(window.uld.agents.delete(entry.row.agent.id))
                      await useBotsStore.getState().load()
                      if (wasOpen) useUiStore.getState().setView('bots')
                    } catch (e) {
                      toastError('Failed to delete bot', e)
                    }
                  }}
                />
              </span>
            </li>
          ) : (
            <li
              key={`group-${entry.row.group.id}`}
              className={`bots-row group-row${view === 'bots' && entry.row.group.id === activeGroupId ? ' selected' : ''}`}
            >
              <button
                type="button"
                className="bots-row-main"
                aria-current={view === 'bots' && entry.row.group.id === activeGroupId ? 'page' : undefined}
                onClick={() => openRoom(entry.row.group.id)}
              >
                <span className="bots-row-avatar group-avatar">👥</span>
                <span className="bots-row-text">
                  <span className="bots-row-name">
                    {entry.row.group.name}
                    <span className="bots-row-title">
                      {entry.row.group.memberIds.length} bots
                      {entry.row.group.mode === 'ensemble' ? ' · ensemble' : ''}
                    </span>
                    <AttentionChip attention={entry.row.attention} />
                  </span>
                  <span className="bots-row-snippet">
                    {entry.row.active ? 'Deliberating…' : (entry.row.snippet ?? 'A quiet room.')}
                  </span>
                </span>
                {entry.row.lastMessageAt ? <time>{relativeTime(entry.row.lastMessageAt)}</time> : null}
              </button>
            </li>
          )
        )}
        {loaded && rows.length === 0 ? (
          <li className="conv-empty">
            {query ? 'No bots match.' : 'No bots yet. Create one with “New bot” — it keeps its own chat, memory, model and routines.'}
          </li>
        ) : null}
      </ul>
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="sidebar-bots-hidden-toggle"
          aria-pressed={showHidden}
          onClick={() => useBotsStore.getState().setShowHidden(!showHidden)}
        >
          {showHidden ? 'Conceal hidden bots' : `Show hidden bots (${hiddenCount})`}
        </button>
      ) : null}
    </div>
  )
}
