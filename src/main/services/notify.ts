/**
 * Desktop notifications + the unread badge — how a background result or a
 * pending approval reaches the user when they are not looking at the app.
 *
 * Deliberately Electron-free: every OS touchpoint arrives as a dependency, so
 * the routing rules below are unit-testable in plain Node (index.ts supplies
 * the real Notification / setBadgeCount / flashFrame implementations).
 *
 * Two rules govern everything:
 * - Never notify about something the user is already looking at. A focused
 *   main window suppresses the toast entirely; the approval dialog and the
 *   inbox are right there.
 * - Never put untrusted text in a notification body unredacted. Tool
 *   arguments and run output can carry an API key, and an OS notification is
 *   persisted by the shell's notification centre well after the app forgets it.
 */

import { redactSecrets } from '../providers/redact'

export type NotificationKind = 'result' | 'approval' | 'question'

export interface DesktopNotification {
  kind: NotificationKind
  title: string
  body: string
  /** Opening the app is the only action a notification click can take. */
  onClick?: () => void
}

/** OS body length before it is truncated by the shell anyway. */
const BODY_MAX_CHARS = 220

export interface DesktopNotifierDeps {
  /** settings.desktopNotificationsEnabled, read per call so the toggle is live. */
  enabled: () => boolean
  /** True while the main window has focus — suppresses the toast. */
  windowFocused: () => boolean
  /** Shows one OS notification. Must never throw. */
  show: (notification: { title: string; body: string; onClick: () => void }) => void
  /** Dock/taskbar unread count; a no-op where the platform has none. */
  setBadge: (count: number) => void
  /** Draws attention to the taskbar button (Windows has no dock badge). */
  flash?: (on: boolean) => void
  /** Unreviewed inbox items right now. */
  unreadCount: () => number
}

function trimBody(text: string): string {
  const clean = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return clean.length > BODY_MAX_CHARS ? `${clean.slice(0, BODY_MAX_CHARS - 1)}…` : clean
}

export class DesktopNotifier {
  constructor(private readonly deps: DesktopNotifierDeps) {}

  /**
   * Notifies and refreshes the badge. The badge is refreshed even when
   * notifications are switched off or suppressed — it is a passive count, not
   * an interruption, and letting it drift would make the number a lie.
   */
  notify(notification: DesktopNotification): void {
    this.refreshBadge()
    if (!this.deps.enabled()) return
    // The user is in the app: the dialog/inbox already says this.
    if (this.deps.windowFocused()) return
    const body = trimBody(notification.body)
    try {
      this.deps.show({
        title: notification.title.slice(0, 120),
        body,
        onClick: () => notification.onClick?.(),
      })
    } catch {
      // A notification is a courtesy — never let it break the caller's flow.
    }
    // An approval blocks a running tool call, so it also earns a taskbar flash.
    if (notification.kind !== 'result') {
      try {
        this.deps.flash?.(true)
      } catch {
        // Same: best-effort.
      }
    }
  }

  /** Recomputes the unread badge (called after every inbox-visible change). */
  refreshBadge(): void {
    try {
      this.deps.setBadge(Math.max(0, this.deps.unreadCount()))
    } catch {
      // Badge APIs are platform-dependent; absence is not an error.
    }
  }

  /** The user is back in the app: stop flashing. */
  clearAttention(): void {
    try {
      this.deps.flash?.(false)
    } catch {
      // Best-effort.
    }
  }
}

/** Notification copy for a finished background result. */
export function resultNotification(
  sourceLabel: string,
  status: 'ok' | 'error' | 'stopped',
  detail: string,
  onClick?: () => void
): DesktopNotification {
  const verb = status === 'ok' ? 'finished' : status === 'stopped' ? 'was stopped' : 'failed'
  return {
    kind: 'result',
    title: `${sourceLabel} ${verb}`,
    body: detail,
    ...(onClick ? { onClick } : {}),
  }
}

/**
 * Notification copy for a finished routine (scheduled task). A routine owned
 * by a bot carries the bot's name so the toast reads like the bot spoke.
 */
export function routineNotification(
  task: { title: string; lastStatus: string; lastError: string | null; lastOutput: string },
  botName: string | null,
  onClick?: () => void
): DesktopNotification {
  const verb = task.lastStatus === 'error' ? 'failed' : 'finished'
  return {
    kind: 'result',
    title: botName ? `🤖 ${botName} · ${task.title} ${verb}` : `${task.title} ${verb}`,
    body: task.lastError ?? task.lastOutput,
    ...(onClick ? { onClick } : {}),
  }
}

/**
 * Title-only variant for private-space conversations: the shell's notification
 * centre persists bodies long after the app forgets them, so a private
 * conversation's content never becomes one.
 */
export function titleOnlyForPrivateSpace(
  notification: DesktopNotification,
  isPrivate: boolean
): DesktopNotification {
  return isPrivate ? { ...notification, body: '' } : notification
}

/** Notification copy for a tool call waiting on the user. */
export function approvalNotification(
  toolName: string,
  note: string | undefined,
  onClick?: () => void
): DesktopNotification {
  return {
    kind: 'approval',
    title: 'Approval needed',
    body: note?.trim() ? `${toolName} — ${note}` : `${toolName} is waiting for your approval.`,
    ...(onClick ? { onClick } : {}),
  }
}
