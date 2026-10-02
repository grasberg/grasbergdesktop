/** Voice-call VAD (v53): adaptive floor, start/end hysteresis, max length. */

import { describe, expect, it } from 'vitest'
import { DEFAULT_VAD, rmsLevel, SpeechDetector } from '../../src/shared/vad'

/** Feeds `ms` of a constant level in 20 ms frames; returns the events seen. */
function feed(detector: SpeechDetector, level: number, ms: number, start: number): { events: string[]; end: number } {
  const events: string[] = []
  let t = start
  for (; t < start + ms; t += 20) {
    const event = detector.push(level, t)
    if (event) events.push(event)
  }
  return { events, end: t }
}

describe('SpeechDetector', () => {
  it('starts after sustained speech and ends after a pause', () => {
    const detector = new SpeechDetector()
    let t = feed(detector, 0.003, 1000, 0).end // quiet room
    const blip = feed(detector, 0.2, 100, t) // a click, too short
    expect(blip.events).toEqual([])
    t = feed(detector, 0.003, 200, blip.end).end
    const speech = feed(detector, 0.2, 1500, t)
    expect(speech.events).toEqual(['speech-start'])
    expect(detector.isSpeaking).toBe(true)
    const shortPause = feed(detector, 0.003, 400, speech.end)
    expect(shortPause.events).toEqual([])
    const more = feed(detector, 0.2, 500, shortPause.end)
    const pause = feed(detector, 0.003, DEFAULT_VAD.endSilenceMs + 100, more.end)
    expect(pause.events).toEqual(['speech-end'])
  })

  it('cuts an endless utterance and honours a raised barge-in bar', () => {
    const detector = new SpeechDetector({ ...DEFAULT_VAD, maxUtteranceMs: 2000 })
    const t = feed(detector, 0.003, 500, 0).end
    // Cut at the cap; continued speech then opens a new utterance.
    expect(feed(detector, 0.3, 3000, t).events.slice(0, 2)).toEqual(['speech-start', 'speech-end'])

    const strict = new SpeechDetector()
    const quiet = feed(strict, 0.004, 1000, 0).end
    strict.setOptions({ ratio: 8, minSpeechMs: 350 })
    expect(feed(strict, 0.05, 1000, quiet).events).toEqual([]) // agent's own voice level
    expect(feed(strict, 0.5, 1000, quiet + 1000).events).toEqual(['speech-start'])
  })

  it('computes RMS', () => {
    expect(rmsLevel(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5)
    expect(rmsLevel(new Float32Array())).toBe(0)
  })
})
