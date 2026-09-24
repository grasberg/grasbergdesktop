import { expect, it } from 'vitest'
import { botAvatarSchema } from '../../src/shared/schemas'
import { BOT_AVATAR_MAX_DATA_URL_LENGTH } from '../../src/shared/bot-avatar'

it('accepts local raster avatars and compound emoji while retaining the image field', () => {
  const avatar = { emoji: '👩🏽‍💻', imageDataUrl: 'data:image/webp;base64,UklGRg==' }
  expect(botAvatarSchema.parse(avatar)).toEqual(avatar)
  expect(botAvatarSchema.parse({ imageDataUrl: null })).toEqual({ imageDataUrl: null })
})

it.each([
  'https://example.test/tracking.png', 'file:///private/photo.png',
  'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGh0bWw+',
  'data:image/png;base64,not base64!',
  'data:image/png;base64,' + 'A'.repeat(BOT_AVATAR_MAX_DATA_URL_LENGTH),
])('rejects unsafe or oversized avatar data (case %#)', (imageDataUrl) => {
  expect(botAvatarSchema.safeParse({ imageDataUrl }).success).toBe(false)
})
