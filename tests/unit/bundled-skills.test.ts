import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { seedBundledSkills, BUNDLED_SKILLS_VERSION } from '../../src/main/services/bundled-skills'
import { readSkillsFromFolder } from '../../src/main/services/skills'

const SHIPPED_DIR = fileURLToPath(new URL('../../resources/bundled-skills', import.meta.url))

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-bundled-skills-test-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Writes a minimal plugin folder with the given skill names. */
function writePluginFolder(names: string[]): string {
  const folder = join(dir, 'bundle')
  mkdirSync(join(folder, '.claude-plugin'), { recursive: true })
  writeFileSync(join(folder, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'Bundled' }))
  for (const name of names) {
    const skillDir = join(folder, 'skills', name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: about ${name}\n---\nInstructions for ${name}.\n`
    )
  }
  return folder
}

function seededVersion(): number {
  const row = db.driver.get<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'bundled_skills_version'"
  )
  return row ? Number.parseInt(row.value, 10) : 0
}

describe('seedBundledSkills', () => {
  it('imports the folder as plugin skills and records the version', async () => {
    await seedBundledSkills(db, writePluginFolder(['alpha', 'beta']))
    const skills = db.skills.list()
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'beta'])
    expect(skills.every((s) => s.pluginName === 'Bundled' && s.enabled)).toBe(true)
    expect(seededVersion()).toBe(BUNDLED_SKILLS_VERSION)
  })

  it('is a no-op once seeded: deletions and edits are not overwritten', async () => {
    const folder = writePluginFolder(['alpha', 'beta'])
    await seedBundledSkills(db, folder)
    const beta = db.skills.getByName('beta')!
    db.skills.remove(db.skills.getByName('alpha')!.id)
    db.skills.update(beta.id, { content: 'user-edited', enabled: false })

    await seedBundledSkills(db, folder)
    expect(db.skills.getByName('alpha')).toBeNull()
    expect(db.skills.getByName('beta')).toMatchObject({ content: 'user-edited', enabled: false })
  })

  it('removes no-longer-shipped bundled skills on version bump, leaving user skills alone', async () => {
    await seedBundledSkills(db, writePluginFolder(['alpha', 'beta']))
    db.skills.create({ name: 'mine', content: 'user-authored' })

    // Next app version ships only 'alpha'. Reset the meta marker to simulate
    // the BUNDLED_SKILLS_VERSION bump that accompanies a bundle change.
    db.driver.run("UPDATE meta SET value = '0' WHERE key = 'bundled_skills_version'")
    rmSync(join(dir, 'bundle', 'skills', 'beta'), { recursive: true, force: true })
    await seedBundledSkills(db, join(dir, 'bundle'))

    expect(db.skills.list().map((s) => s.name)).toEqual(['mine', 'alpha'])
  })

  it('never overwrites or adopts a same-named user-authored skill', async () => {
    const mine = db.skills.create({ name: 'alpha', description: 'mine', content: 'user-authored' })

    await seedBundledSkills(db, writePluginFolder(['alpha', 'beta']))
    expect(db.skills.getById(mine.id)).toMatchObject({
      content: 'user-authored',
      description: 'mine',
      pluginName: null,
    })

    // A later bundle that stops shipping 'alpha' must not delete it either.
    db.driver.run("UPDATE meta SET value = '0' WHERE key = 'bundled_skills_version'")
    rmSync(join(dir, 'bundle', 'skills', 'alpha'), { recursive: true, force: true })
    await seedBundledSkills(db, join(dir, 'bundle'))
    expect(db.skills.getById(mine.id)).toMatchObject({ content: 'user-authored' })
  })

  it('does not record the version when the folder is missing, so seeding retries', async () => {
    await seedBundledSkills(db, join(dir, 'nope'))
    expect(db.skills.list()).toEqual([])
    expect(seededVersion()).toBe(0)

    await seedBundledSkills(db, writePluginFolder(['alpha']))
    expect(db.skills.list().map((s) => s.name)).toEqual(['alpha'])
  })
})

describe('shipped resources/bundled-skills folder', () => {
  it('parses as a plugin with the expected skills, all described and within caps', async () => {
    const { pluginName, skills } = await readSkillsFromFolder(SHIPPED_DIR)
    expect(pluginName).toBe('Bundled')
    expect(skills.map((s) => s.name).sort()).toEqual([
      'artifact-design',
      'batch',
      'code-review',
      'compact',
      'dataviz',
      'deep-research',
      'init',
      'init-new',
      'review',
      'run',
      'run-skill-generator',
      'security-review',
      'simplify',
      'verify',
    ])
    for (const skill of skills) {
      expect(skill.description.length, skill.name).toBeGreaterThan(0)
      expect(skill.content.length, skill.name).toBeLessThan(200_000)
    }
  })

  it('contains no Claude branding (model IDs and .claude-plugin paths excepted)', async () => {
    const { skills } = await readSkillsFromFolder(SHIPPED_DIR)
    for (const skill of skills) {
      const text = `${skill.name}\n${skill.description}\n${skill.content}`
        // Anthropic model IDs stay functional (usable via the Anthropic provider).
        .replace(/[\w.]*claude-(?:3|opus|sonnet|haiku|fable)[-.\w]*/gi, '')
        // Agent-Skills plugin manifest directory — a format name, not branding.
        .replace(/\.claude-plugin/g, '')
      expect(text, skill.name).not.toMatch(/claude/i)
    }
  })
})
