/**
 * Wire protocol for remote access: the phone tunnel through the relay.
 *
 * Three parties see three different slices:
 *
 * - The RELAY (hosted, untrusted for content) sees the frames in the first
 *   section only: hello/auth, routing envelopes, HTTP asset tunneling. After
 *   pairing, every application frame between desktop and phone is an opaque
 *   `{t:'sec', n, ct}` AES-256-GCM ciphertext — the relay routes bytes, it
 *   cannot read conversations, tool arguments or approvals.
 * - DESKTOP and PHONE additionally share the inner frames (second section),
 *   sealed under a key derived from the pairing secret (HKDF-SHA256). The
 *   pairing secret itself travels exactly once — inside the QR code the user
 *   scans — and is never sent over any connection. The phone proves knowledge
 *   with an HMAC; the desktop answers the new device's token sealed with the
 *   derived key, which doubles as a key-agreement check.
 *
 * Channel-shaped frames (`req`) reuse the renderer IPC contract verbatim:
 * same `CHANNELS` names, same payload shapes, same `IpcResult` replies — the
 * remote router runs the very same handlers the desktop window invokes.
 */

import type { IpcResult } from './ipc'

export const REMOTE_PROTOCOL_VERSION = 1

/** HMAC context string for the pairing proof (domain separation). */
export const PAIRING_PROOF_CONTEXT = 'grasberg-remote-pairing-v1'
/** HKDF info string for the frame key. */
export const FRAME_KEY_INFO = 'grasberg-remote-frame-v1'
/** HKDF salt — fixed, public; the secret is the pairing code's entropy. */
export const FRAME_KEY_SALT = 'grasberg-remote-frame-salt-v1'

// ---------------------------------------------------------------------------
// Relay-visible frames
// ---------------------------------------------------------------------------

/** Desktop tunnel connection (outbound from the desktop). */
export interface RelayHelloDesktop {
  v: number
  t: 'hello'
  role: 'desktop'
  desktopId: string
  token: string
}

/** Already-paired device connection. */
export interface RelayHelloDevice {
  v: number
  t: 'hello'
  role: 'device'
  desktopId: string
  deviceId: string
  token: string
}

/** Unauthenticated connection that wants to pair (proof comes inner). */
export interface RelayHelloPairing {
  v: number
  t: 'hello'
  role: 'pairing'
  desktopId: string
}

export type RelayHello = RelayHelloDesktop | RelayHelloDevice | RelayHelloPairing

export interface RelayWelcome {
  t: 'welcome'
  ok: boolean
  message?: string
}

/** Desktop → relay: route this frame to one device. */
export interface RelayToDevice {
  t: 'to'
  deviceId: string
  frame: unknown
}

/** Desktop → relay: reply to an unauthenticated pairing connection. */
export interface RelayToPairConn {
  t: 'to-pair'
  connId: string
  frame: unknown
}

/** Device → relay: route this frame to the desktop. */
export interface RelayToDesktop {
  t: 'to'
  frame: unknown
}

/**
 * Relay → desktop: a frame from a device. `deviceId` is null while the sender
 * is an unauthenticated pairing connection; `from` is the relay connection id
 * — the return address a pairing reply must use (RelayToPairConn).
 */
export interface RelayFromDevice {
  t: 'from'
  deviceId: string | null
  from: string
  frame: unknown
}

/** Relay → device: a frame from the desktop. */
export interface RelayFromDesktop {
  t: 'from'
  frame: unknown
}

/** Desktop → relay: register a newly paired device's token hash. */
export interface RelayDeviceAdd {
  t: 'device-add'
  deviceId: string
  tokenHash: string
}

/** Desktop → relay: a device was revoked — drop its connections. */
export interface RelayDeviceRemove {
  t: 'device-remove'
  deviceId: string
}

/** Relay → device: whether the desktop tunnel is up. */
export interface RelayPresence {
  t: 'presence'
  desktop: 'online' | 'offline'
}

/** Relay → desktop: a paired device's tunnel connection came or went. */
export interface RelayDevicePresence {
  t: 'device-online' | 'device-offline'
  deviceId: string
}

/**
 * Relay → desktop, sent right after a desktop's welcome: every device of this
 * desktop that is connected RIGHT NOW. A desktop tunnel flap must not silence
 * pushes — the phones stay connected at the relay while the desktop is away,
 * so on reconnect the desktop rebuilds its online set from this list instead
 * of waiting for the phones to reconnect (which they have no reason to do).
 */
export interface RelayDevicesOnline {
  t: 'devices-online'
  deviceIds: string[]
}

/** Relay → desktop: serve this path from the mobile bundle (asset tunnel). */
export interface RelayHttpReq {
  t: 'http'
  reqId: string
  method: string
  path: string
}

/** Desktop → relay: the asset response (body base64). */
export interface RelayHttpRes {
  t: 'http-res'
  reqId: string
  status: number
  contentType: string
  etag: string | null
  body: string
}

export interface RelayPing {
  t: 'ping'
}
export interface RelayPong {
  t: 'pong'
}

// ---------------------------------------------------------------------------
// End-to-end frames (desktop ↔ device)
// ---------------------------------------------------------------------------

/** AES-256-GCM sealed application frame. `n` is the base64 12-byte nonce. */
export interface SealedFrame {
  t: 'sec'
  n: string
  ct: string
}

/** Pairing request, sent unsealed over the `pairing` role connection. */
export interface PairRequest {
  t: 'pair'
  /** HMAC-SHA256(pairingSecret, PAIRING_PROOF_CONTEXT), hex. Never the secret. */
  proof: string
  name: string
  platform: string
}

/** Sent SEALED with the derived frame key: new identity + relay auth token. */
export interface PairPaired {
  t: 'paired'
  deviceId: string
  token: string
  /** Human-readable desktop label, for the phone's device list. */
  desktopName: string
}

export interface PairError {
  t: 'pair-error'
  reason: string
}

/** Phone session handshake, sealed. */
export interface InnerHello {
  t: 'hello'
}

export interface InnerHelloRes {
  t: 'hello-res'
  app: { name: string; version: string }
}

/** A request shaped exactly like a renderer ipcRenderer.invoke. */
export interface InnerReq {
  t: 'req'
  id: string
  channel: string
  args: unknown[]
}

export interface InnerRes {
  t: 'res'
  id: string
  result: IpcResult<unknown>
}

/** A pushed event, same channel + payload the desktop renderer receives. */
export interface InnerPush {
  t: 'push'
  channel: string
  payload: unknown
}

export type RemoteInnerFrame =
  | InnerHello
  | InnerHelloRes
  | InnerReq
  | InnerRes
  | InnerPush
  | PairPaired
  | PairError
