/**
 * Tests for the shared update_task_list wire format (src/shared/tasklist.ts).
 * The encoded shape is persisted by the executor and parsed by the renderer's
 * TaskListStrip, so these strings are asserted byte-exactly.
 */

import { describe, expect, it } from 'vitest'
import { encodeTaskList, parseTaskList, TASK_IN_PROGRESS_MARKER } from '@shared/tasklist'

describe('encodeTaskList', () => {
  it('encodes each status byte-exactly, including the ⟵ in progress marker', () => {
    const encoded = encodeTaskList([
      { content: 'Read the code', status: 'completed' },
      { content: 'Write the fix', status: 'in_progress' },
      { content: 'Verify', status: 'pending' },
    ])
    expect(encoded).toBe('- [x] Read the code\n- [ ] Write the fix ⟵ in progress\n- [ ] Verify')
  })

  it('encodes a single task without a trailing newline', () => {
    expect(encodeTaskList([{ content: 'Verify', status: 'completed' }])).toBe('- [x] Verify')
    expect(encodeTaskList([{ content: 'Verify', status: 'pending' }])).toBe('- [ ] Verify')
    expect(encodeTaskList([{ content: 'Verify', status: 'in_progress' }])).toBe(
      `- [ ] Verify ${TASK_IN_PROGRESS_MARKER}`
    )
  })

  it('encodes an empty list as an empty string', () => {
    expect(encodeTaskList([])).toBe('')
  })
})

describe('parseTaskList', () => {
  it('round-trips every status through encode -> parse', () => {
    const encoded = encodeTaskList([
      { content: 'Read the code', status: 'completed' },
      { content: 'Write the fix', status: 'in_progress' },
      { content: 'Verify', status: 'pending' },
    ])
    expect(parseTaskList(encoded)).toEqual([
      { text: 'Read the code', done: true, inProgress: false },
      { text: 'Write the fix', done: false, inProgress: true },
      { text: 'Verify', done: false, inProgress: false },
    ])
  })

  it('trims surrounding whitespace and skips non-checklist lines', () => {
    const parsed = parseTaskList(
      '  - [x] Done thing  \nSome prose line\n- not a checkbox\n\n- [ ] Pending thing'
    )
    expect(parsed).toEqual([
      { text: 'Done thing', done: true, inProgress: false },
      { text: 'Pending thing', done: false, inProgress: false },
    ])
  })

  it('strips the in-progress marker (and its separating space) from the text', () => {
    const parsed = parseTaskList(`- [ ] Write the fix ${TASK_IN_PROGRESS_MARKER}`)
    expect(parsed).toEqual([{ text: 'Write the fix', done: false, inProgress: true }])
  })

  it('returns an empty array for empty or marker-free prose input', () => {
    expect(parseTaskList('')).toEqual([])
    expect(parseTaskList('nothing here')).toEqual([])
  })
})
