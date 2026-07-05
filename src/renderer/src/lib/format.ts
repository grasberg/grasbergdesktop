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
