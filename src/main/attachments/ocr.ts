/**
 * OCR (tesseract.js) for stored image attachments and scanned PDFs. Always
 * user-triggered — nothing here runs automatically. tesseract.js downloads
 * eng.traineddata from its CDN on first use and caches it under the
 * attachments dir, so the very first OCR needs the network once.
 *
 * Scanned-PDF OCR deliberately renders no pages (node-canvas is a native dep,
 * banned): it harvests the embedded page images from pdfjs' operator list,
 * re-encodes them as uncompressed BMPs, and feeds those to tesseract.
 */

import { mkdir } from 'node:fs/promises'
import type { PdfPageProxy } from './extract'
import { loadPdfjs, openPdf } from './extract'

let ocrCacheDir: string | undefined

/** Where tesseract caches its traineddata (set once during IPC registration). */
export function setOcrCacheDir(dir: string): void {
  ocrCacheDir = dir
}

type TesseractWorker = {
  recognize(image: string | Buffer): Promise<{ data: { text: string } }>
  terminate(): Promise<unknown>
}

async function createOcrWorker(): Promise<TesseractWorker> {
  // tesseract.js writes traineddata with a bare fs.writeFile (no mkdir) and
  // swallows the failure, so without this the cache silently never works.
  if (ocrCacheDir) await mkdir(ocrCacheDir, { recursive: true }).catch(() => undefined)
  // tesseract.js ships CJS; a plain dynamic import is safe under rollup.
  const { createWorker } = await import('tesseract.js')
  try {
    return (await createWorker(
      'eng',
      1,
      ocrCacheDir ? { cachePath: ocrCacheDir } : {}
    )) as unknown as TesseractWorker
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Could not start OCR (the first run downloads language data and needs the network): ${message}`
    )
  }
}

/** OCRs a stored image file. English only in v1. */
export async function ocrImage(filePath: string): Promise<string> {
  const worker = await createOcrWorker()
  try {
    const { data } = await worker.recognize(filePath)
    return data.text
  } finally {
    await worker.terminate()
  }
}

// pdfjs ImageKind values (not exported by the legacy build's types).
const GRAYSCALE_1BPP = 1
const RGB_24BPP = 2
const RGBA_32BPP = 3

/**
 * Encodes raw pdfjs image data as an uncompressed 24-bit BMP
 * (BITMAPINFOHEADER, bottom-up rows, BGR, 4-byte row padding).
 */
export function encodeBmp(
  width: number,
  height: number,
  kind: number,
  data: Uint8Array | Uint8ClampedArray
): Buffer {
  const rowSize = (width * 3 + 3) & ~3
  const pixelBytes = rowSize * height
  const out = Buffer.alloc(54 + pixelBytes)
  out.write('BM', 0, 'ascii')
  out.writeUInt32LE(54 + pixelBytes, 2)
  out.writeUInt32LE(54, 10) // pixel data offset
  out.writeUInt32LE(40, 14) // BITMAPINFOHEADER size
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22) // positive = bottom-up
  out.writeUInt16LE(1, 26) // planes
  out.writeUInt16LE(24, 28) // bpp
  out.writeUInt32LE(0, 30) // BI_RGB
  out.writeUInt32LE(pixelBytes, 34)
  out.writeInt32LE(2835, 38) // 72 dpi
  out.writeInt32LE(2835, 42)

  const grayStride = Math.ceil(width / 8)
  for (let y = 0; y < height; y++) {
    const src = height - 1 - y // bottom-up
    let offset = 54 + y * rowSize
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      if (kind === GRAYSCALE_1BPP) {
        const bit = (data[src * grayStride + (x >> 3)] >> (7 - (x & 7))) & 1
        r = g = b = bit ? 255 : 0
      } else if (kind === RGB_24BPP) {
        const i = (src * width + x) * 3
        r = data[i]
        g = data[i + 1]
        b = data[i + 2]
      } else if (kind === RGBA_32BPP) {
        const i = (src * width + x) * 4
        r = data[i]
        g = data[i + 1]
        b = data[i + 2]
      }
      out[offset++] = b
      out[offset++] = g
      out[offset++] = r
    }
  }
  return out
}

export const OCR_MAX_PDF_PAGES = 10
/** Skip absurdly large embedded images (bytes-in-memory guard). */
const MAX_IMAGE_PIXELS = 25_000_000
/** An unresolved page object never fires its callback — don't hang the IPC. */
const PAGE_OBJECT_TIMEOUT_MS = 15_000

interface HarvestedImage {
  width: number
  height: number
  kind: number
  data: Uint8Array | Uint8ClampedArray
}

function resolvePageObject(page: PdfPageProxy, name: string): Promise<unknown> {
  const store = name.startsWith('g_') ? page.commonObjs : page.objs
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), PAGE_OBJECT_TIMEOUT_MS)
    try {
      store.get(name, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

/** Embedded raster images a page paints, decoded to raw pixel data. */
async function harvestPageImages(page: PdfPageProxy, paintOp: number): Promise<HarvestedImage[]> {
  const ops = await page.getOperatorList()
  const names: string[] = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== paintOp) continue
    const name = ops.argsArray[i]?.[0]
    if (typeof name === 'string' && !names.includes(name)) names.push(name)
  }
  const images: HarvestedImage[] = []
  for (const name of names) {
    const value = (await resolvePageObject(page, name)) as HarvestedImage | null
    if (!value || typeof value !== 'object') continue
    const { width, height, kind, data } = value
    if (!width || !height || !data) continue
    if (kind !== GRAYSCALE_1BPP && kind !== RGB_24BPP && kind !== RGBA_32BPP) continue
    if (width * height > MAX_IMAGE_PIXELS) continue
    images.push({ width, height, kind, data })
  }
  return images
}

/** OCRs a scanned PDF by recognizing its embedded page images. */
export async function ocrPdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await loadPdfjs()
  const paintOp = pdfjs.OPS.paintImageXObject
  const { doc } = await openPdf(bytes)
  let worker: TesseractWorker | null = null
  try {
    const pageTexts: string[] = []
    let imagesFound = 0
    for (let n = 1; n <= Math.min(doc.numPages, OCR_MAX_PDF_PAGES); n++) {
      const page = await doc.getPage(n)
      const images = await harvestPageImages(page, paintOp)
      if (images.length === 0) continue
      imagesFound += images.length
      worker ??= await createOcrWorker()
      const texts: string[] = []
      for (const image of images) {
        const bmp = encodeBmp(image.width, image.height, image.kind, image.data)
        const { data } = await worker.recognize(bmp)
        if (data.text.trim().length > 0) texts.push(data.text.trim())
      }
      if (texts.length > 0) pageTexts.push(`--- page ${n} ---\n\n${texts.join('\n\n')}`)
    }
    if (imagesFound === 0) throw new Error('No page images found to OCR in this PDF')
    // Truncation is noted IN the text (the extractPdfText convention) — but
    // never as the entire payload when nothing was recognized.
    if (doc.numPages > OCR_MAX_PDF_PAGES && pageTexts.length > 0) {
      pageTexts.push(`[OCR truncated: first ${OCR_MAX_PDF_PAGES} of ${doc.numPages} pages]`)
    }
    return pageTexts.join('\n\n')
  } finally {
    if (worker) await worker.terminate()
    await doc.destroy()
  }
}
