/**
 * App settings, stored one row per AppSettings field (key = field name,
 * value_json = JSON-encoded value). Reads merge over DEFAULT_SETTINGS so new
 * fields added in later versions transparently get their defaults.
 */

import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import type { SqliteDriver } from '../driver'
import { parseJson } from './util'

export interface SettingsRepository {
  get(): AppSettings
  update(patch: Partial<AppSettings>): AppSettings
}

interface SettingsRow {
  key: string
  value_json: string
}

/** Sentinel distinguishing a corrupt stored value from any parsed JSON value. */
const CORRUPT = Symbol('corrupt')

export function createSettingsRepository(driver: SqliteDriver): SettingsRepository {
  // Parsed-settings cache: get() is called many times per generation (chat
  // service, tool registry, executor hooks), and each uncached call re-reads
  // and re-parses the entire settings table. This process is the single
  // writer — update() is the only path that touches the table (verified: no
  // other INSERT/DELETE INTO settings) — so invalidating on writes is sound.
  // Callers must treat the returned object as read-only.
  //
  // Invalidation happens when the OUTERMOST transaction ends, not inside
  // update(): an inner update() joined a caller's transaction via savepoint,
  // and loading there would cache values a later ROLLBACK un-writes. Only
  // transactions that actually wrote settings invalidate — unrelated commits
  // (messages, activity, ...) must not thrash the cache.
  let cache: AppSettings | null = null
  let wroteSettings = false
  driver.onTransactionEnd(() => {
    if (wroteSettings) {
      cache = null
      wroteSettings = false
    }
  })

  const load = (): AppSettings => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      defaultParams: { ...DEFAULT_SETTINGS.defaultParams },
    }
    const rows = driver.all<SettingsRow>('SELECT key, value_json FROM settings')
    for (const row of rows) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, row.key)) continue
      const value = parseJson<unknown>(row.value_json, CORRUPT)
      // corrupt value — keep the default
      if (value === CORRUPT) continue
      ;(settings as unknown as Record<string, unknown>)[row.key] = value
    }
    return settings
  }

  const get = (): AppSettings => {
    if (cache === null) cache = load()
    return cache
  }

  return {
    get,

    update(patch) {
      driver.transaction(() => {
        wroteSettings = true
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue
          if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) continue
          driver.run(
            `INSERT INTO settings (key, value_json) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
            [key, JSON.stringify(value)]
          )
        }
      })
      // See through our own write immediately: callers read fields off the
      // returned object. Nested inside a caller's larger transaction this
      // reloads that composition's not-yet-committed state — if it rolls back,
      // the end-of-transaction hook above re-invalidates.
      cache = null
      return get()
    },
  }
}
