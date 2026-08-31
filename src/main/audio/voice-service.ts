/**
 * Glue for the voice IPC surface: chunked push-to-talk STT sessions, audio
 * attachment transcription (with optional transcript persistence onto the
 * message row), and model download/management delegation.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { CHANNELS } from '@shared/ipc'
import { isValidStorageKey } from '@shared/schemas'
import type { VoiceModelId, VoiceStatus } from '@shared/types'
import type { AppDatabase } from '../db/database'
import { ProviderError } from '../providers/errors'
import { MAX_STT_SESSION_BYTES, STT_CHUNK_MAX_BYTES } from './constants'
import { VoiceModelManager } from './model-manager'
import { Transcriber } from './transcriber'

/** Storage-key extensions the Transcribe action accepts (WAV always decodes; the rest depend on the binary's decoders). */
const AUDIO_TRANSCRIBE_EXTENSIONS = new Set(['wav', 'mp3', 'ogg', 'flac', 'm4a'])

const SESSION_IDLE_MS = 10 * 60_000

interface SttSession {
  chunks: Buffer[]
  bytes: number
  touchedAt: number
}

export interface VoiceServiceOptions {
  db: AppDatabase
  /** {userData}/audio — binary, models, temp WAVs. */
  audioDir: string
  /** Where stored attachments live (storageKey reads). */
  attachmentsDir: string
  broadcast: (channel: string, payload: unknown) => void
  /** Test seams. */
  manager?: VoiceModelManager
  transcriber?: Transcriber
}

function invalid(message: string): ProviderError {
  return new ProviderError('invalid_request', message)
}

export class VoiceService {
  private readonly manager: VoiceModelManager
  private readonly transcriber: Transcriber
  private readonly sessions = new Map<string, SttSession>()

  constructor(private readonly options: VoiceServiceOptions) {
    this.manager =
      options.manager ??
      new VoiceModelManager({
        dir: options.audioDir,
        broadcast: options.broadcast,
        customBinaryPath: () => options.db.settings.get().voiceWhisperBinaryPath,
        activeModelId: () => options.db.settings.get().voiceModelId,
      })
    this.transcriber =
      options.transcriber ??
      new Transcriber({
        resolveBinary: () => this.manager.binaryPath(),
        resolveModel: () => this.manager.modelPath(this.options.db.settings.get().voiceModelId),
        tmpDir: join(options.audioDir, 'tmp'),
      })
  }

  status(): VoiceStatus {
    return this.manager.status()
  }

  get downloading(): boolean {
    return this.manager.downloading
  }

  /** Long download — callers fire-and-forget; progress rides the push channel. */
  download(modelId: VoiceModelId): Promise<void> {
    return this.manager.download(modelId)
  }

  cancelDownload(): void {
    this.manager.cancel()
  }

  remove(modelId: VoiceModelId): Promise<void> {
    return this.manager.remove(modelId)
  }

  // -- push-to-talk sessions --------------------------------------------------

  sttBegin(): { sessionId: string } {
    this.sweepSessions()
    const sessionId = randomUUID()
    this.sessions.set(sessionId, { chunks: [], bytes: 0, touchedAt: Date.now() })
    return { sessionId }
  }

  sttChunk(sessionId: string, chunk: Uint8Array): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw invalid('Unknown recording session.')
    if (chunk.byteLength === 0 || chunk.byteLength > STT_CHUNK_MAX_BYTES) {
      this.sessions.delete(sessionId)
      throw invalid('Audio chunk must be 1 byte to 8 MB.')
    }
    if (session.bytes + chunk.byteLength > MAX_STT_SESSION_BYTES) {
      this.sessions.delete(sessionId)
      throw invalid('The recording exceeds the 64 MB limit.')
    }
    session.chunks.push(Buffer.from(chunk))
    session.bytes += chunk.byteLength
    session.touchedAt = Date.now()
  }

  async sttEnd(sessionId: string): Promise<{ text: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw invalid('Unknown recording session.')
    if (session.bytes === 0) {
      this.sessions.delete(sessionId)
      throw invalid('The recording is empty.')
    }
    session.touchedAt = Date.now()
    const wav = Buffer.concat(session.chunks)
    // Delete only after success: a transient "busy" rejection from the
    // transcriber queue must not destroy the assembled recording (the renderer
    // cancels explicitly when it gives up, and the idle sweep bounds leaks).
    const text = await this.transcriber.transcribeWav(wav)
    this.sessions.delete(sessionId)
    return { text }
  }

  sttCancel(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private sweepSessions(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS
    for (const [id, session] of this.sessions) {
      if (session.touchedAt < cutoff) this.sessions.delete(id)
    }
  }

  // -- audio attachments ------------------------------------------------------

  /**
   * Transcribes a stored audio attachment. With messageId+attachmentId the
   * transcript is written into that message's attachments JSON and
   * push:conversationsChanged fires so every window refreshes.
   */
  async transcribeAttachment(req: {
    storageKey: string
    messageId?: string
    attachmentId?: string
  }): Promise<{ text: string }> {
    // Defense in depth (the readStoredImage discipline): only app-shaped keys
    // with an audio extension ever touch the attachments dir.
    if (!isValidStorageKey(req.storageKey)) throw invalid('Invalid attachment storage key.')
    const ext = extname(req.storageKey).slice(1).toLowerCase()
    if (!AUDIO_TRANSCRIBE_EXTENSIONS.has(ext)) {
      throw invalid('Only audio attachments can be transcribed.')
    }
    // Persisting mode: verify BEFORE transcribing that the target attachment
    // is the audio file the storageKey names — a mismatched id must never get
    // another file's transcript written onto it.
    if (req.messageId && req.attachmentId) {
      const message = this.options.db.messages.getById(req.messageId)
      if (!message) throw invalid('Message not found.')
      const target = (message.attachments ?? []).find((a) => a.id === req.attachmentId)
      if (!target) throw invalid('Attachment not found on that message.')
      if (target.kind !== 'audio' || target.storageKey !== req.storageKey) {
        throw invalid('That attachment is not the audio file being transcribed.')
      }
    }
    const path = join(this.options.attachmentsDir, req.storageKey)
    let text: string
    if (ext === 'wav') {
      const bytes = await readFile(path).catch(() => {
        throw invalid('That audio attachment is no longer available.')
      })
      text = await this.transcriber.transcribeWav(bytes)
    } else {
      text = await this.transcriber.transcribeFile(path)
    }

    if (req.messageId && req.attachmentId) {
      const db = this.options.db
      const message = db.messages.getById(req.messageId)
      if (!message) throw invalid('Message not found.')
      const attachments = (message.attachments ?? []).map((a) =>
        a.id === req.attachmentId
          ? { ...a, extractedText: text, extraction: 'transcript' as const }
          : a
      )
      if (!attachments.some((a) => a.id === req.attachmentId)) {
        throw invalid('Attachment not found on that message.')
      }
      db.messages.update(req.messageId, { attachments })
      this.options.broadcast(CHANNELS.conversationsChanged, {
        conversationId: message.conversationId,
      })
    }
    return { text }
  }

  disposeAll(): void {
    this.manager.cancel()
    this.transcriber.disposeAll()
    this.sessions.clear()
  }
}
