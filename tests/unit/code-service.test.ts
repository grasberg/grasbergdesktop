import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Conversation, FileTreeNode } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { CodeService } from '../../src/main/code/code-service'
import { ProviderError } from '../../src/main/providers/errors'

let baseDir: string
let projectDir: string
let db: AppDatabase
let service: CodeService

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'uld-code-test-'))
  projectDir = join(baseDir, 'myproject')
  mkdirSync(join(projectDir, 'src'), { recursive: true })
  mkdirSync(join(projectDir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# Readme\nold line\n', 'utf8')
  writeFileSync(join(projectDir, 'src', 'app.ts'), 'console.log(1)\n', 'utf8')
  writeFileSync(join(projectDir, 'node_modules', 'pkg', 'index.js'), 'ignored\n', 'utf8')
  writeFileSync(join(projectDir, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]))
  // A file outside the project that traversal attacks would try to reach.
  writeFileSync(join(baseDir, 'secret.txt'), 'top secret\n', 'utf8')

  db = openDatabase(join(baseDir, 'test.db'))
  service = new CodeService(db)
})

afterEach(() => {
  db.close()
  rmSync(baseDir, { recursive: true, force: true })
})

function expectInvalid(fn: () => unknown, messagePart?: string): void {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError)
    expect((e as ProviderError).code).toBe('invalid_request')
    if (messagePart) expect((e as ProviderError).message).toContain(messagePart)
    return
  }
  throw new Error('expected the call to throw invalid_request')
}

function openTestProject() {
  return service.openProject(projectDir)
}

function createCodeConversation(projectId: string | null): Conversation {
  return db.conversations.create({ mode: 'work', projectId })
}

describe('CodeService.openProject', () => {
  it('registers the folder with its basename as name', () => {
    const project = openTestProject()
    expect(project.name).toBe('myproject')
    expect(project.path).toBe(projectDir)
    expect(db.code.projectGetById(project.id)).not.toBeNull()
  })

  it('upserts by path (same folder keeps the same id)', () => {
    const first = openTestProject()
    const second = openTestProject()
    expect(second.id).toBe(first.id)
    expect(db.code.projectsList()).toHaveLength(1)
  })

  it('rejects missing folders, files and relative paths', () => {
    expectInvalid(() => service.openProject(join(baseDir, 'does-not-exist')))
    expectInvalid(() => service.openProject(join(projectDir, 'README.md')))
    expectInvalid(() => service.openProject('relative/path'))
    expectInvalid(() => service.openProject('   '))
  })
})

describe('CodeService.fileTree', () => {
  it('walks the project (dirs first, alphabetical) and ignores node_modules', () => {
    const project = openTestProject()
    const tree = service.fileTree(project.id)

    expect(tree.relPath).toBe('')
    expect(tree.type).toBe('dir')
    expect(tree.name).toBe('myproject')

    const names = tree.children!.map((c: FileTreeNode) => c.name)
    expect(names).not.toContain('node_modules')
    // dirs first, then files alphabetically (case-insensitive)
    expect(names).toEqual(['src', 'image.bin', 'README.md'])

    const src = tree.children!.find((c) => c.name === 'src')!
    expect(src.type).toBe('dir')
    expect(src.children!.map((c) => c.relPath)).toEqual(['src/app.ts'])

    const readme = tree.children!.find((c) => c.name === 'README.md')!
    expect(readme.type).toBe('file')
    expect(readme.sizeBytes).toBeGreaterThan(0)
  })

  it('fails for unknown projects', () => {
    expectInvalid(() => service.fileTree('nope'))
  })
})

describe('CodeService.readFile', () => {
  it('reads a text file inside the project', () => {
    const project = openTestProject()
    const result = service.readFile(project.id, 'src/app.ts')
    expect(result.content).toBe('console.log(1)\n')
    expect(result.relPath).toBe('src/app.ts')
    expect(result.truncated).toBe(false)
    expect(result.sizeBytes).toBe(Buffer.byteLength('console.log(1)\n'))
  })

  it('accepts backslash separators on the way in', () => {
    const project = openTestProject()
    const result = service.readFile(project.id, 'src\\app.ts')
    expect(result.content).toBe('console.log(1)\n')
    expect(result.relPath).toBe('src/app.ts')
  })

  it('rejects traversal and absolute paths', () => {
    const project = openTestProject()
    expectInvalid(() => service.readFile(project.id, '../secret.txt'))
    expectInvalid(() => service.readFile(project.id, 'src/../../secret.txt'))
    expectInvalid(() => service.readFile(project.id, '..\\secret.txt'))
    expectInvalid(() => service.readFile(project.id, join(baseDir, 'secret.txt')))
    expectInvalid(() => service.readFile(project.id, '/etc/passwd'))
    expectInvalid(() => service.readFile(project.id, 'C:\\Windows\\win.ini'))
    expectInvalid(() => service.readFile(project.id, '\\\\server\\share\\x'))
    expectInvalid(() => service.readFile(project.id, '..'))
    expectInvalid(() => service.readFile(project.id, '  '))
  })

  it('rejects binary files', () => {
    const project = openTestProject()
    expectInvalid(() => service.readFile(project.id, 'image.bin'), 'Binary file')
  })

  it('truncates files larger than 256 KB', () => {
    const project = openTestProject()
    const big = 'x'.repeat(300 * 1024)
    writeFileSync(join(projectDir, 'big.txt'), big, 'utf8')
    const result = service.readFile(project.id, 'big.txt')
    expect(result.truncated).toBe(true)
    expect(result.sizeBytes).toBe(300 * 1024)
    expect(result.content.length).toBe(256 * 1024)
  })

  it('rejects missing files and directories', () => {
    const project = openTestProject()
    expectInvalid(() => service.readFile(project.id, 'nope.txt'))
    expectInvalid(() => service.readFile(project.id, 'src'))
  })

  it('rejects reading through an in-project symlink that escapes the root', () => {
    const project = openTestProject()
    // A symlink INSIDE the project that points at a file OUTSIDE the root.
    let created = true
    try {
      symlinkSync(join(baseDir, 'secret.txt'), join(projectDir, 'link.txt'))
    } catch {
      created = false // Windows without privilege to create symlinks — skip.
    }
    if (!created) return
    expectInvalid(() => service.readFile(project.id, 'link.txt'), 'escapes the project root')
    // The secret content never leaks even though the path is "inside" the root.
    try {
      const out = service.readFile(project.id, 'link.txt')
      expect(out.content).not.toContain('top secret')
    } catch {
      // rejection is the expected outcome
    }
  })
})

// Shared fixture: a create + edit + delete proposal (plus one escape attempt),
// used by the apply/reject describe below and the revert tests further down.
const assistantContent = [
  'Proposals:',
  '```uld-change',
  '{"path":"notes/new.txt","type":"create"}',
  'hello new file',
  '```',
  '```uld-change',
  '{"path":"README.md","type":"edit"}',
  '# Readme',
  'new line',
  '```',
  '```uld-change',
  '{"path":"src/app.ts","type":"delete"}',
  '```',
  '```uld-change',
  '{"path":"../evil.txt","type":"create"}',
  'escape attempt',
  '```',
].join('\n')

describe('CodeService.registerProposedChanges + apply/reject', () => {
  it('registers proposed changes with diffs and skips escaping paths', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const changes = service.registerProposedChanges(conversation.id, assistantContent)

    expect(changes.map((c) => c.filePath)).toEqual(['notes/new.txt', 'README.md', 'src/app.ts'])
    expect(changes.every((c) => c.status === 'proposed')).toBe(true)
    expect(changes.every((c) => c.conversationId === conversation.id)).toBe(true)

    const [create, edit, del] = changes
    expect(create.changeType).toBe('create')
    expect(create.diff).toContain('--- /dev/null')
    expect(create.diff).toContain('+hello new file')
    expect(create.newContent).toBe('hello new file\n')

    expect(edit.changeType).toBe('edit')
    expect(edit.diff).toContain('-old line')
    expect(edit.diff).toContain('+new line')

    expect(del.changeType).toBe('delete')
    expect(del.newContent).toBeNull()
    expect(del.diff).toContain('+++ /dev/null')
    expect(del.diff).toContain('-console.log(1)')

    // Nothing was written to disk at proposal time.
    expect(existsSync(join(projectDir, 'notes', 'new.txt'))).toBe(false)
    expect(readFileSync(join(projectDir, 'README.md'), 'utf8')).toBe('# Readme\nold line\n')
    expect(existsSync(join(baseDir, 'evil.txt'))).toBe(false)
  })

  it('returns [] when the conversation has no project', () => {
    openTestProject()
    const conversation = createCodeConversation(null)
    expect(service.registerProposedChanges(conversation.id, assistantContent)).toEqual([])
    expect(service.registerProposedChanges('unknown-conversation', assistantContent)).toEqual([])
  })

  it('applies create/edit/delete changes to disk (round-trip)', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const [create, edit, del] = service.registerProposedChanges(
      conversation.id,
      assistantContent
    )

    const appliedCreate = service.applyChange(create.id)
    expect(appliedCreate.status).toBe('applied')
    expect(appliedCreate.appliedAt).not.toBeNull()
    expect(readFileSync(join(projectDir, 'notes', 'new.txt'), 'utf8')).toBe('hello new file\n')

    service.applyChange(edit.id)
    expect(readFileSync(join(projectDir, 'README.md'), 'utf8')).toBe('# Readme\nnew line\n')

    service.applyChange(del.id)
    expect(existsSync(join(projectDir, 'src', 'app.ts'))).toBe(false)

    // Applying twice is refused.
    expectInvalid(() => service.applyChange(create.id))
  })

  it('refuses to delete a file that no longer exists', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const changes = service.registerProposedChanges(conversation.id, assistantContent)
    const del = changes.find((c) => c.changeType === 'delete')!
    rmSync(join(projectDir, 'src', 'app.ts'))
    expectInvalid(() => service.applyChange(del.id))
  })

  it('refuses to apply an edit when the file changed on disk since the proposal', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const edit = service
      .registerProposedChanges(conversation.id, assistantContent)
      .find((c) => c.changeType === 'edit')!

    // Someone edits README.md after the change was proposed.
    writeFileSync(join(projectDir, 'README.md'), '# Readme\ntotally different now\n', 'utf8')

    expectInvalid(() => service.applyChange(edit.id), 'changed on disk')
    // The stale approval never overwrote the newer content.
    expect(readFileSync(join(projectDir, 'README.md'), 'utf8')).toBe(
      '# Readme\ntotally different now\n'
    )
  })

  it('refuses to apply a create when a different file already exists at the path', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const create = service
      .registerProposedChanges(conversation.id, assistantContent)
      .find((c) => c.changeType === 'create')!

    mkdirSync(join(projectDir, 'notes'), { recursive: true })
    writeFileSync(join(projectDir, 'notes', 'new.txt'), 'pre-existing content\n', 'utf8')

    expectInvalid(() => service.applyChange(create.id), 'changed on disk')
    expect(readFileSync(join(projectDir, 'notes', 'new.txt'), 'utf8')).toBe('pre-existing content\n')
  })

  it('rejectChange marks the change rejected and leaves the disk untouched', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const [create] = service.registerProposedChanges(conversation.id, assistantContent)

    const rejected = service.rejectChange(create.id)
    expect(rejected.status).toBe('rejected')
    expect(existsSync(join(projectDir, 'notes', 'new.txt'))).toBe(false)

    // A rejected change can no longer be applied or re-rejected.
    expectInvalid(() => service.applyChange(create.id))
    expectInvalid(() => service.rejectChange(create.id))
    expectInvalid(() => service.applyChange('unknown-change'))
  })
})

describe('CodeService.revertChange', () => {
  it('creates a persistent checkpoint and restores through it', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const edit = service
      .registerProposedChanges(conversation.id, assistantContent)
      .find((c) => c.changeType === 'edit')!

    service.applyChange(edit.id)
    const checkpoint = db!.agentPlatform.checkpointsList(conversation.id)[0]
    expect(checkpoint).toMatchObject({
      changeId: edit.id,
      files: [{ relPath: 'README.md', content: '# Readme\nold line\n' }],
    })
    service.restoreCheckpoint(checkpoint.id)
    expect(readFileSync(join(projectDir, 'README.md'), 'utf8')).toBe('# Readme\nold line\n')
  })

  it('restores an applied edit to its pre-change content', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const edit = service
      .registerProposedChanges(conversation.id, assistantContent)
      .find((c) => c.changeType === 'edit')!

    service.applyChange(edit.id)
    expect(readFileSync(join(projectDir, 'README.md'), 'utf8')).toBe('# Readme\nnew line\n')

    const reverted = service.revertChange(edit.id)
    expect(reverted.status).toBe('reverted')
    expect(readFileSync(join(projectDir, 'README.md'), 'utf8')).toBe('# Readme\nold line\n')

    // A reverted change cannot be reverted (or applied) again.
    expectInvalid(() => service.revertChange(edit.id))
    expectInvalid(() => service.applyChange(edit.id))
  })

  it('reverting an applied create removes the created file', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const create = service
      .registerProposedChanges(conversation.id, assistantContent)
      .find((c) => c.changeType === 'create')!

    service.applyChange(create.id)
    expect(existsSync(join(projectDir, 'notes', 'new.txt'))).toBe(true)

    const reverted = service.revertChange(create.id)
    expect(reverted.status).toBe('reverted')
    expect(existsSync(join(projectDir, 'notes', 'new.txt'))).toBe(false)
  })

  it('reverting an applied delete restores the file content', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const del = service
      .registerProposedChanges(conversation.id, assistantContent)
      .find((c) => c.changeType === 'delete')!

    service.applyChange(del.id)
    expect(existsSync(join(projectDir, 'src', 'app.ts'))).toBe(false)

    const reverted = service.revertChange(del.id)
    expect(reverted.status).toBe('reverted')
    expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf8')).toBe('console.log(1)\n')
  })

  it('refuses to revert when the file diverged after the change was applied', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const edit = service
      .registerProposedChanges(conversation.id, assistantContent)
      .find((c) => c.changeType === 'edit')!

    service.applyChange(edit.id)
    // Someone (or a later change) edits the file after the apply.
    writeFileSync(join(projectDir, 'README.md'), '# Readme\neven newer\n', 'utf8')

    expectInvalid(() => service.revertChange(edit.id), 'changed on disk')
    expect(readFileSync(join(projectDir, 'README.md'), 'utf8')).toBe('# Readme\neven newer\n')
  })

  it('refuses to revert proposed or rejected changes', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const [create, edit] = service.registerProposedChanges(conversation.id, assistantContent)

    expectInvalid(() => service.revertChange(create.id), 'Only applied')
    service.rejectChange(edit.id)
    expectInvalid(() => service.revertChange(edit.id), 'Only applied')
  })
})

describe('CodeService write jail (symlinks)', () => {
  /** Windows without the symlink privilege cannot create one — skip there. */
  function trySymlink(target: string, path: string, type: 'file' | 'junction'): boolean {
    try {
      symlinkSync(target, path, type)
      return true
    } catch {
      return false
    }
  }

  it('refuses to apply a create through a DANGLING symlink leaving the root', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const change = service.proposeChange(conversation.id, 'notes/new.txt', 'create', 'pwned\n')

    // A symlink inside the project pointing at a file that does NOT exist
    // outside it: existsSync() reports it as absent, a plain write follows it.
    const outside = join(baseDir, 'authorized_keys')
    mkdirSync(join(projectDir, 'notes'), { recursive: true })
    if (!trySymlink(outside, join(projectDir, 'notes', 'new.txt'), 'file')) return

    expectInvalid(() => service.applyChange(change.id))
    expect(existsSync(outside)).toBe(false)
  })

  it('refuses to apply a create through a symlinked parent dir, creating no dirs outside', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const change = service.proposeChange(conversation.id, 'notes/deep/x.txt', 'create', 'pwned\n')

    const outsideDir = join(baseDir, 'outside-dir')
    mkdirSync(outsideDir, { recursive: true })
    if (!trySymlink(outsideDir, join(projectDir, 'notes'), 'junction')) return

    expectInvalid(() => service.applyChange(change.id), 'escapes the project root')
    // The old code ran mkdirSync(dirname) BEFORE the containment check.
    expect(existsSync(join(outsideDir, 'deep'))).toBe(false)
    expect(existsSync(join(outsideDir, 'x.txt'))).toBe(false)
  })

  it('refuses to revert a delete through a DANGLING symlink leaving the root', () => {
    const project = openTestProject()
    const conversation = createCodeConversation(project.id)
    const del = service
      .registerProposedChanges(conversation.id, assistantContent)
      .find((c) => c.changeType === 'delete')!

    service.applyChange(del.id)
    expect(existsSync(join(projectDir, 'src', 'app.ts'))).toBe(false)

    // Someone drops a dangling symlink where the deleted file used to be.
    const outside = join(baseDir, 'startup.cmd')
    if (!trySymlink(outside, join(projectDir, 'src', 'app.ts'), 'file')) return

    expectInvalid(() => service.revertChange(del.id))
    expect(existsSync(outside)).toBe(false)
  })
})

describe('CodeService.suggestFiles', () => {
  it('returns matching relative paths, basename matches first', () => {
    const project = openTestProject()
    const hits = service.suggestFiles(project.id, 'app', 10)
    expect(hits).toContain('src/app.ts')
    expect(hits[0]).toBe('src/app.ts')
  })

  it('lists files (capped) for an empty query and never leaks ignored dirs', () => {
    const project = openTestProject()
    const hits = service.suggestFiles(project.id, '', 50)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((p) => p.includes('node_modules'))).toBe(false)
  })

  it('returns [] when nothing matches', () => {
    const project = openTestProject()
    expect(service.suggestFiles(project.id, 'zzz-no-such-file', 10)).toEqual([])
  })
})
