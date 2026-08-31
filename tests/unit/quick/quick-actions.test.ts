/**
 * Quick assistant — pure shared logic: prompt substitution, clipboard capture
 * truncation, the default action set, and the settings patch surface.
 */

import { describe, expect, it } from 'vitest'
import {
  QUICK_SELECTION_MAX_CHARS,
  buildQuickPrompt,
  captureSelection,
} from '@shared/quick-actions'
import { DEFAULT_QUICK_ACTIONS } from '@shared/types'
import { settingsPatchSchema } from '@shared/schemas'

describe('buildQuickPrompt', () => {
  it('replaces a single {selection} occurrence', () => {
    expect(buildQuickPrompt('Explain this:\n\n{selection}', 'some text')).toBe(
      'Explain this:\n\nsome text'
    )
  })

  it('replaces every {selection} occurrence', () => {
    expect(buildQuickPrompt('A {selection} B {selection}', 'x')).toBe('A x B x')
  })

  it('appends the selection after a blank line when the placeholder is missing', () => {
    expect(buildQuickPrompt('Summarize the following.', 'the text')).toBe(
      'Summarize the following.\n\nthe text'
    )
  })

  it('does not treat the template as a regex', () => {
    // A selection with $& or $1 must be inserted verbatim (split/join, not replace).
    expect(buildQuickPrompt('Say: {selection}', 'price is $100 & $&')).toBe(
      'Say: price is $100 & $&'
    )
  })
})

describe('captureSelection', () => {
  it('passes short text through untruncated', () => {
    expect(captureSelection('hello')).toEqual({ selectionText: 'hello', truncated: false })
  })

  it('is not truncated at exactly the cap', () => {
    const raw = 'a'.repeat(QUICK_SELECTION_MAX_CHARS)
    const ctx = captureSelection(raw)
    expect(ctx.selectionText).toHaveLength(QUICK_SELECTION_MAX_CHARS)
    expect(ctx.truncated).toBe(false)
  })

  it('truncates past the cap and flags it', () => {
    const raw = 'a'.repeat(QUICK_SELECTION_MAX_CHARS + 1)
    const ctx = captureSelection(raw)
    expect(ctx.selectionText).toHaveLength(QUICK_SELECTION_MAX_CHARS)
    expect(ctx.truncated).toBe(true)
  })
})

describe('DEFAULT_QUICK_ACTIONS', () => {
  it('has four actions with unique ids, labels and the placeholder', () => {
    expect(DEFAULT_QUICK_ACTIONS).toHaveLength(4)
    expect(new Set(DEFAULT_QUICK_ACTIONS.map((a) => a.id)).size).toBe(4)
    for (const action of DEFAULT_QUICK_ACTIONS) {
      expect(action.label.trim().length).toBeGreaterThan(0)
      expect(action.prompt).toContain('{selection}')
    }
  })
})

describe('settingsPatchSchema quick keys', () => {
  it('accepts the defaults and an empty (disabled) shortcut', () => {
    const parsed = settingsPatchSchema.safeParse({
      quickActions: DEFAULT_QUICK_ACTIONS,
      quickAssistantShortcut: '',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an action with an unknown key (strict)', () => {
    const parsed = settingsPatchSchema.safeParse({
      quickActions: [{ id: 'x', label: 'X', prompt: '{selection}', extra: true }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a label longer than 60 characters', () => {
    const parsed = settingsPatchSchema.safeParse({
      quickActions: [{ id: 'x', label: 'y'.repeat(70), prompt: '{selection}' }],
    })
    expect(parsed.success).toBe(false)
  })
})
