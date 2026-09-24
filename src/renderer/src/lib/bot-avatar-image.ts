import { BOT_AVATAR_MAX_FILE_BYTES, BOT_AVATAR_SIZE, isBotAvatarImage } from '@shared/bot-avatar'

/** Decode and re-encode locally: strip metadata and keep the saved avatar small. */
export async function prepareBotAvatar(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG or WebP image.')
  }
  if (file.size > BOT_AVATAR_MAX_FILE_BYTES) throw new Error('Choose an image smaller than 10 MB.')
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(file) }
  catch { throw new Error('This image could not be opened. Try another PNG, JPEG or WebP file.') }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = BOT_AVATAR_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not prepare the profile image.')
    const side = Math.min(bitmap.width, bitmap.height)
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
      0, 0, BOT_AVATAR_SIZE, BOT_AVATAR_SIZE)
    const dataUrl = canvas.toDataURL('image/webp', 0.85)
    if (!isBotAvatarImage(dataUrl)) throw new Error('This image is too large. Try a smaller image.')
    return dataUrl
  } finally { bitmap.close() }
}
