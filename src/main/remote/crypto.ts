/**
 * Desktop-side cryptography for the phone tunnel.
 *
 * One secret — minted per pairing offer, shown as a QR code, never stored —
 * bootstraps everything:
 *
 *   proof    = HMAC-SHA256(secret, PAIRING_PROOF_CONTEXT)   (phone → desktop)
 *   frameKey = HKDF-SHA256(secret, FRAME_KEY_SALT/INFO, 32) (both sides)
 *
 * The proof lets the desktop verify the phone without the secret crossing the
 * wire; the frame key then seals every application frame AES-256-GCM, so the
 * relay (and anyone watching it) sees ciphertext only. The phone mirrors this
 * module with WebCrypto (see src/mobile) — same constants from
 * @shared/remote-protocol, same wire format.
 */

import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto'
import {
  FRAME_KEY_INFO,
  FRAME_KEY_SALT,
  PAIRING_PROOF_CONTEXT,
  type SealedFrame,
} from '@shared/remote-protocol'

/** A fresh 256-bit pairing secret, base64url (43 chars — QR-friendly). */
export function generatePairingSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** A fresh device/relay access token, 64 hex chars. */
export function generateAccessToken(): string {
  return randomBytes(32).toString('hex')
}

/** The proof a phone must present for a given pairing secret (hex). */
export function pairingProof(secret: string): string {
  return createHmac('sha256', secret).update(PAIRING_PROOF_CONTEXT).digest('hex')
}

/** Constant-time proof comparison; wrong-length input is simply false. */
export function proofMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  if (a.length !== b.length) {
    // Consume a comparison anyway so timing does not leak the length.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

/** Derives the 256-bit frame key from the pairing secret. */
export function deriveFrameKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, FRAME_KEY_SALT, FRAME_KEY_INFO, 32)
  )
}

/** SHA-256 of a token, hex — the only form stored for auth comparison. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Short hex fingerprint of a frame key (shown in the device list). */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** Seals one JSON-serializable payload as an AES-256-GCM frame. */
export function sealFrame(key: Buffer, payload: unknown): SealedFrame {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return { t: 'sec', n: nonce.toString('base64'), ct: ct.toString('base64') }
}

/**
 * Opens one sealed frame. Throws on any tampering, wrong key or bad JSON —
 * callers treat a throw as "drop the frame / kill the session", never as data.
 */
export function openFrame<T>(key: Buffer, frame: SealedFrame): T {
  const nonce = Buffer.from(frame.n, 'base64')
  const blob = Buffer.from(frame.ct, 'base64')
  if (nonce.length !== 12 || blob.length < 16) throw new Error('Malformed frame.')
  const tag = blob.subarray(blob.length - 16)
  const body = blob.subarray(0, blob.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as T
}
