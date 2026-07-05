/**
 * Bundled skills: the skill library shipped with the app under
 * resources/bundled-skills (a plugin folder — .claude-plugin/plugin.json +
 * skills/<name>/SKILL.md). Seeded into the skills table once per
 * BUNDLED_SKILLS_VERSION so a user's later edits, disables, and deletions are
 * never overwritten or resurrected on subsequent boots. Bump the version when
 * the shipped skill set changes: skills are re-upserted (enabled flags are
 * preserved by upsertByName) and previously bundled skills that are no longer
 * shipped are removed — user-authored skills are never touched because
 * reconciliation is scoped to the bundle's plugin name.
 */

import type { AppDatabase } from '../db/database'
import { readSkillsFromFolder } from './skills'

const BUNDLED_SKILLS_VERSION_KEY = 'bundled_skills_version'
export const BUNDLED_SKILLS_VERSION = 3

function readSeededVersion(db: AppDatabase): number {
  const row = db.driver.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    BUNDLED_SKILLS_VERSION_KEY,
  ])
  const version = row ? Number.parseInt(row.value, 10) : 0
  return Number.isFinite(version) && version > 0 ? version : 0
}

/**
 * Imports the bundled skill folder into the skills table when it has not been
 * seeded at this version yet. Never throws: a missing/unreadable folder only
 * logs (the app is fully usable without bundled skills), and the version is
 * recorded only after a successful import so a transient failure retries on
 * the next boot.
 */
export async function seedBundledSkills(db: AppDatabase, folder: string): Promise<void> {
  if (readSeededVersion(db) >= BUNDLED_SKILLS_VERSION) return
  try {
    const { pluginName, skills } = await readSkillsFromFolder(folder)
    // Drop previously bundled skills that this version no longer ships.
    if (pluginName !== null) {
      const shipped = new Set(skills.map((s) => s.name.toLowerCase()))
      for (const existing of db.skills.list()) {
        if (existing.pluginName === pluginName && !shipped.has(existing.name.toLowerCase())) {
          db.skills.remove(existing.id)
        }
      }
    }
    for (const skill of skills) {
      db.skills.upsertByName({ ...skill, pluginName, sourcePath: null })
    }
    db.driver.run(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [BUNDLED_SKILLS_VERSION_KEY, String(BUNDLED_SKILLS_VERSION)]
    )
  } catch (e) {
    // Never contains key material — safe to log as-is.
    console.error('Bundled skills seeding failed:', e instanceof Error ? e.message : String(e))
  }
}
