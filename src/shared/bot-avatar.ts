/** Small, embedded raster avatars travel with exported bot profiles. Never load remote URLs or SVG. */
export const BOT_AVATAR_MAX_DATA_URL_LENGTH = 200_000
export const BOT_AVATAR_MAX_FILE_BYTES = 10 * 1024 * 1024
export const BOT_AVATAR_SIZE = 256

export function isBotAvatarImage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= BOT_AVATAR_MAX_DATA_URL_LENGTH &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
}
