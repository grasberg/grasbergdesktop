/**
 * Hands-free voice call with the open conversation (v53): listen → detect
 * the end of the user's utterance → transcribe locally (whisper) → send →
 * wait for the reply → read it aloud → listen again. Speaking while the
 * agent talks interrupts it (barge-in, with a stricter threshold so the
 * agent's own voice does not trigger it). Everything runs on this machine:
 * the microphone audio never leaves it — only the transcript is sent.
 */

import { DEFAULT_VAD, rmsLevel, SpeechDetector } from '@shared/vad'
import { consumeSpeakable } from '@shared/tts-text'
import type { Message } from '@shared/types'
import { VoiceRecorder } from './recorder'
import { WebSpeechTtsEngine, ttsSupported } from './tts'

export type VoiceCallState = 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'ended'

export interface VoiceCallDeps {
  transcribe(wav: Uint8Array): Promise<string>
  send(text: string): Promise<boolean>
  /** Current messages of the open conversation (to find the reply). */
  messages(): Message[]
  subscribe(listener: () => void): () => void
  onState(state: VoiceCallState, detail?: string): void
}

export class VoiceCall {
  private recorder: VoiceRecorder | null = null
  private detector = new SpeechDetector()
  private tts: WebSpeechTtsEngine | null = null
  private state: VoiceCallState = 'starting'
  private ended = false
  /** Settles the current read-aloud wait (playback finished or interrupted). */
  private speechDone: (() => void) | null = null
  /** Releases a pending awaitReply (store subscription) when the call ends. */
  private cancelReply: (() => void) | null = null

  constructor(private readonly deps: VoiceCallDeps) {}

  private set(state: VoiceCallState, detail?: string): void {
    this.state = state
    this.deps.onState(state, detail)
  }

  async start(): Promise<void> {
    await this.listen()
  }

  /** Hangs up: stops the mic, the voice and any pending wait. */
  async end(): Promise<void> {
    this.ended = true
    this.cancelReply?.()
    this.cancelReply = null
    this.tts?.cancel()
    this.tts = null
    this.speechDone?.()
    await this.recorder?.cancel()
    this.recorder = null
    this.set('ended')
  }

  private async listen(): Promise<void> {
    if (this.ended) return
    this.detector = new SpeechDetector(DEFAULT_VAD)
    const recorder = new VoiceRecorder()
    recorder.onLevel = (chunk) => this.onChunk(chunk)
    recorder.onAutoStop = () => void this.finishUtterance()
    this.recorder = recorder
    await recorder.start()
    if (this.ended) {
      await recorder.cancel()
      return
    }
    if (this.state !== 'speaking') this.set('listening')
  }

  private onChunk(chunk: Float32Array): void {
    const event = this.detector.push(rmsLevel(chunk), performance.now())
    if (event === 'speech-start') {
      if (this.state === 'speaking') {
        // Barge-in: the user talks over the agent — stop the voice, keep listening.
        this.tts?.cancel()
        this.tts = null
        this.speechDone?.()
        this.detector.setOptions({ ratio: DEFAULT_VAD.ratio, minSpeechMs: DEFAULT_VAD.minSpeechMs })
      }
      this.set('hearing')
    } else if (event === 'speech-end') {
      void this.finishUtterance()
    }
  }

  private async finishUtterance(): Promise<void> {
    const recorder = this.recorder
    if (!recorder || this.ended) return
    this.recorder = null
    this.set('thinking')
    let text = ''
    try {
      text = (await this.deps.transcribe(await recorder.stop())).trim()
    } catch (e) {
      this.set('listening', e instanceof Error ? e.message : 'Transcription failed')
    }
    if (this.ended) return
    if (!text) {
      await this.listen()
      return
    }
    const before = new Set(this.deps.messages().map((m) => m.id))
    const sent = await this.deps.send(text)
    if (!sent || this.ended) {
      await this.listen()
      return
    }
    const reply = await this.awaitReply(before)
    if (this.ended) return
    await this.speak(reply)
  }

  /** Resolves with the new assistant message once it stops streaming. */
  private awaitReply(before: Set<string>): Promise<string> {
    return new Promise<string>((resolve) => {
      const check = (): boolean => {
        const reply = [...this.deps.messages()]
          .reverse()
          .find((m) => m.role === 'assistant' && !before.has(m.id))
        if (reply && reply.status !== 'streaming') {
          resolve(reply.status === 'complete' ? reply.content : '')
          return true
        }
        if (this.ended) {
          resolve('')
          return true
        }
        return false
      }
      if (check()) return
      const unsubscribe = this.deps.subscribe(() => {
        if (check()) {
          unsubscribe()
          this.cancelReply = null
        }
      })
      // end() releases the store subscription at once instead of leaving it
      // until the next store change.
      this.cancelReply = () => {
        unsubscribe()
        resolve('')
      }
    })
  }

  private async speak(text: string): Promise<void> {
    if (!text.trim() || !ttsSupported()) {
      await this.listen()
      return
    }
    const engine = new WebSpeechTtsEngine()
    this.tts = engine
    this.set('speaking')
    // Listen during playback so the user can interrupt — with a higher bar.
    await this.listen()
    this.detector.setOptions({ ratio: DEFAULT_VAD.ratio * 2.5, minSpeechMs: 350 })
    await new Promise<void>((resolve) => {
      this.speechDone = resolve
      engine.onIdle = () => resolve()
      const { sentences } = consumeSpeakable(text, 0, true)
      for (const sentence of sentences) engine.enqueue(sentence)
      if (engine.idle) resolve()
    })
    this.speechDone = null
    if (this.tts === engine) {
      this.tts = null
      if (!this.ended && this.state === 'speaking') {
        this.detector.setOptions({ ratio: DEFAULT_VAD.ratio, minSpeechMs: DEFAULT_VAD.minSpeechMs })
        this.set('listening')
      }
    }
  }
}
