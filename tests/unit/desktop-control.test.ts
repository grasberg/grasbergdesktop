/**
 * Desktop control (v53): key mapping, SendKeys escaping, coordinate scaling,
 * and the DesktopControl engine against a fake input host — opt-in gating,
 * the kill switch, the one-time announcement and screenshot hand-off.
 */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { comboToVirtualKeys, toScreenPoint, toSendKeysText } from '../../src/main/desktop/input'
import { DesktopControl, type DesktopDeps } from '../../src/main/desktop/desktop-control'

describe('desktop input helpers', () => {
  it('maps key combos to virtual keys', () => {
    expect(comboToVirtualKeys('ctrl+s')).toEqual([0x11, 0x53])
    expect(comboToVirtualKeys('win+r')).toEqual([0x5b, 0x52])
    expect(comboToVirtualKeys('alt+F4')).toEqual([0x12, 0x73])
    expect(comboToVirtualKeys('Enter')).toEqual([0x0d])
    expect(comboToVirtualKeys('ctrl+banana')).toBeNull()
  })

  it('escapes SendKeys metacharacters and newlines', () => {
    expect(toSendKeysText('1+1=(2) {ok} 100%~\nnext\tcol')).toBe(
      '1{+}1={(}2{)} {{}ok{}} 100{%}{~}{ENTER}next{TAB}col'
    )
  })

  it('scales screenshot points to physical pixels and clamps', () => {
    const shot = { width: 1280, height: 720 }
    const screen = { x: 0, y: 0, width: 3840, height: 2160 }
    expect(toScreenPoint([640, 360], shot, screen)).toEqual([1920, 1080])
    expect(toScreenPoint([-5, 9999], shot, screen)).toEqual([0, 2157])
    expect(toScreenPoint([0, 0], shot, { ...screen, x: -1920 })).toEqual([-1920, 0])
  })
})

/** A fake PowerShell host speaking the READY / OK protocol. */
function fakeHost(log: string[]): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & EventEmitter
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  Object.assign(child, { stdout, stdin, stderr: new PassThrough(), exitCode: null, kill: () => true })
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      log.push(line)
      stdout.write('OK\n')
    }
  })
  setTimeout(() => stdout.write('READY\n'), 1)
  return child
}

function makeControl(overrides: Partial<DesktopDeps> = {}) {
  const log: string[] = []
  const notes: string[] = []
  let enabled = true
  let killer: (() => void) | null = null
  const control = new DesktopControl({
    platform: 'win32',
    primaryDisplay: () => ({ x: 0, y: 0, width: 2560, height: 1440 }),
    capture: async (size) => `data:image/png;base64,${size.width}x${size.height}`,
    isEnabled: () => enabled,
    disable: () => {
      enabled = false
    },
    notify: (title) => notes.push(title),
    registerKillShortcut: (onKill) => {
      killer = onKill
    },
    spawnHost: () => fakeHost(log),
    ...overrides,
  })
  return { control, log, notes, kill: () => killer?.(), isEnabled: () => enabled }
}

describe('DesktopControl', () => {
  it('screenshots, scales clicks to the screen and hands the screenshot to the model', async () => {
    const { control, log, notes } = makeControl()
    expect(await control.run('screenshot')).toMatch(/1280x720/)
    expect(control.consumePendingScreenshot()).toBe('data:image/png;base64,1280x720')
    expect(control.consumePendingScreenshot()).toBeNull()
    expect(notes).toEqual(['Grasberg is controlling your desktop'])

    expect(await control.run('double_click', [640, 360])).toMatch(/done/)
    expect(JSON.parse(log[0])).toEqual({ op: 'click', x: 1280, y: 720, button: 'left', count: 2 })
    await control.run('type', undefined, 'hej (1)')
    expect(JSON.parse(log[1])).toEqual({ op: 'keys', keys: 'hej {(}1{)}' })
    await control.run('key', undefined, 'ctrl+shift+esc')
    expect(JSON.parse(log[2])).toEqual({ op: 'vk', codes: [0x11, 0x10, 0x1b] })
    expect(await control.run('left_click')).toMatch(/needs a "coordinate"/)
    expect(await control.run('key', undefined, 'hyper+q')).toMatch(/unknown key/)
    expect(notes).toHaveLength(1) // announced once
  })

  it('a command queued before the kill switch never runs after it', async () => {
    const own: string[] = []
    let spawned = 0
    const { control, kill } = makeControl({
      spawnHost: () => {
        spawned++
        return fakeHost(own)
      },
    })
    const first = control.run('left_click', [10, 10])
    const second = control.run('left_click', [20, 20])
    kill() // Ctrl+Alt+Esc before the queued commands reach the host
    expect(await first).toMatch(/turned off/)
    expect(await second).toMatch(/turned off/)
    expect(own).toEqual([])
    expect(spawned).toBe(0)
  })

  it('refuses when off, on other platforms, and after the kill switch', async () => {
    const off = makeControl({ isEnabled: () => false })
    expect(await off.control.run('screenshot')).toMatch(/turned off/)
    const mac = makeControl({ platform: 'darwin' })
    expect(await mac.control.run('screenshot')).toMatch(/only available on Windows/)

    const live = makeControl()
    await live.control.run('screenshot')
    live.kill()
    expect(live.isEnabled()).toBe(false)
    expect(live.notes).toContain('Desktop control stopped')
    expect(await live.control.run('left_click', [1, 1])).toMatch(/turned off/)
    expect(live.log).toEqual([])
  })
})
