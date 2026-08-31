/**
 * PDF text extraction (pdfjs-dist) and the attachment-extraction dispatcher
 * behind app:extractAttachmentText. Heavy deps are lazy-loaded so they cost
 * nothing at startup; OCR lives in ./ocr and is injectable for tests.
 */

import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { AttachmentExtractionResult } from '@shared/ipc'
import { isValidStorageKey } from '@shared/schemas'

// Rollup emits main as CJS and rewrites bare import() of externals to
// require(); pdfjs-dist is ESM-only, so keep a real dynamic import via
// new Function. Vitest's VM has no dynamic-import callback for
// Function-created code — its own transformed import() works there instead.
async function importEsm(specifier: string): Promise<unknown> {
  try {
    const dynamicImport = new Function('s', 'return import(s)') as (
      s: string
    ) => Promise<unknown>
    return await dynamicImport(specifier)
  } catch (error) {
    if (error instanceof TypeError && /dynamic import callback/i.test(error.message)) {
      return import(/* @vite-ignore */ specifier)
    }
    throw error
  }
}

// -- minimal pdfjs surface (hand-rolled; the real types are ESM-only too) -----

export interface PdfTextItem {
  str?: string
  hasEOL?: boolean
}

export interface PdfObjs {
  get(name: string, callback: (value: unknown) => void): unknown
}

export interface PdfPageProxy {
  getTextContent(): Promise<{ items: PdfTextItem[] }>
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
  objs: PdfObjs
  commonObjs: PdfObjs
}

export interface PdfDocumentProxy {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageProxy>
  destroy(): Promise<void>
}

interface PdfjsModule {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocumentProxy> }
  OPS: Record<string, number>
}

let pdfjsPromise: Promise<PdfjsModule> | undefined

/** Lazily loads the pdfjs legacy Node build (fake worker, no canvas). */
export async function loadPdfjs(): Promise<PdfjsModule> {
  // Clear the memo on rejection so a transient import failure (AV file lock)
  // doesn't poison PDF extraction until restart.
  pdfjsPromise ??= (importEsm('pdfjs-dist/legacy/build/pdf.mjs') as Promise<PdfjsModule>).catch(
    (error) => {
      pdfjsPromise = undefined
      throw error
    }
  )
  return pdfjsPromise
}

/** Opens a PDF document from bytes with our hardened defaults. */
export async function openPdf(bytes: Uint8Array): Promise<{
  pdfjs: PdfjsModule
  doc: PdfDocumentProxy
}> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    // Copy: pdfjs rejects Buffer subclasses and may detach the buffer.
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise
  return { pdfjs, doc }
}

export const PDF_MAX_PAGES = 50
export const PDF_MAX_CHARS = 200_000
/** Below this many chars per parsed page the text layer counts as absent. */
export const LOW_TEXT_CHARS_PER_PAGE = 20

export interface PdfTextResult {
  text: string
  pageCount: number
  pagesParsed: number
  truncated: boolean
  /** True when the text layer is effectively empty (scanned PDF) — offer OCR. */
  lowText: boolean
}

/**
 * Extracts the text layer of a PDF, capped by pages and characters. When
 * truncated, the note is appended INTO the text so the model sees it.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  limits?: { maxPages?: number; maxChars?: number }
): Promise<PdfTextResult> {
  const maxPages = limits?.maxPages ?? PDF_MAX_PAGES
  const maxChars = limits?.maxChars ?? PDF_MAX_CHARS
  const { doc } = await openPdf(bytes)
  try {
    const pageCount = doc.numPages
    const pageTexts: string[] = []
    let chars = 0
    let charCapHit = false
    let pagesParsed = 0
    for (let n = 1; n <= Math.min(pageCount, maxPages); n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      let pageText = ''
      for (const item of content.items) {
        if (typeof item.str === 'string' && item.str.length > 0) pageText += item.str
        if (item.hasEOL) pageText += '\n'
        else if (item.str) pageText += ' '
      }
      pageText = pageText.trim()
      pagesParsed = n
      if (chars + pageText.length > maxChars) {
        pageText = pageText.slice(0, Math.max(0, maxChars - chars))
        charCapHit = true
      }
      if (pageText.length > 0) {
        pageTexts.push(pageText)
        chars += pageText.length
      }
      if (charCapHit) break
    }
    let text = pageTexts.join('\n\n')
    const lowText = text.trim().length < LOW_TEXT_CHARS_PER_PAGE * Math.max(1, pagesParsed)
    const truncated = charCapHit || pagesParsed < pageCount
    // Never ship the note as the ENTIRE payload: an empty scanned PDF must
    // return empty text so the Composer's empty-string guard drops it.
    if (truncated && text.trim().length > 0) {
      text += `\n\n[Extraction truncated: first ${pagesParsed} of ${pageCount} pages / ${maxChars} character cap]`
    }
    return { text, pageCount, pagesParsed, truncated, lowText }
  } finally {
    await doc.destroy()
  }
}

const OCR_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

export interface ExtractDeps {
  ocrImage?: (path: string) => Promise<string>
  ocrPdf?: (bytes: Uint8Array) => Promise<string>
}

/**
 * Dispatcher for app:extractAttachmentText. `deps` is the injectable OCR seam
 * (git-service deps pattern) so unit tests never spawn tesseract.
 */
export async function extractAttachment(
  attachmentsDir: string,
  storageKey: string,
  method: 'text' | 'ocr',
  deps?: ExtractDeps
): Promise<AttachmentExtractionResult> {
  // Defense in depth (like readStoredImage): only app-shaped keys touch disk.
  if (!isValidStorageKey(storageKey)) throw new Error('Invalid attachment storage key')
  const ext = extname(storageKey).slice(1).toLowerCase()

  if (method === 'text') {
    if (ext !== 'pdf') throw new Error('Text extraction is only available for PDF attachments')
    const bytes = await readFile(join(attachmentsDir, storageKey))
    const result = await extractPdfText(bytes)
    return {
      extractedText: result.text,
      extraction: result.lowText ? 'none' : 'text',
      pageCount: result.pageCount,
      truncated: result.truncated,
    }
  }

  let raw: string
  if (ext === 'pdf') {
    const bytes = await readFile(join(attachmentsDir, storageKey))
    const run = deps?.ocrPdf ?? (await import('./ocr')).ocrPdf
    raw = await run(bytes)
  } else if (OCR_IMAGE_EXTENSIONS.has(ext)) {
    // Stat first so a missing file fails fast with a clear error.
    await readFile(join(attachmentsDir, storageKey))
    const run = deps?.ocrImage ?? (await import('./ocr')).ocrImage
    raw = await run(join(attachmentsDir, storageKey))
  } else {
    throw new Error('OCR is only available for PDF and image attachments')
  }
  const truncated = raw.length > PDF_MAX_CHARS
  const extractedText = truncated
    ? `${raw.slice(0, PDF_MAX_CHARS)}\n\n[Extraction truncated: ${PDF_MAX_CHARS} character cap]`
    : raw
  return { extractedText, extraction: 'ocr', truncated }
}
