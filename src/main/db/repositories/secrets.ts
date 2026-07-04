/**
 * Encrypted secrets attached to a tool owner (migration v4, table
 * `tool_secrets`). Used by custom HTTP tools (secret headers) and MCP servers
 * (secret env vars / headers).
 *
 * The repository stores and returns only ciphertext + a masked preview; it
 * never encrypts or decrypts — that happens in the wiring layer (IPC handlers
 * to store, the executor's secret resolver to read) via `keystore`, matching
 * how `provider_keys` is fed. This keeps the repo free of any Electron
 * dependency so it runs under Vitest.
 */

import type { SqliteDriver } from '../driver'

export type ToolSecretScope = 'custom_tool' | 'mcp_server'

/** A secret's name + preview (never its value). */
export interface ToolSecretRef {
  name: string
  preview: string
  updatedAt: number
}

/** A secret's name + ciphertext, for the resolver that decrypts before use. */
export interface ToolSecretCipher {
  name: string
  encryptedValue: string
}

export interface SecretsRepository {
  /** Names + previews for one owner (safe to send to the renderer). */
  listNames(scope: ToolSecretScope, ownerId: string): ToolSecretRef[]
  /** Ciphertext for every secret of one owner (for main-side decryption). */
  listCiphers(scope: ToolSecretScope, ownerId: string): ToolSecretCipher[]
  /** Upsert one secret. */
  set(
    scope: ToolSecretScope,
    ownerId: string,
    name: string,
    encryptedValue: string,
    preview: string
  ): void
  /** Remove one secret by name. */
  remove(scope: ToolSecretScope, ownerId: string, name: string): void
  /** Remove every secret of an owner (called when the owner is deleted). */
  deleteAllFor(scope: ToolSecretScope, ownerId: string): void
}

interface SecretRow {
  name: string
  encrypted_value: string
  preview: string
  updated_at: number
}

export function createSecretsRepository(driver: SqliteDriver): SecretsRepository {
  return {
    listNames(scope, ownerId) {
      const rows = driver.all<SecretRow>(
        'SELECT name, encrypted_value, preview, updated_at FROM tool_secrets WHERE scope = ? AND owner_id = ? ORDER BY name ASC',
        [scope, ownerId]
      )
      return rows.map((row) => ({
        name: row.name,
        preview: row.preview,
        updatedAt: row.updated_at,
      }))
    },

    listCiphers(scope, ownerId) {
      const rows = driver.all<SecretRow>(
        'SELECT name, encrypted_value, preview, updated_at FROM tool_secrets WHERE scope = ? AND owner_id = ?',
        [scope, ownerId]
      )
      return rows.map((row) => ({ name: row.name, encryptedValue: row.encrypted_value }))
    },

    set(scope, ownerId, name, encryptedValue, preview) {
      driver.run(
        `INSERT INTO tool_secrets (scope, owner_id, name, encrypted_value, preview, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, owner_id, name) DO UPDATE SET
           encrypted_value = excluded.encrypted_value,
           preview = excluded.preview,
           updated_at = excluded.updated_at`,
        [scope, ownerId, name, encryptedValue, preview, Date.now()]
      )
    },

    remove(scope, ownerId, name) {
      driver.run('DELETE FROM tool_secrets WHERE scope = ? AND owner_id = ? AND name = ?', [
        scope,
        ownerId,
        name,
      ])
    },

    deleteAllFor(scope, ownerId) {
      driver.run('DELETE FROM tool_secrets WHERE scope = ? AND owner_id = ?', [scope, ownerId])
    },
  }
}
