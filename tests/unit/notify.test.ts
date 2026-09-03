/**
 * Desktop notifications: the routing rules, with every OS touchpoint injected.
 * What is worth pinning down is when the app stays QUIET (the user is already
 * looking at it, or switched notifications off) and that nothing secret-looking
 * reaches a notification body — the shell's notification centre keeps those
 * long after the app forgets the call.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  DesktopNotifier,
  approvalNotification,
  resultNotification,
  routineNotification,
  type DesktopNotifierDeps,
} from '../../src/main/services/notify'

function setup(overrides: Partial<DesktopNotifierDeps> = {}): {
  notifier: DesktopNotifier
  show: ReturnType<typeof vi.fn>
  setBadge: ReturnType<typeof vi.fn>
  flash: ReturnType<typeof vi.fn>
} {
  const show = vi.fn()
  const setBadge = vi.fn()
  const flash = vi.fn()
  const notifier = new DesktopNotifier({
    enabled: () => true,
    windowFocused: () => false,
    show,
    setBadge,
    flash,
    unreadCount: () => 3,
    ...overrides,
  })
  return { notifier, show, setBadge, flash }
}

describe('DesktopNotifier', () => {
  it('shows a notification and refreshes the badge when the window is in the background', () => {
    const { notifier, show, setBadge } = setup()
    notifier.notify(resultNotification('Morning digest', 'ok', 'Sent to 3 people.'))
    expect(show).toHaveBeenCalledTimes(1)
    expect(show.mock.calls[0][0]).toMatchObject({
      title: 'Morning digest finished',
      body: 'Sent to 3 people.',
    })
    expect(setBadge).toHaveBeenCalledWith(3)
  })

  it('stays quiet while the window is focused — but still refreshes the badge', () => {
    const { notifier, show, setBadge } = setup({ windowFocused: () => true })
    notifier.notify(approvalNotification('run_shell_command', undefined))
    expect(show).not.toHaveBeenCalled()
    // The badge is a passive count, not an interruption: letting it drift
    // behind would make the number a lie.
    expect(setBadge).toHaveBeenCalledWith(3)
  })

  it('respects the setting, and still keeps the badge honest', () => {
    const { notifier, show, setBadge } = setup({ enabled: () => false })
    notifier.notify(resultNotification('Nightly summary', 'error', 'Provider timed out.'))
    expect(show).not.toHaveBeenCalled()
    expect(setBadge).toHaveBeenCalledWith(3)
  })

  it('flashes the taskbar for an approval but not for a finished result', () => {
    const { notifier, flash } = setup()
    notifier.notify(resultNotification('Morning digest', 'ok', 'Done.'))
    expect(flash).not.toHaveBeenCalled()
    notifier.notify(approvalNotification('git_write', 'Commits 3 files on main'))
    expect(flash).toHaveBeenCalledWith(true)
  })

  it('redacts secret-looking text out of the body', () => {
    const { notifier, show } = setup()
    notifier.notify(
      resultNotification('Deploy', 'error', 'Auth failed for sk-abcdefghijklmnopqrstuvwxyz012345')
    )
    const body = show.mock.calls[0][0].body as string
    expect(body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })

  it('collapses whitespace and truncates a long body', () => {
    const { notifier, show } = setup()
    notifier.notify(resultNotification('Job', 'ok', `line one\n\n   line two\n${'x'.repeat(500)}`))
    const body = show.mock.calls[0][0].body as string
    expect(body).toContain('line one line two')
    expect(body.length).toBeLessThanOrEqual(220)
    expect(body.endsWith('…')).toBe(true)
  })

  it('never lets a failing OS notification escape to the caller', () => {
    const { notifier } = setup({
      show: () => {
        throw new Error('no notification service')
      },
    })
    expect(() => notifier.notify(resultNotification('Job', 'ok', 'Done.'))).not.toThrow()
  })

  it('never lets a failing badge API escape either', () => {
    const { notifier } = setup({
      setBadge: () => {
        throw new Error('unsupported platform')
      },
    })
    expect(() => notifier.refreshBadge()).not.toThrow()
  })

  it('clamps a negative unread count to zero', () => {
    const { notifier, setBadge } = setup({ unreadCount: () => -1 })
    notifier.refreshBadge()
    expect(setBadge).toHaveBeenCalledWith(0)
  })

  it('names the outcome in the title', () => {
    expect(resultNotification('Job', 'ok', '').title).toBe('Job finished')
    expect(resultNotification('Job', 'error', '').title).toBe('Job failed')
    expect(resultNotification('Job', 'stopped', '').title).toBe('Job was stopped')
  })

  it('clears the taskbar attention when the user comes back', () => {
    const { notifier, flash } = setup()
    notifier.clearAttention()
    expect(flash).toHaveBeenCalledWith(false)
  })
})

describe('routineNotification', () => {
  it('names the owning bot in the title and carries the click through', () => {
    const onClick = vi.fn()
    const notification = routineNotification(
      { title: 'Nightly digest', lastStatus: 'ok', lastError: null, lastOutput: 'All quiet.' },
      'Editor',
      onClick
    )
    expect(notification.title).toBe('🤖 Editor · Nightly digest finished')
    expect(notification.body).toBe('All quiet.')
    notification.onClick?.()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('reads plainly for an ownerless task and prefers the error text', () => {
    const notification = routineNotification(
      { title: 'Backup', lastStatus: 'error', lastError: 'disk full', lastOutput: '' },
      null
    )
    expect(notification.title).toBe('Backup failed')
    expect(notification.body).toBe('disk full')
    expect(notification.onClick).toBeUndefined()
  })
})
