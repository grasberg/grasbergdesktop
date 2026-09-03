/**
 * Always-on lifecycle rules (v50): hide-to-tray, hidden start, login item,
 * process keep-alive — pure functions, so the honesty rule ("only claim to
 * keep running when a tray exists") is pinned down without Electron.
 */

import { describe, expect, it } from 'vitest'
import {
  keepAliveWithoutWindows,
  loginItemSettings,
  shouldHideOnClose,
  shouldStartHidden,
} from '../../src/main/services/lifecycle'

describe('lifecycle rules', () => {
  it('hides on close only on Windows/Linux, in background mode, with a tray, and not while quitting', () => {
    const base = { runInBackground: true, hasTray: true, quitting: false, platform: 'win32' as const }
    expect(shouldHideOnClose(base)).toBe(true)
    expect(shouldHideOnClose({ ...base, platform: 'linux' })).toBe(true)
    expect(shouldHideOnClose({ ...base, platform: 'darwin' })).toBe(false)
    expect(shouldHideOnClose({ ...base, runInBackground: false })).toBe(false)
    expect(shouldHideOnClose({ ...base, hasTray: false })).toBe(false)
    expect(shouldHideOnClose({ ...base, quitting: true })).toBe(false)
  })

  it('starts hidden for a login-item launch or --hidden, and only in background mode', () => {
    expect(shouldStartHidden({ argv: ['app', '--hidden'], wasOpenedAsHidden: false, runInBackground: true })).toBe(true)
    expect(shouldStartHidden({ argv: ['app'], wasOpenedAsHidden: true, runInBackground: true })).toBe(true)
    expect(shouldStartHidden({ argv: ['app'], wasOpenedAsHidden: false, runInBackground: true })).toBe(false)
    expect(shouldStartHidden({ argv: ['app', '--hidden'], wasOpenedAsHidden: true, runInBackground: false })).toBe(false)
  })

  it('describes the login item: hidden start only with background mode', () => {
    expect(loginItemSettings({ launchAtLogin: false, runInBackground: true })).toEqual({
      openAtLogin: false,
      openAsHidden: false,
      args: [],
    })
    expect(loginItemSettings({ launchAtLogin: true, runInBackground: false })).toEqual({
      openAtLogin: true,
      openAsHidden: false,
      args: [],
    })
    expect(loginItemSettings({ launchAtLogin: true, runInBackground: true })).toEqual({
      openAtLogin: true,
      openAsHidden: true,
      args: ['--hidden'],
    })
  })

  it('keeps the process alive without windows on macOS, else only with background mode and a tray', () => {
    expect(keepAliveWithoutWindows({ runInBackground: false, hasTray: false, platform: 'darwin' })).toBe(true)
    expect(keepAliveWithoutWindows({ runInBackground: true, hasTray: true, platform: 'win32' })).toBe(true)
    expect(keepAliveWithoutWindows({ runInBackground: true, hasTray: false, platform: 'win32' })).toBe(false)
    expect(keepAliveWithoutWindows({ runInBackground: false, hasTray: true, platform: 'linux' })).toBe(false)
  })
})
