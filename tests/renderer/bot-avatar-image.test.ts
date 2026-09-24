import { afterEach, expect, it, vi } from 'vitest'
import { prepareBotAvatar } from '../../src/renderer/src/lib/bot-avatar-image'
import { BOT_AVATAR_MAX_FILE_BYTES } from '../../src/shared/bot-avatar'

afterEach(() => vi.unstubAllGlobals())

it('rejects unsupported and oversized files before decoding', async () => {
  const decode = vi.fn()
  vi.stubGlobal('createImageBitmap', decode)
  await expect(prepareBotAvatar(new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }))).rejects.toThrow('PNG, JPEG or WebP')
  await expect(prepareBotAvatar({ type: 'image/png', size: BOT_AVATAR_MAX_FILE_BYTES + 1 } as File)).rejects.toThrow('10 MB')
  expect(decode).not.toHaveBeenCalled()
})

it('center-crops and re-encodes the image to a small local raster, closing decoded resources', async () => {
  const bitmap = { width: 800, height: 400, close: vi.fn() }
  const drawImage = vi.fn()
  const toDataURL = vi.fn().mockReturnValue('data:image/webp;base64,UklGRg==')
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toDataURL }
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
  vi.stubGlobal('document', { createElement: () => canvas })
  expect(await prepareBotAvatar(new File(['test'], 'image.png', { type: 'image/png' }))).toBe('data:image/webp;base64,UklGRg==')
  expect(drawImage).toHaveBeenCalledWith(bitmap, 200, 0, 400, 400, 0, 0, 256, 256)
  expect(toDataURL).toHaveBeenCalledWith('image/webp', 0.85)
  expect(bitmap.close).toHaveBeenCalledOnce()
})

it('reports corrupt image data without an unhandled decode error', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decoder failed')))
  await expect(prepareBotAvatar(new File(['broken'], 'broken.png', { type: 'image/png' }))).rejects.toThrow('could not be opened')
})
