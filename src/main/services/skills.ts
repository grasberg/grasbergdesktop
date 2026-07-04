/**
 * Skill import: parses the Agent Skills standard format used by most AI
 * agents — a skill is a folder with a SKILL.md whose YAML frontmatter carries
 * `name` and `description`, and whose Markdown body is the instructions.
 * Skills can be packaged in plugins: a folder with a .claude-plugin/plugin.json
 * manifest and a skills/ directory of skill folders.
 *
 * readSkillsFromFolder accepts any of:
 *   1. a plugin folder   (<dir>/.claude-plugin/plugin.json + <dir>/skills/*)
 *   2. a skill folder    (<dir>/SKILL.md)
 *   3. a skills collection (<dir>/<skill>/SKILL.md, one level deep)
 *
 * Reading is tolerant: unreadable/oversized files and malformed frontmatter
 * fields are skipped or defaulted, never thrown on. Only "nothing importable
 * found" is an error.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** SKILL.md files larger than this are skipped (defensive cap). */
const SKILL_FILE_MAX_BYTES = 512 * 1024
/** Skill content is truncated to this many characters (matches skill schema). */
const SKILL_CONTENT_MAX_CHARS = 200_000

export interface ParsedSkill {
  name: string
  description: string
  content: string
}

export interface SkillFolderImport {
  /** Manifest name when the folder is a plugin; null otherwise. */
  pluginName: string | null
  skills: ParsedSkill[]
}

/**
 * Minimal YAML-frontmatter parser: a leading `---` line, `key: value` pairs
 * (nested/list values are ignored), a closing `---` line. Returns the
 * attributes plus the remaining body. Files without frontmatter get empty
 * attributes and the whole text as body.
 */
export function parseFrontmatter(text: string): {
  attrs: Record<string, string>
  body: string
} {
  const normalized = text.replace(/^﻿/, '') // strip BOM
  const lines = normalized.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { attrs: {}, body: normalized }
  const endIndex = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (endIndex === -1) return { attrs: {}, body: normalized }

  const attrs: Record<string, string> = {}
  for (const line of lines.slice(1, endIndex)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue // nested/list/comment lines — ignored
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    attrs[match[1].toLowerCase()] = value
  }
  return { attrs, body: lines.slice(endIndex + 1).join('\n') }
}

/**
 * Parses one SKILL.md text into a skill. `fallbackName` (the skill folder's
 * basename) is used when the frontmatter has no `name`. Returns null when no
 * name can be derived or the body is empty.
 */
export function parseSkillMd(text: string, fallbackName: string): ParsedSkill | null {
  const { attrs, body } = parseFrontmatter(text)
  const name = (attrs['name'] ?? '').trim() || fallbackName.trim()
  const content = body.trim()
  if (name.length === 0 || content.length === 0) return null
  return {
    name: name.slice(0, 100),
    description: (attrs['description'] ?? '').trim().slice(0, 1024),
    content: content.slice(0, SKILL_CONTENT_MAX_CHARS),
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > SKILL_FILE_MAX_BYTES) return null
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

/** Reads <skillDir>/SKILL.md into a ParsedSkill; null when absent/invalid. */
async function readSkillDir(skillDir: string): Promise<ParsedSkill | null> {
  const text = await readTextFile(path.join(skillDir, 'SKILL.md'))
  if (text === null) return null
  return parseSkillMd(text, path.basename(skillDir))
}

/** Collects <parent>/<child>/SKILL.md skills, one level deep. */
async function readSkillsCollection(parent: string): Promise<ParsedSkill[]> {
  let entries
  try {
    entries = await fs.readdir(parent, { withFileTypes: true })
  } catch {
    return []
  }
  const skills: ParsedSkill[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const skill = await readSkillDir(path.join(parent, entry.name))
    if (skill) skills.push(skill)
  }
  return skills
}

/** Reads the plugin manifest's name; null when the folder is not a plugin. */
async function readPluginName(folder: string): Promise<string | null> {
  const text = await readTextFile(path.join(folder, '.claude-plugin', 'plugin.json'))
  if (text === null) return null
  try {
    const manifest: unknown = JSON.parse(text)
    if (typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)) {
      const name = (manifest as Record<string, unknown>)['name']
      if (typeof name === 'string' && name.trim().length > 0) return name.trim().slice(0, 100)
    }
  } catch {
    // malformed manifest — treated as a plugin without a usable name
  }
  return path.basename(folder)
}

/**
 * Imports every skill found in `folder` (plugin, single skill, or skills
 * collection — see module doc). Throws when the folder contains nothing
 * importable.
 */
export async function readSkillsFromFolder(folder: string): Promise<SkillFolderImport> {
  const pluginName = await readPluginName(folder)
  if (pluginName !== null) {
    const skills = await readSkillsCollection(path.join(folder, 'skills'))
    if (skills.length === 0) {
      throw new Error(`The plugin '${pluginName}' has no skills/<name>/SKILL.md entries.`)
    }
    return { pluginName, skills }
  }

  const single = await readSkillDir(folder)
  if (single) return { pluginName: null, skills: [single] }

  const collection = await readSkillsCollection(folder)
  if (collection.length > 0) return { pluginName: null, skills: collection }

  throw new Error(
    'No skills found. Pick a skill folder (containing SKILL.md), a folder of skill folders, ' +
      'or a plugin folder (containing .claude-plugin/plugin.json).'
  )
}
