/**
 * git_write through the REAL registry + executor with a recording gitWrite
 * dep: the always-ask discipline (noStandingApproval defeats conversation
 * grants and auto-accept-edits), the main-computed approval note, plan-mode
 * refusal, and the default-branch commit guard.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, GitStatus, ToolApprovalRequest, ToolCallRecord } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../../src/main/db/database'
import { CodeService } from '../../../src/main/code/code-service'
import { createToolSystem, USER_DECLINED_RESULT } from '../../../src/main/tools'

let dir: string
let db: AppDatabase
let projectId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-gitwrite-'))
  db = openDatabase(join(dir, 'app.db'))
  const projectDir = join(dir, 'project')
  mkdirSync(projectDir, { recursive: true })
  projectId = db.code.projectUpsertByPath(projectDir, 'project').id
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function conv(planMode = false): Conversation {
  return {
    id: 'conv-git',
    mode: 'code',
    title: 'Git',
    providerId: null,
    modelId: null,
    systemPrompt: null,
    params: planMode ? { planMode: true } : {},
    workspaceId: null,
    projectId,
    projectRef: null,
    moaPresetId: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

function call(args: unknown): ToolCallRecord {
  return { id: 'tc-git', name: 'git_write', arguments: JSON.stringify(args), status: 'proposed' }
}

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: true,
    branch: 'feature-x',
    defaultBranch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    staged: [
      { path: 'a.ts', status: 'M' },
      { path: 'b.ts', status: 'A' },
    ],
    unstaged: [],
    untracked: [],
    ...overrides,
  }
}

function makeSystem(currentStatus: GitStatus) {
  const stage = vi.fn(async () => 'Staged 2 files.')
  const commit = vi.fn(async () => ({ sha: 'abc1234', branch: currentStatus.branch }))
  const createBranch = vi.fn(async (_root: string, name: string) => `Created and switched to branch '${name}'.`)
  const system = createToolSystem(db, null, {
    gitWrite: { status: async () => currentStatus, stage, commit, createBranch },
  })
  return { ...system, stage, commit, createBranch }
}

const APPROVE = { approved: true, scope: 'once' as const }

describe('git_write — always-ask discipline', () => {
  it("risk 'dangerous' => approval requested with a main-computed note", async () => {
    const { executor, commit } = makeSystem(status())
    const approval = vi.fn(async (req: Omit<ToolApprovalRequest, 'requestId'>) => {
      expect(req.risk).toBe('dangerous')
      expect(req.note).toContain('Commits 2 staged files')
      expect(req.note).toContain("branch 'feature-x'")
      expect(req.note).not.toContain('DEFAULT')
      return APPROVE
    })
    const result = await executor.execute(call({ action: 'commit', message: 'feat: x' }), {
      conversation: conv(),
      approval,
    })
    expect(approval).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(expect.any(String), 'feat: x')
    expect(result).toContain('Committed abc1234')
  })

  it('the note flags the DEFAULT branch and the guard refuses without confirm_default_branch', async () => {
    const { executor, commit } = makeSystem(status({ branch: 'main' }))
    const approval = vi.fn(async (req: Omit<ToolApprovalRequest, 'requestId'>) => {
      expect(req.note).toContain('DEFAULT')
      return APPROVE
    })
    const refused = await executor.execute(call({ action: 'commit', message: 'x' }), {
      conversation: conv(),
      approval,
    })
    expect(refused).toContain('Refused')
    expect(refused).toContain('default branch')
    expect(commit).not.toHaveBeenCalled()

    const allowed = await executor.execute(
      call({ action: 'commit', message: 'x', confirm_default_branch: true }),
      { conversation: conv(), approval }
    )
    expect(allowed).toContain('Committed')
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it("a 'conversation'-scope approval never becomes a standing grant", async () => {
    const { executor } = makeSystem(status())
    const approval = vi.fn(async () => ({ approved: true, scope: 'conversation' as const }))

    await executor.execute(call({ action: 'create_branch', branch: 'grasberg/t1' }), {
      conversation: conv(),
      approval,
    })
    await executor.execute(call({ action: 'create_branch', branch: 'grasberg/t2' }), {
      conversation: conv(),
      approval,
    })
    // Both calls asked — noStandingApproval defeats the conversation grant.
    expect(approval).toHaveBeenCalledTimes(2)
  })

  it('auto-accept-edits does not cover git_write', async () => {
    const { executor } = makeSystem(status())
    const approval = vi.fn(async () => APPROVE)
    await executor.execute(call({ action: 'stage', paths: ['a.ts'] }), {
      conversation: conv(),
      approval,
      autoAcceptEdits: true,
    })
    expect(approval).toHaveBeenCalledTimes(1)
  })

  it('declined => standard note, and the git dep is never touched', async () => {
    const { executor, stage, commit, createBranch } = makeSystem(status())
    const result = await executor.execute(call({ action: 'stage', paths: ['a.ts'] }), {
      conversation: conv(),
      approval: vi.fn(async () => ({ approved: false, scope: 'once' as const })),
    })
    expect(result).toBe(USER_DECLINED_RESULT)
    expect(stage).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(createBranch).not.toHaveBeenCalled()
  })

  it('plan mode refuses git_write outright (mutating)', async () => {
    const { executor, stage } = makeSystem(status())
    const approval = vi.fn(async () => APPROVE)
    // ctx.planMode is what the chat service passes for a plan-mode code
    // conversation — the executor gates on it, not on conversation.params.
    const result = await executor.execute(call({ action: 'stage', paths: ['a.ts'] }), {
      conversation: conv(true),
      approval,
      planMode: true,
    })
    expect(result).toMatch(/plan mode/i)
    expect(approval).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
  })

  it('validates action and arguments', async () => {
    const { executor } = makeSystem(status())
    const approval = vi.fn(async () => APPROVE)
    expect(
      await executor.execute(call({ action: 'push' }), { conversation: conv(), approval })
    ).toContain("'action' must be one of")
    expect(
      await executor.execute(call({ action: 'stage', paths: [] }), {
        conversation: conv(),
        approval,
      })
    ).toContain("'paths' must be a non-empty array")
    expect(
      await executor.execute(call({ action: 'commit' }), { conversation: conv(), approval })
    ).toContain("'message' must be a non-empty string")
  })

  it('reports unavailable without a granted project or the dep', async () => {
    const { executor } = makeSystem(status())
    const noProject = { ...conv(), projectId: null }
    const result = await executor.execute(call({ action: 'stage', paths: ['a.ts'] }), {
      conversation: noProject,
      approval: vi.fn(async () => APPROVE),
    })
    expect(result).toContain('no project folder')

    const { executor: bare } = createToolSystem(db) // no gitWrite dep
    const result2 = await bare.execute(call({ action: 'stage', paths: ['a.ts'] }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
    })
    expect(result2).toContain('unavailable')
  })
})

describe('review queue backend', () => {
  it('listChangesWithContext joins conversation titles and notify fires on propose', () => {
    const notifications: string[] = []
    const conversation = db.conversations.create({
      mode: 'code',
      title: 'Fix the parser',
      projectId,
    })
    const service = new CodeService(db, (pid: string) => notifications.push(pid))

    service.proposeChange(conversation.id, 'src/parser.ts', 'create', 'export {}\n')
    expect(notifications).toEqual([projectId])

    const listed = service.listChangesWithContext(projectId)
    expect(listed).toHaveLength(1)
    expect(listed[0].conversationTitle).toBe('Fix the parser')
    expect(listed[0].filePath).toBe('src/parser.ts')
  })
})
