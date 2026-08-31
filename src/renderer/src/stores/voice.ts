import { create } from 'zustand'
import type { VoiceStatus } from '@shared/types'
import { unwrap } from '@/api/uld'
import { consumeSpeakable } from '@shared/tts-text'
import { ttsSupported, WebSpeechTtsEngine } from '@/lib/tts'
import type { VoiceStoreState } from './contracts'
import { useChatStore } from './chat'
import { toastError } from './ui'

/** Renderer-side slice size for the chunked WAV upload (well under the 8 MB cap). */
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024

/** True when push-to-talk can run: binary present + the active model downloaded. */
export function sttReady(status: VoiceStatus | null): boolean {
  if (!status || !status.binaryReady) return false
  return status.models.some((m) => m.id === status.activeModelId && m.downloaded)
}

/** The one live read-aloud playback (engine + its chat-store subscription). */
let active: { engine: WebSpeechTtsEngine; unsub: (() => void) | null } | null = null

export const useVoiceStore = create<VoiceStoreState>()((set, get) => ({
  status: null,
  loaded: false,
  recording: false,
  speakingMessageId: null,
  downloadProgress: null,

  async load() {
    try {
      const status = await unwrap(window.uld.voice.status())
      set({ status, loaded: true })
    } catch (e) {
      set({ loaded: true })
      toastError('Failed to load voice status', e)
    }
  },

  async download(modelId) {
    try {
      const status = await unwrap(window.uld.voice.download(modelId))
      set({ status })
    } catch (e) {
      toastError('Could not start the download', e)
    }
  },

  async cancelDownload() {
    try {
      const status = await unwrap(window.uld.voice.cancelDownload())
      set({ status })
    } catch (e) {
      toastError('Could not cancel the download', e)
    }
  },

  async remove(modelId) {
    try {
      const status = await unwrap(window.uld.voice.remove(modelId))
      set({ status })
    } catch (e) {
      toastError('Could not remove the model', e)
    }
  },

  async pickBinary(clear) {
    try {
      const status = await unwrap(window.uld.voice.pickBinary(clear))
      set({ status })
    } catch (e) {
      toastError('Could not set the whisper binary', e)
    }
  },

  async sendRecording(wav) {
    const { sessionId } = await unwrap(window.uld.voice.sttBegin())
    try {
      for (let i = 0; i < wav.byteLength; i += UPLOAD_CHUNK_BYTES) {
        // slice (not subarray): structured clone copies the WHOLE backing buffer.
        await unwrap(
          window.uld.voice.sttChunk(sessionId, wav.slice(i, Math.min(i + UPLOAD_CHUNK_BYTES, wav.byteLength)))
        )
      }
      const { text } = await unwrap(window.uld.voice.sttEnd(sessionId))
      return text
    } catch (e) {
      void window.uld.voice.sttCancel(sessionId)
      throw e
    }
  },

  setRecording(on) {
    set({ recording: on })
  },

  play(messageId) {
    get().stopSpeaking()
    if (!ttsSupported()) return
    const message = useChatStore.getState().messages.find((m) => m.id === messageId)
    if (!message) return

    const engine = new WebSpeechTtsEngine()
    const playback: { engine: WebSpeechTtsEngine; unsub: (() => void) | null } = {
      engine,
      unsub: null,
    }
    active = playback
    set({ speakingMessageId: messageId })

    const cleanup = (): void => {
      playback.unsub?.()
      playback.unsub = null
      if (active === playback) active = null
      if (get().speakingMessageId === messageId) set({ speakingMessageId: null })
    }

    // Offsets track the RAW content (append-only while streaming); the
    // fence-aware helper converts each completed sentence to speakable text
    // and holds back unclosed ``` blocks so code is never read aloud.
    let spokenOffset = 0
    let streamDone = false
    const feed = (content: string, final: boolean): void => {
      const result = consumeSpeakable(content, spokenOffset, final)
      for (const sentence of result.sentences) engine.enqueue(sentence)
      spokenOffset = result.offset
      if (final) streamDone = true
    }

    engine.onIdle = () => {
      if (streamDone) cleanup()
    }

    if (message.status === 'streaming') {
      playback.unsub = useChatStore.subscribe((state) => {
        if (active !== playback) return
        const current = state.messages.find((m) => m.id === messageId)
        if (!current) {
          engine.cancel()
          cleanup()
          return
        }
        feed(current.content, current.status !== 'streaming')
        if (streamDone) {
          playback.unsub?.()
          playback.unsub = null
          if (engine.idle) cleanup()
        }
      })
      feed(message.content, false)
    } else {
      feed(message.content, true)
      if (engine.idle) cleanup()
    }
  },

  stopSpeaking() {
    const playback = active
    if (playback) {
      playback.engine.cancel()
      playback.unsub?.()
      active = null
    }
    if (get().speakingMessageId !== null) set({ speakingMessageId: null })
  },

  handleDownloadProgress(e) {
    set({ downloadProgress: e.status === 'done' ? null : e })
    if (e.status === 'done' || e.status === 'error') void get().load()
  },
}))
