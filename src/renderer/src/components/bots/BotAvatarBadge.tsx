/**
 * A bot's avatar: its emoji on its accent color, or initials on a color hashed
 * from the name. Standalone (own stylesheet) so chat surfaces can render bot
 * identity without pulling in the lazy Bots view chunk.
 */

import type { ReactElement } from 'react'
import type { AgentProfile } from '@shared/types'
import './bot-avatar.css'

// A small stable palette — the default avatar color is hashed from the name.
export const AVATAR_COLORS = [
  '#4169d8',
  '#b85c18',
  '#2e8b57',
  '#8b3a9e',
  '#c0392b',
  '#0e7490',
  '#a16207',
  '#5b21b6',
  '#be185d',
  '#166534',
]

export function colorForName(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?'
}

export function BotAvatarBadge({
  agent,
  size = 36,
}: {
  agent: Pick<AgentProfile, 'name' | 'avatar'>
  size?: number
}): ReactElement {
  const color = agent.avatar?.color || colorForName(agent.name)
  return (
    <span
      className="bot-avatar"
      style={{ width: size, height: size, fontSize: size * 0.44, background: color }}
      aria-hidden="true"
    >
      {agent.avatar?.emoji || initials(agent.name)}
    </span>
  )
}
