/**
 * Code Arena: run the SAME task on N models in parallel, each in its own
 * isolated git worktree, then show the diffs side by side and apply the
 * winner's changes to the real project through the audited change pipeline
 * (CodeChange rows -> Changes panel, revertable per file).
 *
 * Reuses the existing plumbing end to end:
 * - GitService.createWorktree/captureWorktreeDiff/removeWorktree (app-owned
 *   worktrees under {userData}/data/worktrees)
 * - CodeService.openProject registers each worktree as a code_projects row,
 *   so the tool loop's path jail confines every candidate to ITS copy
 * - ChatService.generateForWorkflow runs each candidate headlessly with the
 *   file tools pre-approved (writes land in the candidate's worktree only)
 * - db.agentPlatform run rows make candidates visible (and stoppable) in the
 *   Agent Control Center and the Home inbox
 *
 * Arena metadata itself is in-memory: a restart loses the side-by-side view
 * (the worktrees and agent_runs rows survive; Discard is best-effort cleanup).
 */

import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import type {
  ArenaCandidateState,
  ArenaStartRequest,
  ArenaState,
  GitFileChange,
} from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { ProviderError } from '../providers/errors'
import { looksBinary } from '../utils/binary'

const SUMMARY_MAX_CHARS = 4_000
const APPLY_FILE_MAX_BYTES = 1024 * 1024
const ARENA_TOOL_IDS = [
  'read_file',
  'list_directory',
  'grep',
  'glob',
  'file_search',
  'repo_map',
  'edit_file',
  'write_file',
]
/** Hard bounds on evolutionary rounds (1 = classic single-round arena). */
export const ARENA_MIN_ROUNDS = 1
export const ARENA_MAX_ROUNDS = 5
/** Diff material handed to the judge per candidate. */
const JUDGE_DIFF_CHARS = 6_000

function invalid(message: string): ProviderError {
  return new ProviderError('invalid_request', message)
}

/** The candidate prompt: autonomous, no questions, summary at the end. */
export function arenaPrompt(task: string): string {
  return (
    'You are one of several models given the SAME task on identical, isolated copies of a ' +
    'repository. The user will compare the resulting diffs side by side and apply ONE. ' +
    'Work autonomously: investigate with the read tools (read_file, grep, glob, repo_map), ' +
    'then implement the change with edit_file/write_file. Never ask questions — decide and act. ' +
    'Keep the change focused on the task. End your reply with a short summary of what you ' +
    'changed and why.\n\nTask:\n' +
    task
  )
}

/** Round > 1 prompt: improve on the judged winner of the previous round. */
export function arenaRoundPrompt(
  task: string,
  round: number,
  parentSummary: string,
  parentDiffStat: string
): string {
  return (
    `You are one of several models improving on the WINNING solution from round ${round - 1} ` +
    'of an evolution arena. Your worktree already contains that winning state — build on it; ' +
    'do not undo it unless it is wrong. The same evaluation criteria apply: correctness and ' +
    'focus beat volume.\n\n' +
    `Original task:\n${task}\n\n` +
    `What the previous winner did:\n${parentSummary.slice(0, SUMMARY_MAX_CHARS)}\n` +
    (parentDiffStat ? `\nIts changed files:\n${parentDiffStat}\n` : '') +
    '\nYour job: make this solution BETTER (fix gaps vs the original task, harden edge cases, ' +
    'improve quality), then end with a short summary of your additional changes.'
  )
}

/**
 * Judge output parsing: expects a JSON object with a 1-based winning candidate
 * index. Falls back to null so the caller can keep the previous winner (or
 * skip seeding) rather than guessing.
 */
export function parseJudgeWinner(
  text: string,
  candidateCount: number
): { index: number; reason: string } | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const raw = record.winnerIndex ?? record.winner ?? record.index
    const index = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(String(raw), 10)
    if (!Number.isFinite(index) || index < 1 || index > candidateCount) return null
    const reason = typeof record.reason === 'string' ? record.reason : ''
    return { index, reason }
  } catch {
    return null
  }
}

/** The judge prompt: pick ONE winner among the round's diffs. */
export function arenaJudgePrompt(
  task: string,
  candidates: Array<{ label: string; summary: string; diffStat: string; diff: string }>
): string {
  const parts = [
    'You are judging a code arena. Given the ORIGINAL TASK and each candidate model\'s ' +
      'summary plus diff, pick exactly ONE winner that best fulfills the task. Favor ' +
      'correctness and completeness over size of the diff. Answer ONLY with JSON:',
    '{"winnerIndex": <1-based number>, "reason": "<one sentence>"}',
    '',
    `TASK:\n${task}`,
  ]
  candidates.forEach((candidate, i) => {
    parts.push(
      '',
      `--- CANDIDATE ${i + 1} (${candidate.label}) ---`,
      `Summary: ${candidate.summary.slice(0, 2_000)}`,
      candidate.diffStat ? `Files:\n${candidate.diffStat}` : '(no file changes)',
      candidate.diff ? `Diff (truncated):\n${candidate.diff.slice(0, JUDGE_DIFF_CHARS)}` : ''
    )
  })
  return parts.join('\n')
}

/**
 * Seeds a fresh round-N worktree from the previous winner by replaying exactly
 * the winner's changed paths, including deletions and renames.
 */
export function seedWorktreeFromParent(
  parentPath: string,
  targetPath: string,
  files: GitFileChange[]
): { seeded: number } {
  let seeded = 0
  for (const file of files) {
    const removedPath = file.status === 'R' ? file.oldPath : file.status === 'D' ? file.path : null
    if (removedPath) {
      const removed = resolveInsideRoot(targetPath, removedPath)
      if (removed && existsSync(removed)) {
        try {
          unlinkSync(removed)
          seeded += 1
        } catch {
          // Best-effort seeding; generation can repair an unusual path.
        }
      }
    }
    if (file.status === 'D') continue
    const src = resolveInsideRoot(parentPath, file.path)
    const dest = resolveInsideRoot(targetPath, file.path)
    if (!src || !dest || !existsSync(src)) continue
    try {
      const stat = statSync(src)
      if (!stat.isFile() || stat.size > APPLY_FILE_MAX_BYTES || looksBinary(readFileSync(src))) {
        continue
      }
      mkdirSync(path.dirname(dest), { recursive: true })
      copyFileSync(src, dest)
      seeded += 1
    } catch {
      // Unreadable file — skip it rather than fail the whole seeding.
    }
  }
  return { seeded }
}

/** Resolves relPath inside root, or null when it escapes. */
export function resolveInsideRoot(root: string, relPath: string): string | null {
  if (relPath.includes('\0') || path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    return null
  }
  const base = path.resolve(root)
  const target = path.resolve(base, relPath)
  const rel = path.relative(base, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return target
}


interface ArenaGitPort {
  createWorktree(
    root: string,
    worktreesDir: string,
    projectId: string,
    requestedName?: string
  ): Promise<{ path: string; branch: string; projectId: string }>
  captureWorktreeDiff(
    worktreeRoot: string
  ): Promise<{ stat: string; diff: string; files: GitFileChange[] }>
  removeWorktree(mainRoot: string, worktreePath: string, branch: string): Promise<void>
}

interface ArenaCodePort {
  openProject(path: string): { id: string }
  proposeChange(
    conversationId: string,
    relPath: string,
    changeType: 'create' | 'edit' | 'delete',
    newContent?: string
  ): { id: string }
  applyChangesAtomically(changeIds: string[]): unknown
}

export interface ArenaServiceDeps {
  db: {
    conversations: { getById(id: string): { id: string; projectId: string | null } | null }
    code: { projectGetById(id: string): { id: string; path: string } | null }
    providers: { getById(id: string): { id: string; label: string } | null }
    agentPlatform: {
      runStart(input: {
        conversationId: string | null
        projectId: string | null
        agentName: string | null
        agentId: string | null
        task: string
        worktreePath: string | null
        providerId: string | null
        modelId: string | null
      }): { id: string }
      runFinish(id: string, status: 'done' | 'error' | 'stopped', result: string): unknown
    }
  }
  git: ArenaGitPort
  code: ArenaCodePort
  worktreesDir: string
  broadcast: (channel: string, payload: unknown) => void
  /** Wired to ChatService.generateForWorkflow (headless tool loop). */
  generate: (
    prompt: string,
    providerId: string | undefined,
    modelId: string | undefined,
    opts: {
      useTools: boolean
      approvedToolIds: string[]
      projectId: string
      signal?: AbortSignal
      json?: boolean
      /** Spend attribution: arena runs bill the owning conversation (v44). */
      usage?: { runKind: 'arena'; refId: string }
    }
  ) => Promise<string>
}

interface ArenaInternal {
  state: ArenaState
  controller: AbortController
  /** Worktree project ids per runId (candidates are jailed to these). */
  worktreeProjects: Map<string, string>
  mainRoot: string
}

export class ArenaService {
  private readonly arenas = new Map<string, ArenaInternal>() // by conversationId

  constructor(private readonly deps: ArenaServiceDeps) {}

  /** The conversation's current arena (renderer polls once, then push). */
  status(conversationId: string): ArenaState | null {
    return this.arenas.get(conversationId)?.state ?? null
  }

  async start(request: ArenaStartRequest): Promise<ArenaState> {
    const existing = this.arenas.get(request.conversationId)
    if (existing && existing.state.status === 'running') {
      throw invalid('An arena is already running for this task. Stop or discard it first.')
    }
    const conversation = this.deps.db.conversations.getById(request.conversationId)
    if (!conversation) throw invalid('Conversation not found.')
    if (!conversation.projectId) {
      throw invalid('Connect a folder to this task before starting an arena.')
    }
    const project = this.deps.db.code.projectGetById(conversation.projectId)
    if (!project) throw invalid('The granted project folder no longer exists.')
    if (request.candidates.length < 2 || request.candidates.length > 4) {
      throw invalid('An arena needs 2–4 candidate models.')
    }
    const totalRounds = Math.min(
      Math.max(Math.trunc(request.rounds ?? 1), ARENA_MIN_ROUNDS),
      ARENA_MAX_ROUNDS
    )

    const controller = new AbortController()
    const candidates: ArenaCandidateState[] = []
    const worktreeProjects = new Map<string, string>()

    try {
      for (const [index, ref] of request.candidates.entries()) {
        const created = await this.createCandidate(
          project.id,
          project.path,
          request.conversationId,
          request.task,
          ref,
          index,
          1,
          null
        )
        worktreeProjects.set(created.candidate.runId, created.worktreeProjectId)
        candidates.push(created.candidate)
      }
    } catch (error) {
      await Promise.allSettled(candidates.map((candidate) => this.cleanupCandidate(project.path, candidate)))
      throw error
    }

    const arena: ArenaInternal = {
      state: {
        id: randomUUID(),
        conversationId: request.conversationId,
        projectId: project.id,
        task: request.task,
        status: 'running',
        candidates,
        appliedRunId: null,
        createdAt: Date.now(),
        totalRounds,
        round: 1,
        winnerRunId: null,
      },
      controller,
      worktreeProjects,
      mainRoot: project.path,
    }
    this.arenas.set(request.conversationId, arena)
    this.push(arena)

    // Fan out WITHOUT awaiting: rounds stream forward independently.
    void this.runRounds(arena, project.path, request.candidates)

    return arena.state
  }

  /** Creates one candidate's worktree + agent_runs row for a given round. */
  private async createCandidate(
    projectId: string,
    projectPath: string,
    conversationId: string,
    task: string,
    ref: { providerId: string; modelId: string },
    index: number,
    round: number,
    parentRunId: string | null
  ): Promise<{ candidate: ArenaCandidateState; worktreeProjectId: string }> {
    const provider = this.deps.db.providers.getById(ref.providerId)
    const safeModel = ref.modelId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 24)
    const worktree = await this.deps.git.createWorktree(
      projectPath,
      this.deps.worktreesDir,
      projectId,
      `arena-r${round}-${index + 1}-${safeModel}`
    )
    let runId: string | null = null
    try {
      const worktreeProject = this.deps.code.openProject(worktree.path)
      const run = this.deps.db.agentPlatform.runStart({
        conversationId,
        projectId: worktreeProject.id,
        agentName: `arena-r${round}`,
        agentId: null,
        task,
        worktreePath: worktree.path,
        providerId: ref.providerId,
        modelId: ref.modelId,
      })
      runId = run.id
      return {
        worktreeProjectId: worktreeProject.id,
        candidate: {
          runId: run.id,
          providerId: ref.providerId,
          modelId: ref.modelId,
          providerLabel: provider?.label ?? ref.providerId,
          worktreePath: worktree.path,
          branch: worktree.branch,
          status: 'running',
          summary: '',
          diffStat: '',
          diff: '',
          changedFiles: [],
          round,
          parentRunId,
        },
      }
    } catch (error) {
      if (runId) this.deps.db.agentPlatform.runFinish(runId, 'error', 'Candidate setup failed.')
      await this.removeCandidateWorktree(projectPath, worktree.path, worktree.branch)
      throw error
    }
  }

  /**
   * Evolutionary loop (AVO-style): run the round's candidates in parallel,
   * judge the diffs, seed the next round from the winner's tree.
   */
  private async runRounds(
    arena: ArenaInternal,
    projectPath: string,
    refs: Array<{ providerId: string; modelId: string }>
  ): Promise<void> {
    try {
      while (arena.state.round <= arena.state.totalRounds) {
        if (arena.controller.signal.aborted) break
        const currentRound = arena.state.round
        const contenders = arena.state.candidates.filter((c) => c.round === currentRound)
        await Promise.allSettled(contenders.map((candidate) => this.runCandidate(arena, candidate)))
        if (arena.controller.signal.aborted) break

        // Single-round arenas keep the classic human-picks flow.
        if (arena.state.totalRounds === 1 || currentRound === arena.state.totalRounds) {
          arena.state.status = 'finished'
          break
        }

        const winner = await this.judgeRound(arena, contenders)
        if (!winner || arena.controller.signal.aborted) {
          // No verdict -> stop evolving gracefully; everything stays reviewable.
          arena.state.status = 'finished'
          break
        }
        arena.state.winnerRunId = winner.runId
        arena.state.round = currentRound + 1
        this.push(arena)

        // Fresh worktrees per candidate, seeded with the winner's diff. They
        // carry round currentRound+1 and run on the loop's NEXT allSettled
        // pass (line 392) — deliberately not awaited here. Running them in this
        // iteration too would double every evolutionary round: generate twice,
        // re-prompt against an already-edited tree, and finish each agent_run
        // row twice.
        const nextRound: ArenaCandidateState[] = []
        try {
          for (const [index, ref] of refs.entries()) {
            if (arena.controller.signal.aborted) break
            const created = await this.createCandidate(
              arena.state.projectId,
              projectPath,
              arena.state.conversationId,
              arena.state.task,
              ref,
              index,
              currentRound + 1,
              winner.runId
            )
            try {
              seedWorktreeFromParent(
                winner.worktreePath,
                created.candidate.worktreePath,
                winner.changedFiles
              )
            } catch {
              // Seeding is best-effort: an unseeded candidate still runs on HEAD.
            }
            arena.worktreeProjects.set(created.candidate.runId, created.worktreeProjectId)
            arena.state.candidates.push(created.candidate)
            nextRound.push(created.candidate)
          }
        } catch (error) {
          await Promise.allSettled(
            nextRound.map((candidate) => this.cleanupCandidate(projectPath, candidate))
          )
          throw error
        }
      }
    } finally {
      if (arena.state.status === 'running') arena.state.status = 'finished'
      this.push(arena)
    }
  }

  /**
   * LLM-as-judge over one finished round's diffs. Null when judging fails or
   * the model returns garbage — the arena then simply stops evolving instead
   * of guessing a winner.
   */
  private async judgeRound(
    arena: ArenaInternal,
    contenders: ArenaCandidateState[]
  ): Promise<ArenaCandidateState | null> {
    const done = contenders.filter((c) => c.status === 'done')
    if (done.length < 2) return null
    try {
      const text = await this.deps.generate(
        arenaJudgePrompt(
          arena.state.task,
          done.map((c) => ({
            label: `${c.providerLabel} / ${c.modelId}`,
            summary: c.summary,
            diffStat: c.diffStat,
            diff: c.diff,
          }))
        ),
        undefined,
        undefined,
        {
          useTools: false,
          approvedToolIds: [],
          projectId: '',
          json: true,
          signal: arena.controller.signal,
          // Judging spend is arena spend too.
          usage: { runKind: 'arena', refId: arena.state.conversationId },
        }
      )
      const verdict = parseJudgeWinner(text, done.length)
      if (!verdict) return null
      return done[verdict.index - 1] ?? null
    } catch {
      return null
    }
  }

  /** Aborts every still-running candidate (their runs settle as 'stopped'). */
  stop(conversationId: string): ArenaState | null {
    const arena = this.arenas.get(conversationId)
    if (!arena) return null
    arena.controller.abort()
    return arena.state
  }

  /**
   * Applies the winner's changed files onto the REAL project through the
   * audited CodeChange pipeline (propose + apply per file), so every file
   * shows up in the Changes panel and stays individually revertable.
   */
  async apply(conversationId: string, runId: string): Promise<ArenaState> {
    const arena = this.arenas.get(conversationId)
    if (!arena) throw invalid('No arena exists for this task.')
    const candidate = arena.state.candidates.find((c) => c.runId === runId)
    if (!candidate) throw invalid('Unknown arena candidate.')
    if (candidate.status !== 'done') throw invalid('Only a finished candidate can be applied.')
    if (arena.state.appliedRunId) throw invalid('A candidate has already been applied.')

    // Applying commits the outcome — stop any still-running evolutionary rounds
    // so the loop doesn't keep judging, seeding and generating (burning tokens)
    // for an arena whose winner is already chosen.
    if (arena.state.status === 'running') arena.controller.abort()

    const skipped: string[] = []
    const planned: Array<{
      path: string
      changeType: 'create' | 'edit' | 'delete'
      content?: string
    }> = []
    for (const file of candidate.changedFiles) {
      if (file.status === 'D') {
        planned.push({ path: file.path, changeType: 'delete' })
        continue
      }
      const abs = this.resolveInWorktree(candidate.worktreePath, file.path)
      if (!abs || !existsSync(abs)) {
        if (file.status === 'R') {
          throw invalid(`Cannot apply rename: replacement '${file.path}' is not readable.`)
        }
        skipped.push(`${file.path} (not readable in the worktree)`)
        continue
      }
      const buffer = readFileSync(abs)
      if (buffer.byteLength > APPLY_FILE_MAX_BYTES || looksBinary(buffer)) {
        if (file.status === 'R') {
          throw invalid(`Cannot apply rename: replacement '${file.path}' is binary or too large.`)
        }
        skipped.push(`${file.path} (binary or too large for the change pipeline)`)
        continue
      }
      const targetAbs = path.join(arena.mainRoot, file.path)
      const changeType: 'create' | 'edit' = existsSync(targetAbs) ? 'edit' : 'create'
      // A rename is one indivisible logical operation: validate its
      // replacement before the old path can even be proposed for deletion.
      if (file.status === 'R') {
        if (!file.oldPath) {
          throw invalid(`Cannot apply rename for '${file.path}': source path is missing.`)
        }
        planned.push({ path: file.oldPath, changeType: 'delete' })
      }
      planned.push({ path: file.path, changeType, content: buffer.toString('utf8') })
    }
    if (planned.length === 0 && skipped.length === 0) {
      throw invalid('The chosen candidate has no changes to apply.')
    }

    // Propose only after the whole candidate has been preflighted, so a bad
    // rename cannot leave a standalone delete proposal behind.
    const changeIds = planned.map(
      (change) =>
        this.deps.code.proposeChange(
          conversationId,
          change.path,
          change.changeType,
          change.content
        ).id
    )
    if (changeIds.length > 0) this.deps.code.applyChangesAtomically(changeIds)

    arena.state.appliedRunId = runId
    arena.state.status = 'applied'
    candidate.summary = skipped.length
      ? `${candidate.summary}\n\nApplied ${changeIds.length} change(s); skipped: ${skipped.join(', ')}`
      : candidate.summary
    this.push(arena)
    return arena.state
  }

  /** Removes every candidate worktree (path-prefix-checked) and the arena. */
  async discard(conversationId: string): Promise<void> {
    const arena = this.arenas.get(conversationId)
    if (!arena) return
    arena.controller.abort()
    const worktreesRoot = path.resolve(this.deps.worktreesDir)
    for (const candidate of arena.state.candidates) {
      const resolved = path.resolve(candidate.worktreePath)
      // The ONLY folders the arena ever deletes are the worktrees it created
      // beneath the app-owned worktrees directory. Same rule as workspaces.
      const rel = path.relative(worktreesRoot, resolved)
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue
      try {
        await this.deps.git.removeWorktree(arena.mainRoot, resolved, candidate.branch)
      } catch {
        // Best-effort cleanup; a locked file must not strand the arena state.
      }
    }
    arena.state.status = 'discarded'
    this.push(arena)
    this.arenas.delete(conversationId)
  }

  /** App shutdown: abort all running candidates (worktrees stay for reattach). */
  stopAll(): void {
    for (const arena of this.arenas.values()) arena.controller.abort()
  }

  private async runCandidate(
    arena: ArenaInternal,
    candidate: ArenaCandidateState
  ): Promise<void> {
    const projectId = arena.worktreeProjects.get(candidate.runId)
    const parent =
      candidate.parentRunId !== null
        ? arena.state.candidates.find((c) => c.runId === candidate.parentRunId)
        : undefined
    const prompt =
      parent && candidate.round > 1
        ? arenaRoundPrompt(arena.state.task, candidate.round, parent.summary, parent.diffStat)
        : arenaPrompt(arena.state.task)
    try {
      const text = await this.deps.generate(
        prompt,
        candidate.providerId,
        candidate.modelId,
        {
          useTools: true,
          approvedToolIds: ARENA_TOOL_IDS,
          projectId: projectId ?? '',
          signal: arena.controller.signal,
          usage: { runKind: 'arena', refId: arena.state.conversationId },
        }
      )
      candidate.summary = text.trim().slice(0, SUMMARY_MAX_CHARS)
      candidate.status = 'done'
      this.deps.db.agentPlatform.runFinish(candidate.runId, 'done', candidate.summary)
    } catch (e) {
      const aborted = arena.controller.signal.aborted
      candidate.status = aborted ? 'stopped' : 'error'
      candidate.summary = e instanceof Error ? e.message : String(e)
      this.deps.db.agentPlatform.runFinish(
        candidate.runId,
        aborted ? 'stopped' : 'error',
        candidate.summary
      )
    }
    // Capture whatever landed in the worktree — even a stopped/failed run may
    // hold a partial diff worth seeing.
    try {
      const captured = await this.deps.git.captureWorktreeDiff(candidate.worktreePath)
      candidate.diffStat = captured.stat
      candidate.diff = captured.diff
      candidate.changedFiles = captured.files
    } catch {
      // Diff capture is cosmetic; the run result stands either way.
    }
    this.push(arena)
  }

  private async cleanupCandidate(mainRoot: string, candidate: ArenaCandidateState): Promise<void> {
    candidate.status = 'stopped'
    candidate.summary = 'Candidate setup was rolled back.'
    this.deps.db.agentPlatform.runFinish(
      candidate.runId,
      'stopped',
      'Candidate setup was rolled back.'
    )
    await this.removeCandidateWorktree(mainRoot, candidate.worktreePath, candidate.branch)
  }

  private async removeCandidateWorktree(
    mainRoot: string,
    worktreePath: string,
    branch: string
  ): Promise<void> {
    const worktreesRoot = path.resolve(this.deps.worktreesDir)
    const resolved = path.resolve(worktreePath)
    const rel = path.relative(worktreesRoot, resolved)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return
    try {
      await this.deps.git.removeWorktree(mainRoot, resolved, branch)
    } catch {
      // Cleanup is best-effort; never broaden the deletion target.
    }
  }

  private resolveInWorktree(worktreeRoot: string, relPath: string): string | null {
    return resolveInsideRoot(worktreeRoot, relPath)
  }

  private push(arena: ArenaInternal): void {
    this.deps.broadcast(CHANNELS.arenaChanged, { arena: arena.state })
  }
}
