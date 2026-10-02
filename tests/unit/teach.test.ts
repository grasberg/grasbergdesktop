/**
 * Teach-a-task (v53, Grok Bot parity): recorder events → normalized steps →
 * a generalized skill (or a deterministic fallback), secrets never recorded,
 * plus the conversation → skill path and create_skill.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TeachStep } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import {
  TEACH_MARKER,
  TEACH_RECORDER_JS,
  TeachService,
  buildConversationSkillPrompt,
  buildTeachPrompt,
  cleanSkillMarkdown,
  conversationTranscript,
  describeStep,
  fallbackSkill,
  normalizeSteps,
  parseTeachEvent,
  type TeachableSession,
} from '../../src/main/services/teach'
import { createToolSystem } from '../../src/main/tools'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-teach-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

const step = (overrides: Partial<TeachStep>): TeachStep => ({
  kind: 'click',
  url: 'https://app.example.com',
  selector: '',
  label: '',
  tag: '',
  value: null,
  secret: false,
  at: 0,
  ...overrides,
})

describe('recorder events', () => {
  it('parses recorder lines and refuses to carry a secret value', () => {
    const typed = parseTeachEvent(
      `${TEACH_MARKER}${JSON.stringify({ kind: 'input', selector: '#q', label: 'Search', value: 'flights' })}`,
      'https://x.example.com',
      5
    )
    expect(typed).toMatchObject({ kind: 'input', value: 'flights', secret: false, url: 'https://x.example.com' })
    const secret = parseTeachEvent(
      `${TEACH_MARKER}${JSON.stringify({ kind: 'input', selector: '#pw', value: 'hunter2', secret: true })}`,
      'https://x.example.com',
      6
    )
    expect(secret?.value).toBeNull()
    expect(secret?.secret).toBe(true)
    expect(parseTeachEvent('hello', 'u', 1)).toBeNull()
    expect(parseTeachEvent(`${TEACH_MARKER}{bad json`, 'u', 1)).toBeNull()
    expect(parseTeachEvent(`${TEACH_MARKER}${JSON.stringify({ kind: 'evil' })}`, 'u', 1)).toBeNull()
  })

  it('the recorder source is valid JavaScript and reuses the sensitive-field predicate', () => {
    expect(() => new Function(`return ${TEACH_RECORDER_JS}`)).not.toThrow()
    expect(TEACH_RECORDER_JS).toContain('password')
  })
})

describe('step normalization and description', () => {
  it('merges repeated field edits and marks loads caused by a click', () => {
    const steps = normalizeSteps([
      step({ kind: 'navigate', url: 'https://a.example.com', at: 0 }),
      step({ kind: 'input', selector: '#q', value: 'l', at: 1000 }),
      step({ kind: 'input', selector: '#q', value: 'lisbon', at: 1500 }),
      step({ kind: 'click', label: 'Search', at: 2000 }),
      step({ kind: 'navigate', url: 'https://a.example.com/results', at: 2500 }),
      step({ kind: 'navigate', url: 'https://a.example.com/results', at: 2600 }),
    ])
    expect(steps.map((s) => s.kind)).toEqual(['navigate', 'input', 'click', 'navigate'])
    expect(steps[1].value).toBe('lisbon')
    expect(steps[3].followsAction).toBe(true)
    expect(describeStep(steps[0])).toBe('Open https://a.example.com')
    expect(describeStep(steps[3])).toMatch(/^Page loads/)
    expect(describeStep(step({ kind: 'input', label: 'Password', secret: true }))).toMatch(/SECRET/)
  })

  it('builds a generalizing prompt and a usable fallback skill', () => {
    const steps = [step({ kind: 'navigate', url: 'https://b.example.com' }), step({ kind: 'click', label: 'Export' })]
    const prompt = buildTeachPrompt({ name: 'export-report', description: 'Monthly export', steps })
    expect(prompt).toContain('1. Open https://b.example.com')
    expect(prompt).toContain('## Approval boundaries')
    const fallback = fallbackSkill({ name: 'export-report', description: '', steps })
    expect(fallback).toContain('2. Click "Export"')
    expect(cleanSkillMarkdown('```markdown\n## Purpose\nx\n```')).toBe('## Purpose\nx')
  })
})

describe('TeachService', () => {
  function fakeSession(recorded: TeachStep[]): TeachableSession & { log: string[] } {
    const log: string[] = []
    return {
      log,
      takeOver: () => log.push('takeOver'),
      returnControl: () => log.push('returnControl'),
      startRecording: () => log.push('start'),
      stopRecording: () => {
        log.push('stop')
        return recorded
      },
      navigate: async (url) => {
        log.push(`navigate ${url}`)
        return ''
      },
    }
  }

  it('records in the agent browser and saves the generalized skill', async () => {
    const session = fakeSession([step({ kind: 'navigate', url: 'https://c.example.com' }), step({ label: 'Go' })])
    const prompts: string[] = []
    const service = new TeachService({
      sessionFor: () => session,
      generate: async (prompt) => {
        prompts.push(prompt)
        return '## Purpose\nDo the thing the user showed, robustly and repeatably.'
      },
      saveSkill: (input) => db.skills.upsertByName(input),
    })
    await service.start('bot-1', 'https://c.example.com')
    expect(service.status()?.agentId).toBe('bot-1')
    await expect(service.start(null)).rejects.toThrow(/already being recorded/)
    const skill = await service.stop({ name: 'do-thing', description: 'the thing' })
    expect(skill?.name).toBe('do-thing')
    expect(skill?.content).toContain('robustly')
    expect(session.log).toEqual(['takeOver', 'start', 'navigate https://c.example.com', 'stop', 'returnControl'])
    expect(prompts[0]).toContain('Click "Go"')
    expect(service.status()).toBeNull()
    expect(db.skills.getByName('do-thing')?.enabled).toBe(true)
  })

  it('falls back to the recorded steps when generation fails, and can cancel', async () => {
    const service = new TeachService({
      sessionFor: () => fakeSession([step({ label: 'Approve' })]),
      generate: async () => {
        throw new Error('no model')
      },
      saveSkill: (input) => db.skills.upsertByName(input),
    })
    await service.start(null)
    const skill = await service.stop({ name: 'approve-it' })
    expect(skill?.content).toContain('Click "Approve"')

    await service.start(null)
    expect(await service.stop({ cancel: true })).toBeNull()
    await service.start(null)
    await expect(service.stop({})).rejects.toThrow(/name/)
  })
})

describe('skills from conversations and create_skill', () => {
  it('builds a compact transcript including tool calls', () => {
    const transcript = conversationTranscript([
      { role: 'user', content: 'Book a table' },
      {
        role: 'assistant',
        content: 'Done',
        toolCalls: [{ name: 'browser', arguments: '{"action":"navigate","url":"https://r.example.com"}' }],
      },
      { role: 'system', content: 'hidden' },
    ])
    expect(transcript).toContain('User: Book a table')
    expect(transcript).toContain('[tool browser]')
    expect(transcript).not.toContain('hidden')
    expect(buildConversationSkillPrompt({ name: 'book', description: '', transcript })).toContain(
      'Book a table'
    )
  })

  it('create_skill saves (and replaces) a skill through the executor', async () => {
    const { executor } = createToolSystem(db, null)
    const ctx = {
      conversation: {
        id: 'c',
        mode: 'chat' as const,
        title: '',
        providerId: null,
        modelId: null,
        systemPrompt: null,
        params: {},
        workspaceId: null,
        projectId: null,
        projectRef: null,
        moaPresetId: null,
        createdAt: 0,
        updatedAt: 0,
      },
      approval: async () => ({ approved: true, scope: 'once' as const }),
    }
    const call = (args: unknown) => ({
      id: 't',
      name: 'create_skill',
      arguments: JSON.stringify(args),
      status: 'proposed' as const,
    })
    expect(
      await executor.execute(call({ name: 'expense-report', content: '## Purpose\nv1' }), ctx)
    ).toContain("Skill 'expense-report' saved")
    await executor.execute(call({ name: 'Expense-Report', content: '## Purpose\nv2' }), ctx)
    expect(db.skills.list()).toHaveLength(1)
    expect(db.skills.getByName('expense-report')?.content).toContain('v2')
  })
})
