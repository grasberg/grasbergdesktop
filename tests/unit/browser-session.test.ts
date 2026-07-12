/**
 * The computer tool's key handling. Electron is faked (the module is imported
 * for BrowserWindow/session only) so the combo parsing can be tested in Node.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
}))

const { parseKeyCombo } = await import('../../src/main/browser/session')

describe('parseKeyCombo', () => {
  it('carries modifiers on the final key instead of pressing them separately', () => {
    // Chromium tracks no modifier state across synthetic events, so 'ctrl' as
    // its own key event would make the combo a no-op.
    expect(parseKeyCombo('ctrl+a')).toEqual({ keyCode: 'a', modifiers: ['control'] })
    expect(parseKeyCombo('Ctrl+Shift+Tab')).toEqual({
      keyCode: 'Tab',
      modifiers: ['control', 'shift'],
    })
    expect(parseKeyCombo(' cmd + c ')).toEqual({ keyCode: 'c', modifiers: ['meta'] })
    expect(parseKeyCombo('alt+Left')).toEqual({ keyCode: 'Left', modifiers: ['alt'] })
  })

  it('handles plain keys and an empty combo', () => {
    expect(parseKeyCombo('Return')).toEqual({ keyCode: 'Return', modifiers: [] })
    expect(parseKeyCombo('')).toEqual({ keyCode: '', modifiers: [] })
  })
})
