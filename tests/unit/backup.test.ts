import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { applyBackup, buildBackup, BACKUP_FORMAT } from '../../src/main/services/backup'

let dir: string
let source: AppDatabase
let target: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-backup-test-'))
  source = openDatabase(join(dir, 'source.db'))
  target = openDatabase(join(dir, 'target.db'))
})

afterEach(() => {
  source.close()
  target.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('buildBackup', () => {
  it('collects settings, memories and skills with the format marker', () => {
    source.settings.update({ fontSize: 'large', memoryEnabled: false })
    source.memories.create({ title: 'lang', content: 'Swedish' })
    source.skills.create({ name: 'triage', description: 'd', content: 'steps' })

    const backup = buildBackup(source)
    expect(backup.format).toBe(BACKUP_FORMAT)
    expect(backup.version).toBeGreaterThanOrEqual(1)
    expect(backup.settings).toMatchObject({ fontSize: 'large', memoryEnabled: false })
    expect(backup.memories).toEqual([{ title: 'lang', content: 'Swedish' }])
    expect(backup.skills).toHaveLength(1)
    expect(backup.skills[0]).toMatchObject({ name: 'triage', enabled: true })
  })

  it('never contains key material', () => {
    source.providers.create({
      id: 'p1',
      type: 'openai-compatible',
      label: 'P',
      baseUrl: 'https://x.example/v1',
      defaultModelId: 'm',
    })
    source.providers.setKeyRow('p1', 'insecure:c2stU0VDUkVU', 'sk-…RET')
    const json = JSON.stringify(buildBackup(source))
    expect(json).not.toContain('insecure:')
    expect(json).not.toContain('SECRET')
  })
})

describe('applyBackup', () => {
  it('roundtrips settings, memories and skills (including disabled skills)', () => {
    source.settings.update({ fontSize: 'large', compactionEnabled: true })
    source.memories.create({ title: 'lang', content: 'Swedish' })
    const disabled = source.skills.create({ name: 'off-skill', content: 'x' })
    source.skills.update(disabled.id, { enabled: false })
    source.skills.create({ name: 'on-skill', content: 'y', pluginName: 'pack' })

    const summary = applyBackup(target, JSON.parse(JSON.stringify(buildBackup(source))))
    expect(summary.memoriesImported).toBe(1)
    expect(summary.skillsImported).toBe(2)
    expect(summary.settingsApplied).toBeGreaterThan(0)
    expect(summary.skippedItems).toBe(0)

    expect(target.settings.get()).toMatchObject({ fontSize: 'large', compactionEnabled: true })
    expect(target.memories.list()).toHaveLength(1)
    const skills = new Map(target.skills.list().map((s) => [s.name, s]))
    expect(skills.get('off-skill')!.enabled).toBe(false)
    expect(skills.get('on-skill')!.enabled).toBe(true)
    expect(skills.get('on-skill')!.pluginName).toBe('pack')
  })

  it('is idempotent — importing twice never duplicates', () => {
    source.memories.create({ title: 'lang', content: 'Swedish' })
    source.skills.create({ name: 'triage', content: 'steps' })
    const backup = buildBackup(source)

    applyBackup(target, backup)
    applyBackup(target, backup)
    expect(target.memories.list()).toHaveLength(1)
    expect(target.skills.list()).toHaveLength(1)
  })

  it('rejects files without the format marker', () => {
    expect(() => applyBackup(target, { hello: 'world' })).toThrow(/not a grasberg/i)
    expect(() => applyBackup(target, null)).toThrow(/not a grasberg/i)
    expect(() => applyBackup(target, { format: 'other-backup', version: 1 })).toThrow(
      /not a grasberg/i
    )
  })

  it('skips invalid entries and unknown/bad settings keys without failing', () => {
    const summary = applyBackup(target, {
      format: BACKUP_FORMAT,
      version: 1,
      settings: {
        fontSize: 'gigantic', // invalid enum value — skipped
        compactionEnabled: true, // valid — applied
        notARealSetting: true, // unknown key — ignored
      },
      memories: [
        { title: 'ok', content: 'kept' },
        { title: '', content: 'blank title' }, // skipped
        'not an object', // skipped
      ],
      skills: [
        { name: 'ok-skill', content: 'kept' },
        { name: 'no-content' }, // skipped
      ],
    })

    expect(summary.settingsApplied).toBe(1)
    expect(summary.memoriesImported).toBe(1)
    expect(summary.skillsImported).toBe(1)
    expect(summary.skippedItems).toBe(3)
    expect(target.settings.get().compactionEnabled).toBe(true)
    expect(target.settings.get().fontSize).toBe('medium') // untouched default
  })

  it('merges into existing data by title/name instead of duplicating', () => {
    target.memories.create({ title: 'lang', content: 'old value' })
    const existing = target.skills.create({ name: 'triage', content: 'old steps' })
    target.skills.update(existing.id, { enabled: false })

    applyBackup(target, {
      format: BACKUP_FORMAT,
      version: 1,
      memories: [{ title: 'LANG', content: 'new value' }],
      skills: [{ name: 'Triage', content: 'new steps', enabled: true }],
    })

    const memories = target.memories.list()
    expect(memories).toHaveLength(1)
    expect(memories[0].content).toBe('new value')
    const skills = target.skills.list()
    expect(skills).toHaveLength(1)
    expect(skills[0].content).toBe('new steps')
    // The backup's explicit enabled flag wins over the stored one.
    expect(skills[0].enabled).toBe(true)
  })
})
