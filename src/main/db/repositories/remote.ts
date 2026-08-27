/**
 * Paired remote devices (migration v38, table `remote_devices`): the phones
 * allowed to use the app through the relay tunnel.
 *
 * Only a SHA-256 hash of each device's access token is stored — the plaintext
 * leaves the machine exactly once, end-to-end encrypted, at pairing time. The
 * per-device frame key lives in `tool_secrets` (encrypted), never here.
 * Revocation stamps revoked_at; rows are kept so Settings can show history.
 */

import { randomUUID } from 'node:crypto'
import type { RemoteDevice } from '@shared/types'
import type { SqliteDriver } from '../driver'

interface DeviceRow {
  id: string
  name: string
  token_hash: string
  key_fingerprint: string
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
}

function toDevice(row: DeviceRow): RemoteDevice {
  return {
    id: row.id,
    name: row.name,
    keyFingerprint: row.key_fingerprint,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    online: false,
  }
}

export interface RemoteDevicesRepository {
  /** Inserts a newly paired device. */
  create(input: {
    name: string
    tokenHash: string
    keyFingerprint: string
  }): RemoteDevice
  list(): RemoteDevice[]
  /** Active (non-revoked) devices only, oldest first. */
  listActive(): RemoteDevice[]
  /**
   * Active devices' ids + token hashes — for re-upserting registrations on
   * the relay after a tunnel reconnect. Hashes never leave main.
   */
  listActiveTokens(): Array<{ id: string; tokenHash: string }>
  /** One active device by id, or null (revoked and unknown look the same). */
  getActiveById(id: string): RemoteDevice | null
  /** Active device whose token hash matches, or null. */
  getActiveByTokenHash(tokenHash: string): RemoteDevice | null
  /** Stamps last_seen_at = now; no-op for revoked or unknown devices. */
  touch(id: string): void
  /** Marks the device revoked; its token stops authenticating immediately. */
  revoke(id: string): void
  /** Removes the row entirely (used when the user deletes a revoked device). */
  delete(id: string): void
}

export function createRemoteDevicesRepository(driver: SqliteDriver): RemoteDevicesRepository {
  return {
    create(input) {
      const row: DeviceRow = {
        id: randomUUID(),
        name: input.name,
        token_hash: input.tokenHash,
        key_fingerprint: input.keyFingerprint,
        created_at: Date.now(),
        last_seen_at: null,
        revoked_at: null,
      }
      driver.run(
        `INSERT INTO remote_devices (id, name, token_hash, key_fingerprint, created_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.name, row.token_hash, row.key_fingerprint, row.created_at, null, null]
      )
      return toDevice(row)
    },

    list() {
      return driver
        .all<DeviceRow>('SELECT * FROM remote_devices ORDER BY created_at DESC')
        .map(toDevice)
    },

    listActive() {
      return driver
        .all<DeviceRow>('SELECT * FROM remote_devices WHERE revoked_at IS NULL ORDER BY created_at ASC')
        .map(toDevice)
    },

    listActiveTokens() {
      return driver
        .all<{ id: string; token_hash: string }>(
          'SELECT id, token_hash FROM remote_devices WHERE revoked_at IS NULL ORDER BY created_at ASC'
        )
        .map((row) => ({ id: row.id, tokenHash: row.token_hash }))
    },

    getActiveById(id) {
      const row = driver.get<DeviceRow>(
        'SELECT * FROM remote_devices WHERE id = ? AND revoked_at IS NULL',
        [id]
      )
      return row ? toDevice(row) : null
    },

    getActiveByTokenHash(tokenHash) {
      const row = driver.get<DeviceRow>(
        'SELECT * FROM remote_devices WHERE token_hash = ? AND revoked_at IS NULL',
        [tokenHash]
      )
      return row ? toDevice(row) : null
    },

    touch(id) {
      driver.run('UPDATE remote_devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL', [
        Date.now(),
        id,
      ])
    },

    revoke(id) {
      driver.run('UPDATE remote_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
        Date.now(),
        id,
      ])
    },

    delete(id) {
      driver.run('DELETE FROM remote_devices WHERE id = ?', [id])
    },
  }
}
