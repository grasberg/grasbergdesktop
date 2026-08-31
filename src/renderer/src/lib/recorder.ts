/**
 * Push-to-talk mic capture: getUserMedia → AudioWorklet (static same-origin
 * asset pcm-worklet.js) → Float32 chunks → 16 kHz mono 16-bit RIFF WAV.
 * The pure WAV encoding lives in wav-encode.ts (plain-Node testable).
 */

import { encodeWav, RECORD_SAMPLE_RATE } from '@shared/wav-encode'

export { encodeWav, RECORD_SAMPLE_RATE }

/** Auto-stop cap on a recording (also the transcriber's practical limit). */
export const MAX_RECORD_MS = 10 * 60_000

/** Thrown when the OS/user denied the microphone. */
export class MicDeniedError extends Error {
  constructor() {
    super('Microphone access was denied.')
    this.name = 'MicDeniedError'
  }
}

export class VoiceRecorder {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private chunks: Float32Array[] = []
  private samples = 0
  private stopTimer: number | null = null

  /** Called once when the 10-minute cap auto-stops the recording. */
  onAutoStop: (() => void) | null = null

  async start(): Promise<void> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        throw new MicDeniedError()
      }
      throw error
    }
    this.stream = stream
    // Chromium resamples the mic to the context rate, so whisper gets 16 kHz.
    const context = new AudioContext({ sampleRate: RECORD_SAMPLE_RATE })
    this.context = context
    await context.audioWorklet.addModule(new URL('pcm-worklet.js', document.baseURI).toString())
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'pcm-capture')
    this.node = node
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.chunks.push(event.data)
      this.samples += event.data.length
    }
    source.connect(node)
    // Web Audio only renders subgraphs reachable from the destination; without
    // this the worklet's process() is never called. The processor emits no
    // output samples, so this stays silent.
    node.connect(context.destination)
    this.stopTimer = window.setTimeout(() => this.onAutoStop?.(), MAX_RECORD_MS)
  }

  /** Stops capture and returns the encoded WAV bytes. */
  async stop(): Promise<Uint8Array> {
    const chunks = this.chunks
    const total = this.samples
    await this.teardown()
    const samples = new Float32Array(total)
    let offset = 0
    for (const chunk of chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    return new Uint8Array(encodeWav(samples))
  }

  /** Discards the recording. */
  async cancel(): Promise<void> {
    await this.teardown()
  }

  private async teardown(): Promise<void> {
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    if (this.node) {
      this.node.port.onmessage = null
      try {
        this.node.disconnect()
      } catch {
        // already disconnected
      }
      this.node = null
    }
    if (this.context) {
      await this.context.close().catch(() => undefined)
      this.context = null
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
    this.chunks = []
    this.samples = 0
  }
}
