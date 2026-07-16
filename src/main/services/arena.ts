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
import { existsSync, readFileSync } from 'node:fs'
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
    changeType: 'create' | 'edit',
    newContent: string
  ): { id: string }
  applyChange(changeId: string): unknown
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
    providerId: string,
    modelId: string,
    opts: {
      useTools: boolean
      approvedToolIds: string[]
      projectId: string
      signal?: AbortSignal
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

    const controller = new AbortController()
    const candidates: ArenaCandidateState[] = []
    const worktreeProjects = new Map<string, string>()

    for (const [index, ref] of request.candidates.entries()) {
      const provider = this.deps.db.providers.getById(ref.providerId)
      const safeModel = ref.modelId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 24)
      const worktree = await this.deps.git.createWorktree(
        project.path,
        this.deps.worktreesDir,
        project.id,
        `arena-${index + 1}-${safeModel}`
      )
      const worktreeProject = this.deps.code.openProject(worktree.path)
      const run = this.deps.db.agentPlatform.runStart({
        conversationId: request.conversationId,
        projectId: worktreeProject.id,
        agentName: 'arena',
        task: request.task,
        worktreePath: worktree.path,
        providerId: ref.providerId,
        modelId: ref.modelId,
      })
      worktreeProjects.set(run.id, worktreeProject.id)
      candidates.push({
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
      })
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
      },
      controller,
      worktreeProjects,
      mainRoot: project.path,
    }
    this.arenas.set(request.conversationId, arena)
    this.push(arena)

    // Fan out WITHOUT awaiting: candidates stream to 'done' independently.
    void Promise.allSettled(
      candidates.map((candidate) => this.runCandidate(arena, candidate))
    ).then(() => {
      if (arena.state.status === 'running') arena.state.status = 'finished'
      this.push(arena)
    })

    return arena.state
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

    const skipped: string[] = []
    let applied = 0
    for (const file of candidate.changedFiles) {
      // Deletions and renames are rare for task-sized changes; report instead
      // of guessing. (status D = deleted in the worktree.)
      if (file.status === 'D') {
        skipped.push(`${file.path} (deletion — remove it manually if intended)`)
        continue
      }
      const abs = this.resolveInWorktree(candidate.worktreePath, file.path)
      if (!abs || !existsSync(abs)) {
        skipped.push(`${file.path} (not readable in the worktree)`)
        continue
      }
      const buffer = readFileSync(abs)
      if (buffer.byteLength > APPLY_FILE_MAX_BYTES || looksBinary(buffer)) {
        skipped.push(`${file.path} (binary or too large for the change pipeline)`)
        continue
      }
      const targetAbs = path.join(arena.mainRoot, file.path)
      const changeType: 'create' | 'edit' = existsSync(targetAbs) ? 'edit' : 'create'
      const change = this.deps.code.proposeChange(
        conversationId,
        file.path,
        changeType,
        buffer.toString('utf8')
      )
      this.deps.code.applyChange(change.id)
      applied += 1
    }
    if (applied === 0 && skipped.length === 0) {
      throw invalid('The chosen candidate has no changes to apply.')
    }

    arena.state.appliedRunId = runId
    arena.state.status = 'applied'
    candidate.summary = skipped.length
      ? `${candidate.summary}\n\nApplied ${applied} file(s); skipped: ${skipped.join(', ')}`
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
    try {
      const text = await this.deps.generate(
        arenaPrompt(arena.state.task),
        candidate.providerId,
        candidate.modelId,
        {
          useTools: true,
          approvedToolIds: ARENA_TOOL_IDS,
          projectId: projectId ?? '',
          signal: arena.controller.signal,
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

  private resolveInWorktree(worktreeRoot: string, relPath: string): string | null {
    if (relPath.includes('\0') || path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
      return null
    }
    const root = path.resolve(worktreeRoot)
    const target = path.resolve(root, relPath)
    const rel = path.relative(root, target)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return target
  }

  private push(arena: ArenaInternal): void {
    this.deps.broadcast(CHANNELS.arenaChanged, { arena: arena.state })
  }
}
