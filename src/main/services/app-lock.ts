/**
 * App lock: an optional passphrase that locks the renderer behind a full-window
 * lock screen — on launch and after configurable idle. While locked, the IPC
 * gate in register.ts refuses every channel except lock:status/lock:unlock and
 * the window push forwarder drops everything but push:appLockChanged.
 *
 * A privacy screen, NOT encryption at rest: the SQLite file stays readable on
 * disk, and the phone tunnel (its own 256-bit pairing auth) keeps working — a
 * locked desktop is exactly when remote access is needed.
 *
 * Deliberately Electron-free (the notify.ts pattern): idle time arrives as an
 * injected getIdleSeconds so every rule here is unit-testable in plain Node.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { CHANNELS } from '@shared/ipc'
import type { AppLockHash, AppLockSetPassphraseInput, AppLockStatus } from '@shared/types'
import type { SettingsRepository } from '../db/repositories/settings'
import { ProviderError } from '../providers/errors'

/** Interactive-login scrypt cost (per OWASP); stored per hash so it can be raised later. */
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LEN = 32
const SALT_BYTES = 16

/** Brute-force damper: this many consecutive failures refuse attempts for the window. */
const MAX_FAILURES = 5
const FAILURE_WINDOW_MS = 30_000

const IDLE_CHECK_INTERVAL_MS = 30_000

export function hashPassphrase(passphrase: string): AppLockHash {
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(passphrase, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return {
    algo: 'scrypt',
    saltBase64: salt.toString('base64'),
    hashBase64: hash.toString('base64'),
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keyLen: SCRYPT_KEY_LEN,
  }
}

/** Verifies against the STORED params, so old hashes survive future cost bumps. */
export function verifyPassphrase(passphrase: string, stored: AppLockHash): boolean {
  try {
    const expected = Buffer.from(stored.hashBase64, 'base64')
    const actual = scryptSync(passphrase, Buffer.from(stored.saltBase64, 'base64'), stored.keyLen, {
      N: stored.n,
      r: stored.r,
      p: stored.p,
    })
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/**
 * Whether one push may reach a renderer window right now. Only the lock-state
 * change itself passes while locked — everything else (stream text, approval
 * requests, run results) is content the lock screen must not leak.
 */
export function windowPushAllowed(locked: boolean, channel: string): boolean {
  return !locked || channel === CHANNELS.appLockChanged
}

export interface AppLockServiceDeps {
  settings: Pick<SettingsRepository, 'get' | 'update'>
  /** Publishes push:appLockChanged to every window. */
  broadcast: (channel: string, payload: unknown) => void
  /** powerMonitor.getSystemIdleTime in production; injected for tests. */
  getIdleSeconds?: () => number
  now?: () => number
}

export class AppLockService {
  private locked: boolean
  private failures = 0
  private lastFailureAt = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: AppLockServiceDeps) {
    // Lock on launch whenever a passphrase is configured.
    this.locked = deps.settings.get().appLockHash !== null
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  isLocked(): boolean {
    return this.locked
  }

  status(): AppLockStatus {
    const settings = this.deps.settings.get()
    return {
      configured: settings.appLockHash !== null,
      locked: this.locked,
      idleMinutes: settings.appLockIdleMinutes,
    }
  }

  lock(): void {
    if (this.locked) return
    this.locked = true
    this.deps.broadcast(CHANNELS.appLockChanged, { locked: true })
  }

  unlock(passphrase: string): AppLockStatus {
    const stored = this.deps.settings.get().appLockHash
    if (!stored) {
      throw new ProviderError('invalid_request', 'No passphrase is set.')
    }
    if (this.failures >= MAX_FAILURES && this.now() - this.lastFailureAt < FAILURE_WINDOW_MS) {
      throw new ProviderError('auth', 'Too many attempts — wait 30 seconds.', {
        retryable: false,
      })
    }
    if (!verifyPassphrase(passphrase, stored)) {
      this.failures = this.failures >= MAX_FAILURES ? 1 : this.failures + 1
      this.lastFailureAt = this.now()
      throw new ProviderError('auth', 'Wrong passphrase.', { retryable: false })
    }
    this.failures = 0
    if (this.locked) {
      this.locked = false
      this.deps.broadcast(CHANNELS.appLockChanged, { locked: false })
    }
    return this.status()
  }

  /**
   * Set/change/remove the passphrase. Only reachable while unlocked (the IPC
   * gate guarantees it); changing or removing still requires the current one.
   */
  setPassphrase(input: AppLockSetPassphraseInput): AppLockStatus {
    const stored = this.deps.settings.get().appLockHash
    if (stored) {
      if (!input.current || !verifyPassphrase(input.current, stored)) {
        throw new ProviderError('auth', 'The current passphrase is wrong.', { retryable: false })
      }
    }
    this.deps.settings.update({
      appLockHash: input.next === null ? null : hashPassphrase(input.next),
    })
    return this.status()
  }

  /** Auto-lock when the system has idled past the configured threshold. */
  checkIdle(): void {
    if (this.locked) return
    const settings = this.deps.settings.get()
    if (settings.appLockHash === null || settings.appLockIdleMinutes === null) return
    const idleSeconds = this.deps.getIdleSeconds?.()
    if (idleSeconds !== undefined && idleSeconds >= settings.appLockIdleMinutes * 60) {
      this.lock()
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
