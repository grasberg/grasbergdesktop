/**
 * Read-aloud: a TtsEngine seam with the Web Speech API as the v1 engine.
 * The seam exists so a local neural engine (e.g. Kokoro) can slot in later —
 * deliberately NOT adding onnxruntime in v1. The text helpers are pure and
 * unit-tested in plain Node.
 */

import { speakableText, splitSentences } from '@shared/tts-text'

export { speakableText, splitSentences }

export interface TtsEngine {
  /** Queues one sentence; playback chains automatically. */
  enqueue(text: string): void
  /** Stops playback and clears the queue. */
  cancel(): void
  /** Fires when the queue drains (after at least one utterance). */
  onIdle?: () => void
}

/** True when this environment can speak at all. */
export function ttsSupported(): boolean {
  return typeof speechSynthesis !== 'undefined'
}

/**
 * Web Speech engine: one utterance per sentence, chained via onend. Utterance
 * 'error' advances the queue like 'end' (some platforms fire spurious errors
 * on rapid cancel/enqueue), so playback degrades instead of wedging.
 */
export class WebSpeechTtsEngine implements TtsEngine {
  onIdle?: () => void
  private queue: string[] = []
  private speaking = false
  private cancelled = false

  enqueue(text: string): void {
    if (!ttsSupported() || this.cancelled) return
    const trimmed = text.trim()
    if (!trimmed) return
    this.queue.push(trimmed)
    if (!this.speaking) this.next()
  }

  cancel(): void {
    this.cancelled = true
    this.queue = []
    this.speaking = false
    if (ttsSupported()) speechSynthesis.cancel()
  }

  /** Nothing queued or speaking (the caller may clean up immediately). */
  get idle(): boolean {
    return !this.speaking && this.queue.length === 0
  }

  private next(): void {
    const text = this.queue.shift()
    if (text === undefined) {
      this.speaking = false
      this.onIdle?.()
      return
    }
    this.speaking = true
    const utterance = new SpeechSynthesisUtterance(text)
    const advance = (): void => {
      if (this.cancelled) return
      this.next()
    }
    utterance.onend = advance
    utterance.onerror = advance
    speechSynthesis.speak(utterance)
  }
}
