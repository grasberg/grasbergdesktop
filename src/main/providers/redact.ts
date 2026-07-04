/**
 * Secret redaction helpers. Every provider-sourced string that can end up in
 * an error message, log line or the renderer must pass through redactSecrets.
 */

const REDACTED = '[redacted]'

/** Minimum length for a caller-provided secret to be worth replacing. */
const MIN_SECRET_LENGTH = 4

const GENERIC_PATTERNS: RegExp[] = [
  // Authorization header style tokens ("Bearer xxxxx").
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // OpenAI-style keys.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // Long hex runs (hashes, hex-encoded keys).
  /\b[0-9a-fA-F]{32,}\b/g,
  // Long base64 / base64url runs. Requires at least one digit and excludes
  // '-' from the run so hyphenated identifiers (model ids like
  // 'deepseek-reasoner', 'MiniMax-Text-01') are never matched.
  /(?=[A-Za-z0-9+/_]*[0-9])[A-Za-z0-9+/_]{32,}={0,3}/g,
]

/**
 * Replaces ONLY the provided secret values with '[redacted]' — no generic
 * token heuristics. Use this on SUCCESS results (e.g. custom-tool responses)
 * where legitimate hashes/ids must survive intact. Safe to apply repeatedly.
 */
export function redactKnownSecrets(text: string, secrets: string[] = []): string {
  let out = text
  // Longest secrets first so overlapping/nested values are fully removed.
  const known = secrets
    .filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  for (const secret of known) {
    out = out.split(secret).join(REDACTED)
  }
  return out
}

/**
 * Replaces any occurrence of the provided secrets AND of generic token-looking
 * patterns with '[redacted]'. Use on error/exception strings where aggressive
 * redaction is worth the occasional false positive. Safe to apply repeatedly.
 */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = redactKnownSecrets(text, secrets)
  for (const pattern of GENERIC_PATTERNS) {
    out = out.replace(pattern, REDACTED)
  }
  return out
}

/**
 * Non-reversible preview of an API key for the Settings UI, e.g. "sk-…4f2a".
 * Keeps the first 3 chars only when the key has a recognizable prefix
 * (letters followed by '-' or '_'); short keys show just '…' + last 2.
 */
export function maskKey(key: string): string {
  const k = key.trim()
  if (k.length === 0) return ''
  if (k.length < 8) return `…${k.slice(-2)}`
  const hasPrefix = /^[A-Za-z]{1,6}[-_]/.test(k)
  const prefix = hasPrefix ? k.slice(0, 3) : ''
  return `${prefix}…${k.slice(-4)}`
}
