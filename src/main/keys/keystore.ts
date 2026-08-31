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
import type { ToolSecretScope } from '../db/repositories/secrets'
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

type StorageBackendProbe = Pick<
  typeof safeStorage,
  'isEncryptionAvailable' | 'getSelectedStorageBackend'
>

/** Availability alone is misleading on Linux: basic_text uses a fixed password. */
export function hasSecureStorageBackend(
  storage: StorageBackendProbe = safeStorage,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!storage.isEncryptionAvailable()) return false
  if (platform !== 'linux') return true
  try {
    const backend = storage.getSelectedStorageBackend()
    return backend !== 'basic_text' && backend !== 'unknown'
  } catch {
    return false
  }
}

export function encryptionAvailable(): boolean {
  return hasSecureStorageBackend() && !insecureFallbackUsed
}

export function encryptKey(plain: string): { encryptedBase64: string; preview: string } {
  const preview = maskKey(plain)
  if (hasSecureStorageBackend()) {
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

/** One insecure secret row of `tool_secrets` (see the secrets repository). */
interface InsecureSecretRow {
  scope: ToolSecretScope
  owner_id: string
  name: string
  encrypted_value: string
}

/**
 * Upgrades any secrets previously stored with the insecure fallback prefix to
 * proper safeStorage encryption, now that OS encryption may be available. This
 * covers EVERY store that holds keystore ciphertext — provider keys, OAuth
 * tokens, and the tool_secrets rows behind MCP headers, IM bot tokens and
 * custom-tool secret headers — so nothing is left behind in the weaker form.
 * Called once at startup. Returns the number of secrets upgraded.
 *
 * If OS encryption is still unavailable (or a row cannot be upgraded), the
 * in-session insecure flag is set so encryptionAvailable() reports honestly
 * THIS session. Key material is never logged.
 */
export function reencryptInsecureKeys(db: AppDatabase): number {
  const available = hasSecureStorageBackend()
  let upgraded = 0
  let remainingInsecure = 0

  /** Re-encrypts one insecure value; null when it has to stay as it is. */
  const upgrade = (stored: string): { encryptedBase64: string; plain: string } | null => {
    if (!available) return null
    let plain: string
    try {
      plain = Buffer.from(stored.slice(INSECURE_PREFIX.length), 'base64').toString('utf8')
    } catch {
      return null
    }
    try {
      return { encryptedBase64: safeStorage.encryptString(plain).toString('base64'), plain }
    } catch {
      // Encryption backend failed at runtime — leave the insecure row in place.
      return null
    }
  }

  for (const provider of db.providers.list()) {
    const stored = db.providers.getEncryptedKey(provider.id)
    if (stored?.startsWith(INSECURE_PREFIX)) {
      const next = upgrade(stored)
      if (next) {
        db.providers.setKeyRow(provider.id, next.encryptedBase64, maskKey(next.plain))
        upgraded += 1
      } else {
        remainingInsecure += 1
      }
    }

    const oauth = db.providers.getOAuthRow(provider.id)
    if (oauth) {
      const access = oauth.encryptedAccess.startsWith(INSECURE_PREFIX)
        ? upgrade(oauth.encryptedAccess)
        : null
      const refresh = oauth.encryptedRefresh?.startsWith(INSECURE_PREFIX)
        ? upgrade(oauth.encryptedRefresh)
        : null
      if (access || refresh) {
        db.providers.setOAuthRow({
          ...oauth,
          encryptedAccess: access?.encryptedBase64 ?? oauth.encryptedAccess,
          encryptedRefresh: refresh?.encryptedBase64 ?? oauth.encryptedRefresh,
        })
        upgraded += (access ? 1 : 0) + (refresh ? 1 : 0)
      }
      if (oauth.encryptedAccess.startsWith(INSECURE_PREFIX) && !access) remainingInsecure += 1
      if (oauth.encryptedRefresh?.startsWith(INSECURE_PREFIX) && !refresh) remainingInsecure += 1
    }
  }

  const insecureSecrets = db.driver.all<InsecureSecretRow>(
    `SELECT scope, owner_id, name, encrypted_value FROM tool_secrets WHERE encrypted_value LIKE ?`,
    [`${INSECURE_PREFIX}%`]
  )
  for (const row of insecureSecrets) {
    const next = upgrade(row.encrypted_value)
    if (!next) {
      remainingInsecure += 1
      continue
    }
    db.secrets.set(row.scope, row.owner_id, row.name, next.encryptedBase64, maskKey(next.plain))
    upgraded += 1
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
