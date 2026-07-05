/**
 * Project-instruction auto-loading: code-mode generations inject the
 * project's instruction file (AGENTS.md, falling back to CLAUDE.md) as a
 * system note. Exercised through ChatService's private reader — the injection
 * point in buildHistory is a straight call to it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import {
  ChatService,
  INIT_COMMAND_PROMPT,
  expandSlashCommand,
} from '../../src/main/services/chat-service'

interface InstructionsReader {
  readProjectInstructions(projectId: string): string | null
}

let dir: string
let db: AppDatabase
let projectDir: string
let projectId: string
let reader: InstructionsReader

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-project-instructions-'))
  db = openDatabase(join(dir, 'app.db'))
  projectDir = join(dir, 'project')
  mkdirSync(projectDir, { recursive: true })
  projectId = db.code.projectUpsertByPath(projectDir, 'project').id
  reader = new ChatService(db, () => undefined) as unknown as InstructionsReader
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('readProjectInstructions', () => {
  it('returns null when no instruction file exists', () => {
    expect(reader.readProjectInstructions(projectId)).toBeNull()
    expect(reader.readProjectInstructions('nope')).toBeNull()
  })

  it('reads AGENTS.md and labels the source file', () => {
    writeFileSync(join(projectDir, 'AGENTS.md'), '# Rules\nUse tabs.\n')
    const text = reader.readProjectInstructions(projectId)
    expect(text).toContain('Project instructions from AGENTS.md')
    expect(text).toContain('Use tabs.')
  })

  it('falls back to CLAUDE.md, preferring AGENTS.md, ignoring GRASBERG.md', () => {
    writeFileSync(join(projectDir, 'GRASBERG.md'), 'legacy rules')
    expect(reader.readProjectInstructions(projectId)).toBeNull()
    writeFileSync(join(projectDir, 'CLAUDE.md'), 'claude rules')
    expect(reader.readProjectInstructions(projectId)).toContain(
      'Project instructions from CLAUDE.md'
    )
    writeFileSync(join(projectDir, 'AGENTS.md'), 'agents rules')
    expect(reader.readProjectInstructions(projectId)).toContain(
      'Project instructions from AGENTS.md'
    )
  })

  it('caps oversized instruction files', () => {
    writeFileSync(join(projectDir, 'AGENTS.md'), 'x'.repeat(50_000))
    const text = reader.readProjectInstructions(projectId)!
    expect(text.length).toBeLessThan(20_000)
    expect(text).toContain('…[truncated]')
  })
})

describe('expandSlashCommand (/init)', () => {
  it('expands /init to the AGENTS.md init prompt in code mode only', () => {
    expect(expandSlashCommand('/init', 'code')).toBe(INIT_COMMAND_PROMPT)
    expect(expandSlashCommand('  /init  ', 'code')).toBe(INIT_COMMAND_PROMPT)
    expect(INIT_COMMAND_PROMPT).toContain('AGENTS.md')
    expect(INIT_COMMAND_PROMPT).toContain('write_file')
  })

  it('passes everything else through verbatim', () => {
    expect(expandSlashCommand('/init', 'chat')).toBe('/init')
    expect(expandSlashCommand('/init now please', 'code')).toBe('/init now please')
    expect(expandSlashCommand('hello', 'code')).toBe('hello')
  })
})
