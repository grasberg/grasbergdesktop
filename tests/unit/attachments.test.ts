import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES, readAttachment, readStoredImage } from '../../src/main/ipc/attachments'

let dir: string
let imageDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-attach-'))
  imageDir = join(dir, 'attachments')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readAttachment — images', () => {
  it('stores a PNG as an image attachment with a data URL and storageKey', async () => {
    const src = join(dir, 'pic.png')
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))

    const att = await readAttachment(src, imageDir)
    expect(att?.kind).toBe('image')
    expect(att?.mimeType).toBe('image/png')
    expect(att?.storageKey).toMatch(/\.png$/)
    expect(att?.dataUrl?.startsWith('data:image/png;base64,')).toBe(true)
    expect(existsSync(join(imageDir, att!.storageKey!))).toBe(true)

    // readStoredImage round-trips the same bytes.
    const read = await readStoredImage(imageDir, att!.storageKey!)
    expect(read?.dataUrl).toBe(att!.dataUrl)
  })

  it('keeps SVG on the text path (not sent as an image_url)', async () => {
    const src = join(dir, 'icon.svg')
    writeFileSync(src, '<svg></svg>')
    const att = await readAttachment(src, imageDir)
    expect(att?.kind).toBeUndefined()
    expect(att?.textContent).toContain('<svg>')
  })

  it('an oversized image keeps metadata only', async () => {
    const src = join(dir, 'big.png')
    writeFileSync(src, Buffer.alloc(MAX_IMAGE_BYTES + 1))
    const att = await readAttachment(src, imageDir)
    expect(att?.kind).toBeUndefined()
    expect(att?.storageKey).toBeUndefined()
  })

  it('without an imageDir, images are metadata-only', async () => {
    const src = join(dir, 'pic.png')
    writeFileSync(src, Buffer.from([1, 2, 3]))
    const att = await readAttachment(src)
    expect(att?.kind).toBeUndefined()
  })
})

describe('readStoredImage', () => {
  it('rejects traversal and non-image keys', async () => {
    expect(await readStoredImage(imageDir, '../secret.png')).toBeNull()
    expect(await readStoredImage(imageDir, 'a/b.png')).toBeNull()
    expect(await readStoredImage(imageDir, 'notes.txt')).toBeNull()
    expect(await readStoredImage(imageDir, 'missing.png')).toBeNull()
  })
})
