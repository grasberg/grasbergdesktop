/**
 * VoiceService: chunked STT sessions with byte caps, and audio-attachment
 * transcription persisting extractedText into the real message row (real temp
 * SQLite, injected fake transcriber — no whisper binary anywhere).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHANNELS } from '@shared/ipc'
import type { Attachment, Message } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { VoiceService } from '../../../src/main/audio/voice-service'
import type { Transcriber } from '../../../src/main/audio/transcriber'

const WAV_KEY = `${randomUUID()}.wav`

let dir: string
let db: AppDatabase
let attachmentsDir: string
let broadcasts: Array<{ channel: string; payload: unknown }>

interface FakeTranscriber {
  wavCalls: Uint8Array[]
  fileCalls: string[]
  text: string
}

function makeFake(text = 'hej världen'): FakeTranscriber & Transcriber {
  const fake = {
    wavCalls: [] as Uint8Array[],
    fileCalls: [] as string[],
    text,
    async transcribeWav(bytes: Uint8Array): Promise<string> {
      fake.wavCalls.push(bytes)
      return fake.text
    },
    async transcribeFile(path: string): Promise<string> {
      fake.fileCalls.push(path)
      return fake.text
    },
    disposeAll(): void {},
  }
  return fake as unknown as FakeTranscriber & Transcriber
}

function makeService(fake: Transcriber): VoiceService {
  return new VoiceService({
    db,
    audioDir: join(dir, 'audio'),
    attachmentsDir,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    transcriber: fake,
  })
}

function seedMessageWithAudio(): { conversationId: string; message: Message; attachment: Attachment } {
  const conversation = db.conversations.create({ mode: 'chat', title: 'Voice test' })
  const attachment: Attachment = {
    id: 'att-1',
    name: 'memo.wav',
    mimeType: 'audio/wav',
    sizeBytes: 64,
    kind: 'audio',
    storageKey: WAV_KEY,
  }
  const message: Message = {
    id: randomUUID(),
    conversationId: conversation.id,
    role: 'user',
    content: 'Listen to this.',
    attachments: [attachment],
    status: 'complete',
    seq: 1,
    createdAt: Date.now(),
  }
  db.messages.insert(message)
  return { conversationId: conversation.id, message, attachment }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-voicesvc-'))
  attachmentsDir = join(dir, 'attachments')
  mkdirSync(attachmentsDir, { recursive: true })
  const wav = Buffer.alloc(64)
  wav.write('RIFF', 0)
  wav.write('WAVE', 8)
  writeFileSync(join(attachmentsDir, WAV_KEY), wav)
  db = openDatabase(join(dir, 'app.db'))
  broadcasts = []
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('STT sessions', () => {
  it('assembles the chunked bytes in order and returns the transcript', async () => {
    const fake = makeFake('ett två tre')
    const service = makeService(fake)
    const { sessionId } = service.sttBegin()
    service.sttChunk(sessionId, new Uint8Array([1, 2, 3]))
    service.sttChunk(sessionId, new Uint8Array([4, 5]))
    service.sttChunk(sessionId, new Uint8Array([6]))

    const { text } = await service.sttEnd(sessionId)

    expect(text).toBe('ett två tre')
    expect(fake.wavCalls).toHaveLength(1)
    expect(Array.from(fake.wavCalls[0])).toEqual([1, 2, 3, 4, 5, 6])
    // The session is gone: a second end fails.
    await expect(service.sttEnd(sessionId)).rejects.toThrow(/unknown/i)
  })

  it('an oversized chunk throws and drops the session', () => {
    const service = makeService(makeFake())
    const { sessionId } = service.sttBegin()
    expect(() => service.sttChunk(sessionId, new Uint8Array(8 * 1024 * 1024 + 1))).toThrow(/8 MB/)
    expect(() => service.sttChunk(sessionId, new Uint8Array([1]))).toThrow(/unknown/i)
  })

  it('exceeding the 64 MB session total throws and drops the session', () => {
    const service = makeService(makeFake())
    const { sessionId } = service.sttBegin()
    const eightMb = new Uint8Array(8 * 1024 * 1024)
    for (let i = 0; i < 8; i++) service.sttChunk(sessionId, eightMb)
    expect(() => service.sttChunk(sessionId, new Uint8Array([1]))).toThrow(/64 MB/)
    expect(() => service.sttChunk(sessionId, new Uint8Array([1]))).toThrow(/unknown/i)
  })

  it('cancel drops the session', async () => {
    const service = makeService(makeFake())
    const { sessionId } = service.sttBegin()
    service.sttChunk(sessionId, new Uint8Array([1]))
    service.sttCancel(sessionId)
    await expect(service.sttEnd(sessionId)).rejects.toThrow(/unknown/i)
  })
})

describe('transcribeAttachment', () => {
  it('persists extractedText onto the message attachment and broadcasts', async () => {
    const fake = makeFake('mötet flyttas till torsdag')
    const service = makeService(fake)
    const { conversationId, message, attachment } = seedMessageWithAudio()

    const { text } = await service.transcribeAttachment({
      storageKey: WAV_KEY,
      messageId: message.id,
      attachmentId: attachment.id,
    })

    expect(text).toBe('mötet flyttas till torsdag')
    const stored = db.messages.getById(message.id)
    expect(stored?.attachments?.[0]).toMatchObject({
      id: attachment.id,
      extractedText: 'mötet flyttas till torsdag',
      extraction: 'transcript',
    })
    expect(broadcasts).toContainEqual({
      channel: CHANNELS.conversationsChanged,
      payload: { conversationId },
    })
  })

  it('storageKey-only mode returns the text without touching the DB', async () => {
    const fake = makeFake()
    const service = makeService(fake)
    const { message } = seedMessageWithAudio()

    const { text } = await service.transcribeAttachment({ storageKey: WAV_KEY })

    expect(text).toBe('hej världen')
    expect(db.messages.getById(message.id)?.attachments?.[0].extractedText).toBeUndefined()
    expect(broadcasts).toHaveLength(0)
  })

  it('refuses traversal-shaped keys and non-audio extensions before disk', async () => {
    const fake = makeFake()
    const service = makeService(fake)
    await expect(service.transcribeAttachment({ storageKey: '../evil.wav' })).rejects.toThrow(
      /storage key/i
    )
    await expect(service.transcribeAttachment({ storageKey: 'a/b.wav' })).rejects.toThrow(
      /storage key/i
    )
    await expect(
      service.transcribeAttachment({ storageKey: `${randomUUID()}.png` })
    ).rejects.toThrow(/audio/i)
    expect(fake.wavCalls).toHaveLength(0)
    expect(fake.fileCalls).toHaveLength(0)
  })

  it('unknown attachment id on the message is an error (nothing persisted)', async () => {
    const service = makeService(makeFake())
    const { message } = seedMessageWithAudio()
    await expect(
      service.transcribeAttachment({
        storageKey: WAV_KEY,
        messageId: message.id,
        attachmentId: 'nope',
      })
    ).rejects.toThrow(/not found/i)
    expect(db.messages.getById(message.id)?.attachments?.[0].extractedText).toBeUndefined()
  })

  it('non-wav audio goes through transcribeFile against the stored path', async () => {
    const mp3Key = `${randomUUID()}.mp3`
    writeFileSync(join(attachmentsDir, mp3Key), Buffer.from('not really mp3'))
    const fake = makeFake('mp3 text')
    const service = makeService(fake)

    const { text } = await service.transcribeAttachment({ storageKey: mp3Key })

    expect(text).toBe('mp3 text')
    expect(fake.fileCalls).toEqual([join(attachmentsDir, mp3Key)])
    expect(fake.wavCalls).toHaveLength(0)
  })
})
