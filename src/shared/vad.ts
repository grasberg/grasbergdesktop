/**
 * Voice activity detection for hands-free voice calls (v53, dots "call your
 * dot" / Muse voice). Energy-based with an adaptive noise floor: speech
 * starts when the level stays above floor × ratio for `minSpeechMs`, and the
 * utterance ends after `endSilenceMs` below it. Pure — the renderer feeds it
 * RMS levels from the microphone worklet; tests feed it numbers.
 */

export interface VadOptions {
  /** Level must exceed noiseFloor × this to count as speech. */
  ratio: number
  /** Absolute floor so a silent room does not make every breath "speech". */
  minLevel: number
  minSpeechMs: number
  endSilenceMs: number
  /** An utterance is cut here even if the speaker never pauses. */
  maxUtteranceMs: number
}

export const DEFAULT_VAD: VadOptions = {
  ratio: 3,
  minLevel: 0.012,
  minSpeechMs: 220,
  endSilenceMs: 900,
  maxUtteranceMs: 60_000,
}

export type VadEvent = 'speech-start' | 'speech-end' | null

export class SpeechDetector {
  private noiseFloor = 0.004
  private aboveSince: number | null = null
  private belowSince: number | null = null
  private speaking = false
  private speechStartedAt = 0

  constructor(private options: VadOptions = DEFAULT_VAD) {}

  /** Raise the bar (e.g. while the agent itself is talking: barge-in only for clear speech). */
  setOptions(patch: Partial<VadOptions>): void {
    this.options = { ...this.options, ...patch }
  }

  get isSpeaking(): boolean {
    return this.speaking
  }

  /** Feeds one level sample (RMS, 0..1) at time `now` (ms). */
  push(level: number, now: number): VadEvent {
    const threshold = Math.max(this.options.minLevel, this.noiseFloor * this.options.ratio)
    const loud = level > threshold
    if (!this.speaking) {
      // Track the floor only while nobody speaks (slow rise, fast fall).
      this.noiseFloor = level < this.noiseFloor ? this.noiseFloor * 0.9 + level * 0.1 : this.noiseFloor * 0.995 + level * 0.005
      if (loud) {
        this.aboveSince ??= now
        if (now - this.aboveSince >= this.options.minSpeechMs) {
          this.speaking = true
          this.speechStartedAt = this.aboveSince
          this.belowSince = null
          return 'speech-start'
        }
      } else {
        this.aboveSince = null
      }
      return null
    }
    if (now - this.speechStartedAt >= this.options.maxUtteranceMs) return this.end()
    if (loud) {
      this.belowSince = null
      return null
    }
    this.belowSince ??= now
    return now - this.belowSince >= this.options.endSilenceMs ? this.end() : null
  }

  private end(): VadEvent {
    this.speaking = false
    this.aboveSince = null
    this.belowSince = null
    return 'speech-end'
  }

  reset(): void {
    this.speaking = false
    this.aboveSince = null
    this.belowSince = null
  }
}

/** Root-mean-square level of a PCM chunk. */
export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}
