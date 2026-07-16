/**
 * GitHub depth: read-only gh queries (issues, PRs, CI) on GitService via the
 * injected githubCommand seam — argv shaping, validation, caps — plus the
 * 'github' tool and git_write 'pr_review' through the real executor.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ToolApprovalAnswer, ToolCallRecord } from '@shared/types'
import { GitService } from '../../src/main/code/git-service'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { createToolSystem, USER_DECLINED_RESULT } from '../../src/main/tools'

type GhResult = { ok: boolean; stdout: string; stderr: string }

function ghMock(map: (argv: string[]) => GhResult | undefined) {
  const calls: string[][] = []
  const command = vi.fn(async (argv: string[], _root: string): Promise<GhResult> => {
    calls.push(argv)
    return map(argv) ?? { ok: true, stdout: '', stderr: '' }
  })
  return { calls, command }
}

describe('GitService GitHub reads', () => {
  const root = process.cwd() // never actually touched: gh is mocked

  it('listIssues shapes argv, validates state and returns stdout', async () => {
    const gh = ghMock(() => ({ ok: true, stdout: '[{"number":1}]', stderr: '' }))
    const service = new GitService({ githubCommand: gh.command })
    const out = await service.listIssues(root, 'all')
    expect(out).toBe('[{"number":1}]')
    expect(gh.calls[0].slice(0, 5)).toEqual(['issue', 'list', '--state', 'all', '--limit'])
    await expect(
      service.listIssues(root, 'weird' as unknown as 'open')
    ).rejects.toThrow(/state/i)
  })

  it('viewIssue requires a positive integer number (argv smuggling is impossible)', async () => {
    const gh = ghMock(() => ({ ok: true, stdout: '{"number":7}', stderr: '' }))
    const service = new GitService({ githubCommand: gh.command })
    await service.viewIssue(root, 7)
    expect(gh.calls[0][2]).toBe('7')
    await expect(service.viewIssue(root, -1)).rejects.toThrow(/positive/i)
    await expect(service.viewIssue(root, 1.5)).rejects.toThrow(/positive/i)
  })

  it('viewPullRequest/pullRequestDiff omit the number for the current branch', async () => {
    const gh = ghMock(() => ({ ok: true, stdout: 'DIFF', stderr: '' }))
    const service = new GitService({ githubCommand: gh.command })
    await service.viewPullRequest(root)
    expect(gh.calls[0].slice(0, 2)).toEqual(['pr', 'view'])
    expect(gh.calls[0]).not.toContain('undefined')
    await service.pullRequestDiff(root, 12)
    expect(gh.calls[1]).toEqual(['pr', 'diff', '12'])
  })

  it('ciFailedLogs resolves the latest failed run when no id is given', async () => {
    const gh = ghMock((argv) => {
      if (argv[0] === 'run' && argv[1] === 'list') {
        return {
          ok: true,
          stdout:
            '[{"databaseId":11,"conclusion":"success"},{"databaseId":22,"conclusion":"failure"}]',
          stderr: '',
        }
      }
      return { ok: true, stdout: 'the failing log', stderr: '' }
    })
    const service = new GitService({ githubCommand: gh.command })
    const out = await service.ciFailedLogs(root)
    expect(out).toBe('the failing log')
    expect(gh.calls[1]).toEqual(['run', 'view', '22', '--log-failed'])
  })

  it('ciFailedLogs reports when nothing failed', async () => {
    const gh = ghMock(() => ({
      ok: true,
      stdout: '[{"databaseId":11,"conclusion":"success"}]',
      stderr: '',
    }))
    const service = new GitService({ githubCommand: gh.command })
    expect(await service.ciFailedLogs(root)).toMatch(/no failed workflow runs/i)
  })

  it('caps oversized read results', async () => {
    const gh = ghMock(() => ({ ok: true, stdout: 'x'.repeat(100_000), stderr: '' }))
    const service = new GitService({ githubCommand: gh.command })
    const out = await service.pullRequestDiff(root)
    expect(out.length).toBeLessThan(50_000)
    expect(out).toMatch(/truncated/)
  })

  it('surfaces a clear error when gh fails', async () => {
    const gh = ghMock(() => ({ ok: false, stdout: '', stderr: 'not logged in' }))
    const service = new GitService({ githubCommand: gh.command })
    await expect(service.listIssues(root)).rejects.toThrow(/GitHub CLI failed: not logged in/)
  })

  it('reviewPullRequest maps events to flags and requires a body except for approve', async () => {
    const gh = ghMock(() => ({ ok: true, stdout: '', stderr: '' }))
    const service = new GitService({ githubCommand: gh.command })

    const posted = await service.reviewPullRequest(root, {
      number: 5,
      event: 'request_changes',
      body: 'Please fix the tests.',
    })
    expect(posted).toMatch(/request changes review on PR #5/)
    expect(gh.calls[0]).toEqual([
      'pr', 'review', '5', '--request-changes', '--body', 'Please fix the tests.',
    ])

    await service.reviewPullRequest(root, { event: 'approve' })
    expect(gh.calls[1]).toEqual(['pr', 'review', '--approve'])

    await expect(service.reviewPullRequest(root, { event: 'comment' })).rejects.toThrow(/body/i)
    await expect(
      service.reviewPullRequest(root, { event: 'nope' as 'comment', body: 'x' })
    ).rejects.toThrow(/event/i)
  })
})

describe('github tool + git_write pr_review through the executor', () => {
  let dir: string
  let db: AppDatabase
  let projectId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uld-github-'))
    db = openDatabase(join(dir, 'app.db'))
    const projectDir = join(dir, 'project')
    mkdirSync(projectDir, { recursive: true })
    projectId = db.code.projectUpsertByPath(projectDir, 'project').id
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function conv(): Conversation {
    return {
      id: 'conv-gh',
      mode: 'work',
      title: 'GH',
      providerId: null,
      modelId: null,
      systemPrompt: null,
      params: {},
      workspaceId: null,
      projectId,
      projectRef: null,
      moaPresetId: null,
      createdAt: 0,
      updatedAt: 0,
    }
  }

  function call(name: string, args: unknown): ToolCallRecord {
    return { id: 'tc-gh', name, arguments: JSON.stringify(args), status: 'proposed' }
  }

  const APPROVE: ToolApprovalAnswer = { approved: true, scope: 'once' }
  const DECLINE: ToolApprovalAnswer = { approved: false, scope: 'once' }

  it('routes github actions to the dep after approval (sensitive risk asks)', async () => {
    const gitHub = {
      listIssues: vi.fn(async () => '[]'),
      viewIssue: vi.fn(async () => '{}'),
      viewPullRequest: vi.fn(async () => '{}'),
      pullRequestDiff: vi.fn(async () => 'diff'),
      listCiRuns: vi.fn(async () => '[]'),
      ciFailedLogs: vi.fn(async () => 'logs'),
    }
    const { executor } = createToolSystem(db, null, { gitHub })
    const approval = vi.fn(async () => APPROVE)

    const issues = await executor.execute(call('github', { action: 'list_issues' }), {
      conversation: conv(),
      approval,
    })
    expect(approval).toHaveBeenCalledTimes(1)
    expect(issues).toBe('[]')
    expect(gitHub.listIssues).toHaveBeenCalledWith(expect.any(String), 'open')

    const logs = await executor.execute(
      call('github', { action: 'ci_failed_logs', run_id: 42 }),
      { conversation: conv(), approval }
    )
    expect(logs).toBe('logs')
    expect(gitHub.ciFailedLogs).toHaveBeenCalledWith(expect.any(String), 42)

    const missing = await executor.execute(call('github', { action: 'view_issue' }), {
      conversation: conv(),
      approval,
    })
    expect(missing).toMatch(/'number'.*required/i)
    expect(gitHub.viewIssue).not.toHaveBeenCalled()
  })

  it('github is read-only: allowed in plan mode and read-only sandbox', async () => {
    const gitHub = {
      listIssues: vi.fn(async () => '[]'),
      viewIssue: vi.fn(async () => '{}'),
      viewPullRequest: vi.fn(async () => '{}'),
      pullRequestDiff: vi.fn(async () => 'diff'),
      listCiRuns: vi.fn(async () => '[]'),
      ciFailedLogs: vi.fn(async () => 'logs'),
    }
    const { executor } = createToolSystem(db, null, { gitHub })
    const out = await executor.execute(call('github', { action: 'ci_runs' }), {
      conversation: conv(),
      approval: vi.fn(async () => APPROVE),
      planMode: true,
      sandboxLevel: 'read-only',
    })
    expect(out).toBe('[]')
  })

  it('pr_review goes through git_write with a fresh approval and a clear note', async () => {
    const reviewPullRequest = vi.fn(async () => 'Posted a comment review on PR #3.')
    const gitWrite = {
      status: vi.fn(),
      stage: vi.fn(),
      commit: vi.fn(),
      createBranch: vi.fn(),
      setOrigin: vi.fn(),
      fetch: vi.fn(),
      pull: vi.fn(),
      push: vi.fn(),
      createPullRequest: vi.fn(),
      reviewPullRequest,
    }
    const { executor } = createToolSystem(db, null, {
      gitWrite: gitWrite as never,
    })
    const approvals: string[] = []
    const approval = vi.fn(async (req: { note?: string }) => {
      approvals.push(req.note ?? '')
      return APPROVE
    })
    const out = await executor.execute(
      call('git_write', {
        action: 'pr_review',
        review_event: 'comment',
        number: 3,
        body: 'Looks good overall.',
      }),
      { conversation: conv(), approval: approval as never }
    )
    expect(out).toBe('Posted a comment review on PR #3.')
    expect(reviewPullRequest).toHaveBeenCalledWith(expect.any(String), {
      event: 'comment',
      number: 3,
      body: 'Looks good overall.',
    })
    expect(approvals[0]).toMatch(/comment review on PR #3/)

    const declined = await executor.execute(
      call('git_write', { action: 'pr_review', review_event: 'approve' }),
      { conversation: conv(), approval: vi.fn(async () => DECLINE) }
    )
    expect(declined).toBe(USER_DECLINED_RESULT)

    const badEvent = await executor.execute(
      call('git_write', { action: 'pr_review', review_event: 'meh' }),
      { conversation: conv(), approval: vi.fn(async () => APPROVE) }
    )
    expect(badEvent).toMatch(/review_event/)
  })
})
