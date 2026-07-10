/** Human-readable byte size: `512 B`, `1.5 KB`, `2.0 MB`. `kbDecimals` covers
 * the file-tree variant that renders whole kilobytes (`toFixed(0)`). */
export function formatBytes(bytes: number, kbDecimals = 1): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(kbDecimals)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Pretty-prints the model-produced argument JSON; falls back to the raw string. */
export function prettyJson(raw: string): string {
  if (!raw.trim()) return '{}'
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** Compact "how long ago": now, 5m, 3h, 2d, then a locale date. */
export function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(ts).toLocaleDateString()
}
