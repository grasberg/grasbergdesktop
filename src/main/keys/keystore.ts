/**
 * Secure API-key storage built on Electron safeStorage.
 *
 * Keys are encrypted with the OS keychain-backed safeStorage and stored as
 * base64. On systems where safeStorage is unavailable (some Linux setups
 * without a secret service) we fall back to obfuscated-only storage with an
 * 'insecure:' prefix and remember that fact so AppInfo.encryptionAvailable
 * reports it honestly. Key material is never logged and never included in
 * thrown error messages.
 */

import { safeStorage } from 'electron'
import type { AppDatabase } from '../db/database'
import { ProviderError } from '../providers/errors'
import { maskKey } from '../providers/redact'

const INSECURE_PREFIX = 'insecure:'

/** True once we have ever stored or read a key without OS-level encryption. */
let insecureFallbackUsed = false

export interface Keystore {
  encryptionAvailable(): boolean
  encryptKey(plain: string): { encryptedBase64: string; preview: string }
  decryptKey(stored: string): string
  reencryptInsecureKeys(db: AppDatabase): number
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() && !insecureFallbackUsed
}

export function encryptKey(plain: string): { encryptedBase64: string; preview: string } {
  const preview = maskKey(plain)
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const encryptedBase64 = safeStorage.encryptString(plain).toString('base64')
      return { encryptedBase64, preview }
    } catch {
      // Encryption backend failed at runtime — use the insecure fallback below.
    }
  }
  insecureFallbackUsed = true
  const encryptedBase64 = INSECURE_PREFIX + Buffer.from(plain, 'utf8').toString('base64')
  return { encryptedBase64, preview }
}

export function decryptKey(stored: string): string {
  // base64 never contains ':', so the prefix is unambiguous.
  if (stored.startsWith(INSECURE_PREFIX)) {
    insecureFallbackUsed = true
    return Buffer.from(stored.slice(INSECURE_PREFIX.length), 'base64').toString('utf8')
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    throw new ProviderError(
      'auth',
      'The stored API key could not be decrypted — re-enter it in Settings.',
      { retryable: false }
    )
  }
}

/**
 * Upgrades any keys previously stored with the insecure fallback prefix to
 * proper safeStorage encryption, now that OS encryption may be available.
 * Called once at startup. Returns the number of keys upgraded.
 *
 * If OS encryption is still unavailable (or a row cannot be upgraded), the
 * in-session insecure flag is set so encryptionAvailable() reports honestly
 * THIS session. Key material is never logged.
 */
export function reencryptInsecureKeys(db: AppDatabase): number {
  const available = safeStorage.isEncryptionAvailable()
  let upgraded = 0
  let remainingInsecure = 0

  for (const provider of db.providers.list()) {
    const stored = db.providers.getEncryptedKey(provider.id)
    if (!stored || !stored.startsWith(INSECURE_PREFIX)) continue

    if (!available) {
      remainingInsecure += 1
      continue
    }

    let plain: string
    try {
      plain = Buffer.from(stored.slice(INSECURE_PREFIX.length), 'base64').toString('utf8')
    } catch {
      remainingInsecure += 1
      continue
    }

    try {
      const encryptedBase64 = safeStorage.encryptString(plain).toString('base64')
      db.providers.setKeyRow(provider.id, encryptedBase64, maskKey(plain))
      upgraded += 1
    } catch {
      // Encryption backend failed at runtime — leave the insecure row in place.
      remainingInsecure += 1
    }
  }

  if (remainingInsecure > 0) insecureFallbackUsed = true
  return upgraded
}

export const keystore: Keystore = {
  encryptionAvailable,
  encryptKey,
  decryptKey,
  reencryptInsecureKeys,
}
