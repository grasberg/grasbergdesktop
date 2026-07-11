/**
 * Tests for the agentic tool expansion: grep/glob/git, web_search,
 * edit_file/write_file (approval-gated writes through the CodeChange
 * pipeline), background delegate tasks, update_task_list, ask_user_question,
 * and plan-mode blocking.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ToolApprovalAnswer, ToolCallRecord } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { CodeService } from '../../../src/main/code/code-service'
import { createToolSystem, USER_DECLINED_RESULT } from '../../../src/main/tools'
import {
  globToRegExp,
  hasCatastrophicBacktracking,
  parseDuckDuckGoHtml,
} from '../../../src/main/tools/executor'

let dir: string
let db: AppDatabase
let projectDir: string
let projectId: string
let conversationId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-new-tools-'))
  db = openDatabase(join(dir, 'app.db'))
  projectDir = join(dir, 'project')
  mkdirSync(join(projectDir, 'src'), { recursive: true })
  writeFileSync(join(projectDir, 'alpha.txt'), 'hello world\nthe needle is here\n')
  writeFileSync(join(projectDir, 'src', 'beta.ts'), 'export const value = 42\n')
  writeFileSync(join(projectDir, 'src', 'beta.test.ts'), 'test("beta", () => {})\n')
  projectId = db.code.projectUpsertByPath(projectDir, 'project').id
  conversationId = db.conversations.create({ mode: 'work', projectId }).id
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

function conv(overrides: Partial<Conversation> = {}): Conversation {
  const base = db.conversations.getById(conversationId)!
  return { ...base, ...overrides }
}

function call(name: string, args: unknown = {}): ToolCallRecord {
  return {
    id: 'tc-1',
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
    status: 'proposed',
  }
}

const APPROVE: ToolApprovalAnswer = { approved: true, scope: 'once' }
const DECLINE: ToolApprovalAnswer = { approved: false, scope: 'once' }

const approveAll = vi.fn(async () => APPROVE)

/** Tool system wired like main: real CodeService behind codeChanges. */
function system(options: Parameters<typeof createToolSystem>[2] = {}) {
  const codeService = new CodeService(db)
  return createToolSystem(db, codeService, {
    codeChanges: {
      propose: (cid, relPath, changeType, newContent) =>
        codeService.proposeChange(cid, relPath, changeType, newContent),
      apply: (changeId) => codeService.applyChange(changeId),
    },
    ...options,
  })
}

describe('globToRegExp', () => {
  it('matches segments, ** and basename-only patterns', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false)
    expect(globToRegExp('*.md').test('docs/readme.md')).toBe(true)
    expect(globToRegExp('*.md').test('docs/readme.txt')).toBe(false)
    expect(globToRegExp('a?c.txt').test('abc.txt')).toBe(true)
    expect(globToRegExp('a?c.txt').test('a/c.txt')).toBe(false)
  })
})

describe('grep + glob tools', () => {
  it('grep finds regex matches with file:line references', async () => {
    const { executor } = system()
    const result = await executor.execute(call('grep', { pattern: 'needle\\s+is' }), {
      conversation: conv(),
      approval: approveAll,
    })
    expect(result).toContain('alpha.txt:2:')
    expect(result).toContain('the needle is here')
  })

  it('grep honours the glob filter and reports invalid regexes', async () => {
    const { executor } = system()
    const filtered = await executor.execute(
      call('grep', { pattern: 'value|needle', glob: 'src/**/*.ts' }),
      { conversation: conv(), approval: approveAll }
    )
    expect(filtered).toContain('src/beta.ts')
    expect(filtered).not.toContain('alpha.txt')

    const invalid = await executor.execute(call('grep', { pattern: '(' }), {
      conversation: conv(),
      approval: approveAll,
    })
    expect(invalid).toMatch(/invalid regular expression/i)
  })

  it('refuses catastrophic-backtracking patterns before running them', async () => {
    const { executor } = system()
    const evil = await executor.execute(call('grep', { pattern: '(\\w+\\s?)*;$' }), {
      conversation: conv(),
      approval: approveAll,
    })
    expect(evil).toMatch(/catastrophic backtracking/i)
  })

  it('glob lists matching files and reports empty matches', async () => {
    const { executor } = system()
    const result = await executor.execute(call('glob', { pattern: 'src/**/*.test.ts' }), {
      conversation: conv(),
      approval: approveAll,
    })
    expect(result).toBe('src/beta.test.ts')

    const none = await executor.execute(call('glob', { pattern: '**/*.rs' }), {
      conversation: conv(),
      approval: approveAll,
    })
    expect(none).toMatch(/no files match/i)
  })
})

describe('hasCatastrophicBacktracking', () => {
  it('flags nested unbounded quantifiers (the ReDoS shape)', () => {
    expect(hasCatastrophicBacktracking('(\\w+\\s?)*;$')).toBe(true)
    expect(hasCatastrophicBacktracking('(a+)+')).toBe(true)
    expect(hasCatastrophicBacktracking('((a+))+')).toBe(true) // nested one level deeper
    expect(hasCatastrophicBacktracking('(a*)*')).toBe(true)
  })

  it('allows ordinary patterns', () => {
    expect(hasCatastrophicBacktracking('needle\\s+is')).toBe(false)
    expect(hasCatastrophicBacktracking('function\\s+\\w+')).toBe(false)
    expect(hasCatastrophicBacktracking('(abc)+')).toBe(false) // quantified group, no inner quantifier
    expect(hasCatastrophicBacktracking('(a|b)*')).toBe(false)
    expect(hasCatastrophicBacktracking('\\w+')).toBe(false)
    expect(hasCatastrophicBacktracking('[a+]+')).toBe(false) // '+' inside a char class is literal
  })
})

describe('git tool', () => {
  it('rejects unknown actions and escaping paths without running git', async () => {
    const { executor } = system()
    const bad = await executor.execute(call('git', { action: 'push' }), {
      conversation: conv(),
      approval: approveAll,
    })
    expect(bad).toMatch(/unknown git action 'push'/i)

    const escape = await executor.execute(
      call('git', { action: 'diff', path: '../outside.txt' }),
      { conversation: conv(), approval: approveAll }
    )
    expect(escape).toMatch(/outside the granted project folder/i)
  })

  it('fails cleanly in a non-repository folder', async () => {
    const { executor } = system()
    const result = await executor.execute(call('git', { action: 'status' }), {
      conversation: conv(),
      approval: approveAll,
    })
    // Either git is missing on the machine or it reports "not a git repository".
    expect(result).toMatch(/git status failed|not installed/i)
  })
})

describe('web_search tool', () => {
  const DDG_HTML = `
    <div class="result">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
      <a class="result__snippet" href="#">The official docs for <b>Example</b>.</a>
    </div>
    <div class="result">
      <a rel="nofollow" class="result__a" href="https://second.example.org/page">Second page</a>
      <a class="result__snippet" href="#">Another snippet.</a>
    </div>`

  it('parses titles, decoded urls and snippets from the DDG html', () => {
    const hits = parseDuckDuckGoHtml(DDG_HTML, 5)
    expect(hits).toEqual([
      { title: 'Example Docs', url: 'https://example.com/docs', snippet: 'The official docs for Example.' },
      { title: 'Second page', url: 'https://second.example.org/page', snippet: 'Another snippet.' },
    ])
  })

  it('returns formatted results through the executor (mocked fetch)', async () => {
    const fetchImpl = vi.fn(async () => new Response(DDG_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch
    const { executor } = system({ fetchImpl })
    const result = await executor.execute(call('web_search', { query: 'example docs' }), {
      conversation: conv(),
      approval: approveAll,
    })
    expect(result).toContain('1. Example Docs — https://example.com/docs')
    expect(result).toContain('2. Second page — https://second.example.org/page')
  })
})

describe('edit_file / write_file — approval-gated writes', () => {
  it('edit_file replaces a unique string on disk and records an applied change', async () => {
    const { executor } = system()
    const approval = vi.fn(async () => APPROVE)
    const result = await executor.execute(
      call('edit_file', { path: 'src/beta.ts', old_string: 'value = 42', new_string: 'value = 43' }),
      { conversation: conv(), approval }
    )
    expect(approval).toHaveBeenCalledTimes(1)
    expect(result).toMatch(/Edited src\/beta\.ts/)
    expect(readFileSync(join(projectDir, 'src', 'beta.ts'), 'utf8')).toContain('value = 43')
    const changes = db.code.changesList(projectId)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ filePath: 'src/beta.ts', status: 'applied', changeType: 'edit' })
  })

  it('edit_file demands a unique match and reports a missing old_string', async () => {
    writeFileSync(join(projectDir, 'dup.txt'), 'x\nx\n')
    const { executor } = system()
    const dup = await executor.execute(
      call('edit_file', { path: 'dup.txt', old_string: 'x', new_string: 'y' }),
      { conversation: conv(), approval: approveAll }
    )
    expect(dup).toMatch(/occurs 2 times/i)

    const missing = await executor.execute(
      call('edit_file', { path: 'dup.txt', old_string: 'zzz', new_string: 'y' }),
      { conversation: conv(), approval: approveAll }
    )
    expect(missing).toMatch(/was not found/i)
    expect(readFileSync(join(projectDir, 'dup.txt'), 'utf8')).toBe('x\nx\n')
  })

  it('writes new_string literally, without $-pattern substitution', async () => {
    // '$&', '$$' and "$'" are String.replace() substitution patterns; the file
    // must receive them verbatim, not the matched text / a collapsed '$'.
    const { executor } = system()
    const tricky = "const price = '$$5 for $& and back-to-back $`$''"
    const result = await executor.execute(
      call('edit_file', { path: 'src/beta.ts', old_string: 'value = 42', new_string: tricky }),
      { conversation: conv(), approval: approveAll }
    )
    expect(result).toMatch(/Edited src\/beta\.ts/)
    expect(readFileSync(join(projectDir, 'src', 'beta.ts'), 'utf8')).toContain(tricky)
  })

  it('a declined approval writes nothing', async () => {
    const { executor } = system()
    const result = await executor.execute(
      call('edit_file', { path: 'src/beta.ts', old_string: '42', new_string: '43' }),
      { conversation: conv(), approval: vi.fn(async () => DECLINE) }
    )
    expect(result).toBe(USER_DECLINED_RESULT)
    expect(readFileSync(join(projectDir, 'src', 'beta.ts'), 'utf8')).toContain('42')
    expect(db.code.changesList(projectId)).toHaveLength(0)
  })

  it('write_file creates new files and fully replaces existing ones', async () => {
    const { executor } = system()
    const created = await executor.execute(
      call('write_file', { path: 'docs/new.md', content: '# New\n' }),
      { conversation: conv(), approval: approveAll }
    )
    expect(created).toMatch(/Created docs\/new\.md/)
    expect(readFileSync(join(projectDir, 'docs', 'new.md'), 'utf8')).toBe('# New\n')

    const replaced = await executor.execute(
      call('write_file', { path: 'docs/new.md', content: '# Replaced\n' }),
      { conversation: conv(), approval: approveAll }
    )
    expect(replaced).toMatch(/Replaced docs\/new\.md/)
    expect(readFileSync(join(projectDir, 'docs', 'new.md'), 'utf8')).toBe('# Replaced\n')
  })
})

describe('plan mode', () => {
  it('refuses mutating tools without asking, read-only tools still work', async () => {
    const { executor } = system()
    const approval = vi.fn(async () => APPROVE)
    const blocked = await executor.execute(
      call('edit_file', { path: 'src/beta.ts', old_string: '42', new_string: '43' }),
      { conversation: conv(), approval, planMode: true }
    )
    expect(blocked).toMatch(/plan mode is active/i)
    expect(approval).not.toHaveBeenCalled()
    expect(readFileSync(join(projectDir, 'src', 'beta.ts'), 'utf8')).toContain('42')

    const grep = await executor.execute(call('grep', { pattern: 'needle' }), {
      conversation: conv(),
      approval: approveAll,
      planMode: true,
    })
    expect(grep).toContain('alpha.txt:2:')
  })
})

describe('update_task_list', () => {
  it('creates and links a workspace, then upserts the checklist item', async () => {
    const { executor } = system()
    const first = await executor.execute(
      call('update_task_list', {
        tasks: [
          { content: 'Read the code', status: 'completed' },
          { content: 'Write the fix', status: 'in_progress' },
          { content: 'Verify', status: 'pending' },
        ],
      }),
      { conversation: conv(), approval: approveAll }
    )
    expect(first).toBe('Task list updated.')
    const linked = db.conversations.getById(conversationId)!
    expect(linked.workspaceId).toBeTruthy()
    const items = db.workspaces.itemsList(linked.workspaceId!)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'checklist', title: 'Task list' })
    expect(items[0].content).toBe(
      '- [x] Read the code\n- [ ] Write the fix ⟵ in progress\n- [ ] Verify'
    )

    // Second call updates the same item instead of adding another.
    await executor.execute(
      call('update_task_list', { tasks: [{ content: 'Verify', status: 'completed' }] }),
      { conversation: conv(), approval: approveAll }
    )
    const updated = db.workspaces.itemsList(linked.workspaceId!)
    expect(updated).toHaveLength(1)
    expect(updated[0].content).toBe('- [x] Verify')
  })

  it('validates the tasks array', async () => {
    const { executor } = system()
    const result = await executor.execute(
      call('update_task_list', { tasks: [{ content: 'x', status: 'later' }] }),
      { conversation: conv(), approval: approveAll }
    )
    expect(result).toMatch(/status must be/i)
  })
})

describe('ask_user_question', () => {
  it('returns the chosen answer, and a dismissal note for null', async () => {
    const { executor } = system()
    const answered = await executor.execute(
      call('ask_user_question', { question: 'Which db?', options: ['SQLite', 'Postgres'] }),
      { conversation: conv(), approval: approveAll, askUser: async () => 'SQLite' }
    )
    expect(answered).toBe('The user answered: SQLite')

    const dismissed = await executor.execute(
      call('ask_user_question', { question: 'Which db?' }),
      { conversation: conv(), approval: approveAll, askUser: async () => null }
    )
    expect(dismissed).toMatch(/dismissed the question/i)
  })

  it('reports unavailability when no askUser bridge is provided', async () => {
    const { executor } = system()
    const result = await executor.execute(call('ask_user_question', { question: 'Hm?' }), {
      conversation: conv(),
      approval: approveAll,
    })
    expect(result).toMatch(/unavailable/i)
  })
})

describe('background delegate tasks', () => {
  it('routes delegate background=true and task_output/task_stop to the bridge', async () => {
    const start = vi.fn(() => "Started background task 'task-1'.")
    const output = vi.fn((id: string) => `Task '${id}' is still running.`)
    const stop = vi.fn((id: string) => `Task '${id}' stopped.`)
    const { executor } = system({
      delegate: async () => 'inline result',
      delegateBackground: { start, output, stop },
    })

    const started = await executor.execute(
      call('delegate', { task: 'scan the repo', background: true }),
      { conversation: conv(), approval: approveAll }
    )
    expect(started).toContain("task-1")
    expect(start).toHaveBeenCalledTimes(1)

    const polled = await executor.execute(call('task_output', { taskId: 'task-1' }), {
      conversation: conv(),
      approval: approveAll,
    })
    expect(polled).toContain('still running')

    const stopped = await executor.execute(call('task_stop', { taskId: 'task-1' }), {
      conversation: conv(),
      approval: approveAll,
    })
    expect(stopped).toContain('stopped')

    // Foreground delegate is untouched.
    const inline = await executor.execute(call('delegate', { task: 'quick question' }), {
      conversation: conv(),
      approval: approveAll,
    })
    expect(inline).toBe('inline result')
  })
})
