import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractAttachment,
  extractPdfText,
  LOW_TEXT_CHARS_PER_PAGE,
} from '../../../src/main/attachments/extract'
import { encodeBmp } from '../../../src/main/attachments/ocr'
import { makeScannedPdf, makeTextPdf } from '../../helpers/pdf-fixtures'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-extract-'))
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('extractPdfText', () => {
  // Also proves the pdfjs-dist legacy lazy-load path works in plain Node.
  it('extracts the text layer of a generated PDF', async () => {
    const result = await extractPdfText(
      new Uint8Array(makeTextPdf(['Hello Grasberg PDF with a proper amount of page text']))
    )
    expect(result.text).toContain('Hello Grasberg PDF')
    expect(result.pageCount).toBe(1)
    expect(result.pagesParsed).toBe(1)
    expect(result.truncated).toBe(false)
    expect(result.lowText).toBe(false)
  })

  it('flags a scanned (no text layer) PDF as lowText', async () => {
    const result = await extractPdfText(new Uint8Array(makeScannedPdf()))
    expect(result.lowText).toBe(true)
    expect(result.text.trim().length).toBeLessThan(LOW_TEXT_CHARS_PER_PAGE)
  })

  it('caps pages and appends the truncation note into the text', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => `This is page number ${i + 1} of the fixture`)
    const result = await extractPdfText(new Uint8Array(makeTextPdf(pages)), { maxPages: 2 })
    expect(result.pagesParsed).toBe(2)
    expect(result.pageCount).toBe(5)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('page number 2')
    expect(result.text).not.toContain('page number 3')
    expect(result.text).toContain('[Extraction truncated: first 2 of 5 pages')
  })

  it('respects the character cap', async () => {
    const result = await extractPdfText(
      new Uint8Array(makeTextPdf(['A long enough first page of text', 'second page'])),
      { maxChars: 20 }
    )
    expect(result.truncated).toBe(true)
    const body = result.text.split('\n\n[Extraction truncated')[0]
    expect(body.length).toBeLessThanOrEqual(20)
  })
})

describe('extractAttachment dispatch', () => {
  const KEY_PDF = '550e8400-e29b-41d4-a716-446655440000.pdf'
  const KEY_PNG = '550e8400-e29b-41d4-a716-446655440001.png'

  it("method 'text' on a text PDF returns extraction 'text'", async () => {
    writeFileSync(
      join(dir, KEY_PDF),
      makeTextPdf(['Hello Grasberg PDF with a proper amount of page text'])
    )
    const result = await extractAttachment(dir, KEY_PDF, 'text')
    expect(result.extraction).toBe('text')
    expect(result.extractedText).toContain('Hello Grasberg PDF')
    expect(result.pageCount).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it("method 'text' on a scanned PDF returns extraction 'none' (OCR offered)", async () => {
    writeFileSync(join(dir, KEY_PDF), makeScannedPdf())
    const result = await extractAttachment(dir, KEY_PDF, 'text')
    expect(result.extraction).toBe('none')
  })

  it("method 'ocr' on an image routes to the injected ocrImage seam", async () => {
    writeFileSync(join(dir, KEY_PNG), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const ocrImage = vi.fn().mockResolvedValue('recognized image text')
    const ocrPdf = vi.fn()
    const result = await extractAttachment(dir, KEY_PNG, 'ocr', { ocrImage, ocrPdf })
    expect(result).toEqual({
      extractedText: 'recognized image text',
      extraction: 'ocr',
      truncated: false,
    })
    expect(ocrImage).toHaveBeenCalledWith(join(dir, KEY_PNG))
    expect(ocrPdf).not.toHaveBeenCalled()
  })

  it("method 'ocr' on a PDF routes to the injected ocrPdf seam", async () => {
    const bytes = makeScannedPdf()
    writeFileSync(join(dir, KEY_PDF), bytes)
    const ocrPdf = vi.fn().mockResolvedValue('recognized pdf text')
    const result = await extractAttachment(dir, KEY_PDF, 'ocr', { ocrPdf })
    expect(result.extraction).toBe('ocr')
    expect(result.extractedText).toBe('recognized pdf text')
    expect(ocrPdf).toHaveBeenCalledTimes(1)
    expect(Buffer.from(ocrPdf.mock.calls[0][0] as Uint8Array).equals(bytes)).toBe(true)
  })

  it("method 'text' on a non-PDF key throws", async () => {
    writeFileSync(join(dir, KEY_PNG), Buffer.from([1]))
    await expect(extractAttachment(dir, KEY_PNG, 'text')).rejects.toThrow('only available for PDF')
  })

  it('rejects traversal-shaped keys before touching the filesystem', async () => {
    await expect(extractAttachment(dir, '../x.pdf', 'text')).rejects.toThrow('Invalid attachment')
    await expect(extractAttachment(dir, 'a/b.pdf', 'ocr')).rejects.toThrow('Invalid attachment')
  })

  it('rejects a missing file', async () => {
    await expect(extractAttachment(dir, KEY_PDF, 'text')).rejects.toThrow()
  })
})

describe('encodeBmp', () => {
  it('encodes RGB_24BPP data bottom-up in BGR with row padding', () => {
    // 2x2 RGB: row0 = red, green; row1 = blue, white.
    const data = new Uint8Array([
      255, 0, 0,   0, 255, 0,
      0, 0, 255,   255, 255, 255,
    ])
    const bmp = encodeBmp(2, 2, 2, data)
    expect(bmp.subarray(0, 2).toString('ascii')).toBe('BM')
    const rowSize = 8 // 2 px * 3 bytes = 6, padded to 8
    expect(bmp.readUInt32LE(2)).toBe(54 + rowSize * 2)
    expect(bmp.readUInt32LE(10)).toBe(54)
    expect(bmp.readInt32LE(18)).toBe(2)
    expect(bmp.readInt32LE(22)).toBe(2)
    expect(bmp.readUInt16LE(28)).toBe(24)
    // Bottom-up: the first stored row is source row 1 (blue, white) in BGR.
    expect([...bmp.subarray(54, 54 + 6)]).toEqual([255, 0, 0, 255, 255, 255])
    // Second stored row is source row 0 (red, green) in BGR.
    expect([...bmp.subarray(54 + rowSize, 54 + rowSize + 6)]).toEqual([0, 0, 255, 0, 255, 0])
  })

  it('expands GRAYSCALE_1BPP bits to white/black pixels', () => {
    // 2x1, MSB-first: bit7=1 (white), bit6=0 (black).
    const bmp = encodeBmp(2, 1, 1, new Uint8Array([0b10000000]))
    expect([...bmp.subarray(54, 54 + 6)]).toEqual([255, 255, 255, 0, 0, 0])
  })
})
