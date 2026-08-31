/**
 * Generates cross-implementation test vectors for the Flutter phone client.
 *
 * Run once with: `node tool/gen-interop-vectors.mjs` (from mobile_flutter/).
 * The vectors mirror src/mobile/crypto.ts exactly (WebCrypto semantics — the
 * same code the desktop-hosted phone web client runs), so the Dart test in
 * test/interop_test.dart proves wire-level interop with the desktop's
 * protocol, not just Dart-internal consistency.
 *
 * Output: test/fixtures/interop.json (committed; deterministic given the
 * fixed secret below — 43 chars, same shape the desktop's QR secret uses).
 */

const subtle = crypto.subtle

const PAIRING_PROOF_CONTEXT = 'grasberg-remote-pairing-v1'
const FRAME_KEY_INFO = 'grasberg-remote-frame-v1'
const FRAME_KEY_SALT = 'grasberg-remote-frame-salt-v1'

// 43 chars of base64url alphabet — exactly what the desktop's PairingGuard
// mints (32 random bytes, base64url, no padding).
const SECRET = 'GrasbergTestSecret' + '0'.repeat(43 - 18)
if (!/^[A-Za-z0-9_-]{43}$/.test(SECRET)) throw new Error('bad fixture secret shape')

const enc = new TextEncoder()

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const toB64 = (bytes) => Buffer.from(bytes).toString('base64')
const bytes = (ab) => new Uint8Array(ab)

async function hmacHex(secret, context) {
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(bytes(await subtle.sign('HMAC', key, enc.encode(context))))
}

async function hkdfKeyBase64(secret) {
  const material = await subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(FRAME_KEY_SALT), info: enc.encode(FRAME_KEY_INFO) },
    material,
    256
  )
  return toB64(bytes(bits))
}

async function importAesKey(rawB64) {
  return subtle.importKey('raw', Buffer.from(rawB64, 'base64'), 'AES-GCM', false, ['encrypt'])
}

async function seal(rawB64, payload) {
  const key = await importAesKey(rawB64)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, enc.encode(JSON.stringify(payload)))
  return { t: 'sec', n: toB64(nonce), ct: toB64(new Uint8Array(cipher)) }
}

const proof = await hmacHex(SECRET, PAIRING_PROOF_CONTEXT)
const keyBase64 = await hkdfKeyBase64(SECRET)

const frames = {
  hello: await seal(keyBase64, { t: 'hello' }),
  paired: await seal(keyBase64, {
    t: 'paired',
    deviceId: '11111111-2222-4333-8444-555555555555',
    token: 'relay-token-abc123',
    desktopName: 'Test Desktop',
  }),
  req: await seal(keyBase64, {
    t: 'req',
    id: 'req-0001',
    seq: 1,
    channel: 'conv:list',
    args: [{}],
  }),
  push: await seal(keyBase64, {
    t: 'push',
    channel: 'push:conversationsChanged',
    payload: { conversationId: 'conv-1' },
  }),
  helloRes: await seal(keyBase64, {
    t: 'hello-res',
    app: { name: 'Grasberg', version: '1.2.3' },
  }),
}

// A hand-crafted QR payload in exactly the shape the desktop's RemoteService
// builds (client URL + fragment with p / relay / desktop).
const pairingQr = `https://phone.grasberg.example/app#p=${encodeURIComponent(SECRET)}` +
  `&relay=${encodeURIComponent('https://relay.example.com:7333')}&desktop=0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d`

const fixture = {
  secret: SECRET,
  proofHex: proof,
  frameKeyBase64: keyBase64,
  sealedFrames: frames,
  pairingQr,
  expected: {
    deviceId: '11111111-2222-4333-8444-555555555555',
    desktopId: '0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d',
    relayUrl: 'https://relay.example.com:7333',
    relayWsUrl: 'wss://relay.example.com:7333/ws',
  },
}

import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// --verify mode: open frames sealed by the Dart implementation (the reverse
// direction of the fixture) — proves wire interop in both directions.
if (process.argv.includes('--verify')) {
  const file = process.argv[process.argv.indexOf('--verify') + 1]
  const check = JSON.parse(readFileSync(file, 'utf8'))
  const rawKey = Buffer.from(check.keyBase64 ?? keyBase64, 'base64')
  const aes = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt'])
  let opened = 0
  for (let i = 0; i < check.sealed.length; i++) {
    const frame = check.sealed[i]
    const nonce = Buffer.from(frame.n, 'base64')
    // WebCrypto's layout, same as the desktop protocol: tag appended last.
    const ctAndTag = Buffer.from(frame.ct, 'base64')
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      aes,
      ctAndTag,
    )
    const payload = JSON.parse(new TextDecoder().decode(plain))
    const same = JSON.stringify(payload) === JSON.stringify(check.payloads[i])
    console.log(`frame ${i}: opened=${true} payloadMatches=${same}`, payload)
    if (!same) process.exit(1)
    opened++
  }
  console.log(`verify OK: ${opened}/${check.sealed.length} Dart-sealed frames opened by WebCrypto`)
  process.exit(0)
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'interop.json')
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n')
console.log(`wrote ${out}`)
console.log(`proof: ${proof.slice(0, 16)}…  key: ${keyBase64.slice(0, 12)}…`)
