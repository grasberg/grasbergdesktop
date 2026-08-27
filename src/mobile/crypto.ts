/**
 * Phone-side cryptography — the WebCrypto mirror of src/main/remote/crypto.ts.
 *
 * Same constants from @shared/remote-protocol, same wire format, so the two
 * sides interoperate by construction: the pairing secret from the QR derives
 * the HKDF frame key; every application frame is AES-256-GCM sealed. The
 * secret itself is read from the URL fragment exactly once and cleared, never
 * stored, never sent.
 */

import {
  FRAME_KEY_INFO,
  FRAME_KEY_SALT,
  PAIRING_PROOF_CONTEXT,
  type SealedFrame,
} from '@shared/remote-protocol'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Bytes with a plain ArrayBuffer backing — what WebCrypto accepts everywhere. */
type Bytes = Uint8Array<ArrayBuffer>

const bytes = (length: number): Bytes => new Uint8Array(new ArrayBuffer(length))

const toHex = (data: Uint8Array): string =>
  [...data].map((b) => b.toString(16).padStart(2, '0')).join('')

const toBase64 = (data: Uint8Array): string => {
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const fromBase64 = (text: string): Bytes => {
  const binary = atob(text)
  const out = bytes(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** HMAC-SHA256(secret, PAIRING_PROOF_CONTEXT) as hex — the pairing proof. */
export async function pairingProof(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(PAIRING_PROOF_CONTEXT))
  return toHex(new Uint8Array(mac))
}

/** HKDF-SHA256(secret) → 256-bit AES-GCM frame key (raw bytes, base64-storable). */
export async function deriveFrameKey(secret: string): Promise<Bytes> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(FRAME_KEY_SALT),
      info: encoder.encode(FRAME_KEY_INFO),
    },
    material,
    256
  )
  return new Uint8Array(bits)
}

const importAesKey = (raw: Bytes): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])

/** Raw-key ⇄ base64 (identity storage in localStorage). */
export const keyToBase64 = (key: Bytes): string => toBase64(key)
export const keyFromBase64 = (text: string): Bytes => fromBase64(text)

/** Seals one JSON-serializable frame: AES-256-GCM with a fresh 12-byte nonce. */
export async function sealFrame(key: Bytes, payload: unknown): Promise<SealedFrame> {
  const nonce = crypto.getRandomValues(bytes(12))
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    await importAesKey(key),
    encoder.encode(JSON.stringify(payload))
  )
  return { t: 'sec', n: toBase64(nonce), ct: toBase64(new Uint8Array(cipher)) }
}

/** Opens one sealed frame; throws on tampering or a wrong key. */
export async function openFrame<T>(key: Bytes, frame: SealedFrame): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(frame.n) },
    await importAesKey(key),
    fromBase64(frame.ct)
  )
  return JSON.parse(decoder.decode(plain)) as T
}
