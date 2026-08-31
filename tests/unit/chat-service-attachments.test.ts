import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Attachment, Message } from '@shared/types'
import type { ContentPart } from '../../src/main/providers/adapter'
import { composeUserContent } from '../../src/main/services/chat-service'
import { MAX_RAW_ATTACH_BYTES } from '../../src/main/ipc/attachments'

const PDF_KEY = '550e8400-e29b-41d4-a716-446655440000.pdf'
const PDF_BYTES = Buffer.from('%PDF-1.4 fake body for wire tests')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-compose-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, PDF_KEY), PDF_BYTES)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function msg(attachments: Attachment[]): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'user',
    content: 'Look at this.',
    attachments,
    status: 'complete',
    seq: 1,
    createdAt: Date.now(),
  }
}

function pdfAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: PDF_BYTES.byteLength,
    kind: 'pdf',
    storageKey: PDF_KEY,
    ...overrides,
  }
}

describe('composeUserContent — PDFs', () => {
  it('inlines extracted text as a plain string (no rawAttach)', () => {
    const content = composeUserContent(
      msg([pdfAttachment({ extractedText: 'Quarterly numbers', extraction: 'text' })]),
      false,
      dir
    )
    expect(typeof content).toBe('string')
    expect(content).toContain('[Attached PDF: report.pdf]')
    expect(content).toContain('Quarterly numbers')
  })

  it('rawAttach under the cap produces a document part with the stored bytes', () => {
    const content = composeUserContent(
      msg([pdfAttachment({ extractedText: 'Quarterly numbers', extraction: 'text', rawAttach: true })]),
      false,
      dir
    ) as ContentPart[]
    expect(Array.isArray(content)).toBe(true)
    const part = content.find((p) => p.type === 'document')
    expect(part).toBeDefined()
    if (part?.type !== 'document') throw new Error('unreachable')
    expect(part.mediaType).toBe('application/pdf')
    expect(part.dataBase64).toBe(PDF_BYTES.toString('base64'))
    expect(part.name).toBe('report.pdf')
    expect(part.fallbackText).toContain('Quarterly numbers')
  })

  it('rawAttach over the cap falls back to inlined text', () => {
    const bigKey = '550e8400-e29b-41d4-a716-446655440002.pdf'
    writeFileSync(join(dir, bigKey), Buffer.alloc(MAX_RAW_ATTACH_BYTES + 1))
    const content = composeUserContent(
      msg([
        pdfAttachment({
          storageKey: bigKey,
          sizeBytes: MAX_RAW_ATTACH_BYTES + 1,
          extractedText: 'Quarterly numbers',
          rawAttach: true,
        }),
      ]),
      false,
      dir
    )
    expect(typeof content).toBe('string')
    expect(content).toContain('Quarterly numbers')
  })

  it('rawAttach with a missing or invalid storageKey falls back to inlined text', () => {
    for (const storageKey of ['550e8400-e29b-41d4-a716-446655440003.pdf', '../evil.pdf']) {
      const content = composeUserContent(
        msg([pdfAttachment({ storageKey, extractedText: 'Quarterly numbers', rawAttach: true })]),
        false,
        dir
      )
      expect(typeof content).toBe('string')
      expect(content).toContain('Quarterly numbers')
    }
  })

  it("extraction 'none' without text yields the honest not-sent note", () => {
    const content = composeUserContent(msg([pdfAttachment({ extraction: 'none' })]), false, dir)
    expect(content).toContain(
      '[Attached PDF: report.pdf — no machine-readable text was extracted and it was not sent]'
    )
  })
})

describe('composeUserContent — audio', () => {
  function audioAttachment(overrides: Partial<Attachment> = {}): Attachment {
    return {
      id: 'a3',
      name: 'memo.wav',
      mimeType: 'audio/wav',
      sizeBytes: 64,
      kind: 'audio',
      storageKey: '550e8400-e29b-41d4-a716-446655440020.wav',
      ...overrides,
    }
  }

  it('inlines the transcript when the attachment was transcribed', () => {
    const content = composeUserContent(
      msg([audioAttachment({ extractedText: 'mötet flyttas till torsdag', extraction: 'transcript' })]),
      false,
      dir
    )
    expect(typeof content).toBe('string')
    expect(content).toContain('[Transcript of audio memo.wav]')
    expect(content).toContain('mötet flyttas till torsdag')
  })

  it('an untranscribed audio attachment yields the honest not-sent note', () => {
    const content = composeUserContent(msg([audioAttachment()]), false, dir)
    expect(content).toContain('[Attached audio: memo.wav — not transcribed')
    expect(content).not.toContain('could not be read as text')
  })
})

describe('composeUserContent — image OCR text', () => {
  const IMAGE_KEY = '550e8400-e29b-41d4-a716-446655440010.png'

  function imageAttachment(): Attachment {
    return {
      id: 'a2',
      name: 'scan.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      kind: 'image',
      storageKey: IMAGE_KEY,
      extractedText: 'Invoice total 42',
      extraction: 'ocr',
    }
  }

  it('inlines OCR text AND keeps the image part when vision is enabled', () => {
    writeFileSync(join(dir, IMAGE_KEY), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const content = composeUserContent(msg([imageAttachment()]), true, dir) as ContentPart[]
    expect(Array.isArray(content)).toBe(true)
    const text = content.find((p) => p.type === 'text')
    if (text?.type !== 'text') throw new Error('missing text part')
    expect(text.text).toContain('[OCR text of image scan.png]')
    expect(text.text).toContain('Invoice total 42')
    expect(content.some((p) => p.type === 'image_url')).toBe(true)
  })

  it('inlines only the OCR text when vision is not supported', () => {
    const content = composeUserContent(msg([imageAttachment()]), false, dir)
    expect(typeof content).toBe('string')
    expect(content).toContain('Invoice total 42')
    expect(content).not.toContain('no vision support')
  })
})
