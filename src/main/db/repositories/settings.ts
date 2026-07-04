/**
 * App settings, stored one row per AppSettings field (key = field name,
 * value_json = JSON-encoded value). Reads merge over DEFAULT_SETTINGS so new
 * fields added in later versions transparently get their defaults.
 */

import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import type { SqliteDriver } from '../driver'

export interface SettingsRepository {
  get(): AppSettings
  update(patch: Partial<AppSettings>): AppSettings
}

interface SettingsRow {
  key: string
  value_json: string
}

export function createSettingsRepository(driver: SqliteDriver): SettingsRepository {
  const get = (): AppSettings => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      defaultParams: { ...DEFAULT_SETTINGS.defaultParams },
    }
    const rows = driver.all<SettingsRow>('SELECT key, value_json FROM settings')
    for (const row of rows) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, row.key)) continue
      try {
        ;(settings as unknown as Record<string, unknown>)[row.key] = JSON.parse(row.value_json)
      } catch {
        // corrupt value — keep the default
      }
    }
    return settings
  }

  return {
    get,

    update(patch) {
      driver.transaction(() => {
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
      return get()
    },
  }
}
