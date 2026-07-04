import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseFrontmatter,
  parseSkillMd,
  readSkillsFromFolder,
} from '../../src/main/services/skills'

describe('parseFrontmatter', () => {
  it('parses key: value pairs and returns the body', () => {
    const text = [
      '---',
      'name: my-skill',
      'description: "Does a thing"',
      "license: 'MIT'",
      '---',
      '# Instructions',
      'Step one.',
    ].join('\n')
    const { attrs, body } = parseFrontmatter(text)
    expect(attrs).toEqual({ name: 'my-skill', description: 'Does a thing', license: 'MIT' })
    expect(body).toBe('# Instructions\nStep one.')
  })

  it('returns empty attrs when there is no frontmatter or it is unterminated', () => {
    expect(parseFrontmatter('# Just markdown').attrs).toEqual({})
    expect(parseFrontmatter('---\nname: x\nno closing fence').attrs).toEqual({})
    expect(parseFrontmatter('---\nname: x\nno closing fence').body).toContain('name: x')
  })

  it('ignores nested/list lines and handles CRLF', () => {
    const text = '---\r\nname: crlf-skill\r\nmetadata:\r\n  nested: ignored\r\n---\r\nBody.'
    const { attrs, body } = parseFrontmatter(text)
    expect(attrs['name']).toBe('crlf-skill')
    expect(attrs['nested']).toBeUndefined()
    expect(body).toBe('Body.')
  })
})

describe('parseSkillMd', () => {
  it('uses the frontmatter name, falling back to the folder name', () => {
    expect(parseSkillMd('---\nname: named\n---\nBody.', 'folder')!.name).toBe('named')
    expect(parseSkillMd('---\ndescription: d\n---\nBody.', 'folder')!.name).toBe('folder')
  })

  it('returns null for an empty body or missing name', () => {
    expect(parseSkillMd('---\nname: x\n---\n   \n', 'fallback')).toBeNull()
    expect(parseSkillMd('Body without a name.', '  ')).toBeNull()
  })
})

describe('readSkillsFromFolder', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uld-skills-import-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const writeSkill = (folder: string, name: string | null, body = 'Do the thing.'): void => {
    mkdirSync(folder, { recursive: true })
    const frontmatter = name
      ? `---\nname: ${name}\ndescription: ${name} description\n---\n`
      : ''
    writeFileSync(join(folder, 'SKILL.md'), `${frontmatter}${body}`)
  }

  it('imports a single skill folder', async () => {
    writeSkill(join(dir, 'commit-helper'), 'commit-helper')
    const result = await readSkillsFromFolder(join(dir, 'commit-helper'))
    expect(result.pluginName).toBeNull()
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toMatchObject({
      name: 'commit-helper',
      description: 'commit-helper description',
      content: 'Do the thing.',
    })
  })

  it('imports a collection of skill folders (one level deep)', async () => {
    writeSkill(join(dir, 'a-skill'), 'a-skill')
    writeSkill(join(dir, 'b-skill'), null) // name falls back to folder name
    mkdirSync(join(dir, 'not-a-skill'))
    const result = await readSkillsFromFolder(dir)
    expect(result.pluginName).toBeNull()
    expect(result.skills.map((s) => s.name)).toEqual(['a-skill', 'b-skill'])
  })

  it('imports a plugin folder via its manifest and skills/ directory', async () => {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'my-plugin', version: '1.0.0' })
    )
    writeSkill(join(dir, 'skills', 'triage'), 'triage')
    writeSkill(join(dir, 'skills', 'research'), 'research')
    const result = await readSkillsFromFolder(dir)
    expect(result.pluginName).toBe('my-plugin')
    expect(result.skills.map((s) => s.name)).toEqual(['research', 'triage'])
  })

  it('falls back to the folder name when the plugin manifest is malformed', async () => {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'not json')
    writeSkill(join(dir, 'skills', 'thing'), 'thing')
    const result = await readSkillsFromFolder(dir)
    expect(result.pluginName).toBe(basename(dir))
    expect(result.skills).toHaveLength(1)
  })

  it('throws a helpful error when nothing importable is found', async () => {
    mkdirSync(join(dir, 'empty'))
    await expect(readSkillsFromFolder(join(dir, 'empty'))).rejects.toThrow(/No skills found/)
  })

  it('throws for a plugin without any skills', async () => {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'bare' }))
    await expect(readSkillsFromFolder(dir)).rejects.toThrow(/has no skills/)
  })
})
