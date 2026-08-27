import { describe, expect, it } from 'vitest'
import {
  STALL_LIMIT_NOTE,
  STALL_NUDGE_ROUNDS,
  STALL_STOP_ROUNDS,
  isUnproductiveToolResult,
  roundWasProductive,
  stallNudge,
} from '../../src/main/services/stall-supervisor'

describe('isUnproductiveToolResult', () => {
  it('flags executor error prefixes and declined approvals', () => {
    expect(isUnproductiveToolResult("Error: unknown tool 'nope'.")).toBe(true)
    expect(isUnproductiveToolResult('Error: arguments must be a JSON object.')).toBe(true)
    expect(isUnproductiveToolResult('The user has denied the tool in settings.')).toBe(true)
    expect(isUnproductiveToolResult('User declined this tool call.')).toBe(true)
  })

  it('counts real output as productive, even when it mentions errors', () => {
    expect(isUnproductiveToolResult('Error count: 0 — build passed')).toBe(false)
    expect(isUnproductiveToolResult('wrote 12 lines to src/x.ts')).toBe(false)
    // The executor's own classification: only the exact sentinel is 'denied'.
    expect(isUnproductiveToolResult('User declined this tool call. Please retry.')).toBe(false)
  })
})

describe('roundWasProductive', () => {
  it('is true when ANY call did real work', () => {
    expect(roundWasProductive(['Error: bad args', 'wrote file'])).toBe(true)
  })

  it('is false when every call failed', () => {
    expect(roundWasProductive(['Error: a', 'Error: b'])).toBe(false)
    expect(roundWasProductive([])).toBe(false)
  })
})

describe('stallNudge', () => {
  it('stays silent before the threshold and between nudges', () => {
    for (let count = 0; count < STALL_NUDGE_ROUNDS; count++) {
      expect(stallNudge(count)).toBeNull()
    }
    expect(stallNudge(STALL_NUDGE_ROUNDS + 1)).toBeNull()
  })

  it('fires on every Nth unproductive round, but never at/after the stop limit', () => {
    expect(stallNudge(STALL_NUDGE_ROUNDS)).not.toBeNull()
    expect(stallNudge(STALL_NUDGE_ROUNDS * 2)).not.toBeNull()
    expect(stallNudge(STALL_STOP_ROUNDS - 1)).toBeNull()
    expect(stallNudge(STALL_STOP_ROUNDS)).toBeNull()
  })

  it('documents the note used when the loop stops', () => {
    expect(STALL_LIMIT_NOTE).toContain('Supervisor')
  })
})
