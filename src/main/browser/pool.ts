/**
 * One embedded browser per active bot (v50). The user's own conversations
 * share the default session; a bot chat gets its own partition
 * ("grasberg-browser-bot-<id>"), so two bots browsing in parallel never fight
 * over one page or one cookie jar. Bounded: the least-recently-used bot
 * session is closed once more than MAX_BOT_SESSIONS are alive. Separate
 * screens, not a security boundary — same sandboxed Chromium, same posture.
 */

import { BrowserSession } from './session'

const MAX_BOT_SESSIONS = 4

export class BrowserSessionPool {
  private readonly shared = new BrowserSession()
  private readonly bots = new Map<string, { session: BrowserSession; lastUsed: number }>()
  /** Monotonic use counter — wall-clock ticks collide within a millisecond. */
  private tick = 0

  /** The approval/browser scope of a conversation: its bot, else the shared default. */
  scopeFor(agentId: string | null | undefined): string {
    return agentId ? `bot:${agentId}` : 'default'
  }

  forScope(scope: string): BrowserSession {
    if (scope === 'default') return this.shared
    const existing = this.bots.get(scope)
    if (existing) {
      existing.lastUsed = ++this.tick
      return existing.session
    }
    if (this.bots.size >= MAX_BOT_SESSIONS) {
      let oldest: [string, { session: BrowserSession; lastUsed: number }] | null = null
      for (const entry of this.bots) {
        if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry
      }
      if (oldest) {
        oldest[1].session.close()
        this.bots.delete(oldest[0])
      }
    }
    const partition = `grasberg-browser-${scope.replace(/[^A-Za-z0-9-]/g, '-')}`
    const session = new BrowserSession(partition)
    this.bots.set(scope, { session, lastUsed: ++this.tick })
    return session
  }

  /** Live bot scopes, most recently used last (tests + diagnostics). */
  scopes(): string[] {
    return [...this.bots.entries()]
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .map(([scope]) => scope)
  }

  /**
   * The pending computer-use screenshot of one scope. The chat loop drains it
   * right after the tool round, for the conversation that took it.
   */
  consumePendingScreenshot(agentId?: string | null): string | null {
    const scope = this.scopeFor(agentId)
    if (scope === 'default') return this.shared.consumePendingScreenshot()
    return this.bots.get(scope)?.session.consumePendingScreenshot() ?? null
  }

  /** Closes every hidden browser window (main window closed, app quit). */
  closeAll(): void {
    this.shared.close()
    for (const { session } of this.bots.values()) session.close()
    this.bots.clear()
  }
}
