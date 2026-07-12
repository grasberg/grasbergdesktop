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
]

/**
 * Long base64 / base64url runs. '-' is excluded from the run so hyphenated
 * identifiers (model ids like 'deepseek-reasoner', 'MiniMax-Text-01') are never
 * matched. The "must contain a digit" condition is applied in the replacer, not
 * as a lookahead: a lookahead re-scans the run at every start position, which is
 * quadratic on the long digit-free runs shell output can carry.
 */
const BASE64_RUN = /[A-Za-z0-9+/_]{32,}={0,3}/g
const HAS_DIGIT = /[0-9]/

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
  return out.replace(BASE64_RUN, (run) => (HAS_DIGIT.test(run) ? REDACTED : run))
}

/**
 * Non-reversible preview of an API key for the Settings UI, e.g. "sk-…4f2a".
 * Never discloses more than a third of the characters: the recognizable prefix
 * (letters followed by '-' or '_') and the last 4 chars are only shown when the
 * key is long enough to afford them; short keys show just '…' + last 2.
 */
export function maskKey(key: string): string {
  const k = key.trim()
  if (k.length === 0) return ''
  if (k.length < 8) return `…${k.slice(-2)}`
  const budget = Math.floor(k.length / 3)
  const suffix = k.slice(-Math.min(4, budget))
  const hasPrefix = budget >= 6 && /^[A-Za-z]{1,6}[-_]/.test(k)
  return `${hasPrefix ? k.slice(0, 3) : ''}…${suffix}`
}
