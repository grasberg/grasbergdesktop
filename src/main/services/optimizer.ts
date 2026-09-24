/**
 * Optimizer — an autonomous optimize-evaluate-commit loop per project,
 * modeled on AVO (Agentic Variation Operators, arXiv:2603.24517):
 *
 *   Vary(P) = Agent(P, K, f)
 *
 * Each round the agent edits an app-owned isolated git worktree with its normal
 * tools (the "variation operator"); MAIN then evaluates deterministically by running
 * the user's eval command (the scoring function f). The AVO commit rule is
 * enforced verbatim: a round is accepted only when evaluation passes AND the
 * score matches or beats the best so far. Accepted rounds become git commits
 * (the lineage P); rejected rounds are rolled back to HEAD but recorded, and
 * everything lands in the experiment log so future sessions build on it.
 *
 * Self-supervision mirrors the paper: after several consecutive rejected
 * rounds the next prompt gets a redirect hint; a longer plateau ends the run.
 */

import type { ExperimentEntry, OptimizerRun, OptimizerVersion } from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { ProviderError } from '../providers/errors'
import { redactSecrets } from '../providers/redact'

/** Tool set pre-approved for optimization rounds (shell only when opted in). */
export const OPTIMIZER_TOOL_IDS = [
  'read_file',
  'list_directory',
  'grep',
  'glob',
  'file_search',
  'edit_file',
  'write_file',
]
const SHELL_TOOL_ID = 'run_shell_command'

/** Consecutive rejected rounds before the prompt gets a redirect hint. */
const REDIRECT_AFTER_REJECTS = 3
/** Consecutive rejected rounds that end the run as a plateau ('done'). */
const PLATEAU_AFTER_REJECTS = 6
/** Cap on what we store from the agent's closing text. */
const SUMMARY_MAX_CHARS = 2_000

function invalid(message: string): ProviderError {
  return new ProviderError('invalid_request', message)
}

// ---------------------------------------------------------------------------
// Pure decision helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * The score is the number printed LAST by the eval command. Prefers the last
 * line ("12.34" alone on the final line is the recommended convention), then
 * falls back to the last number anywhere in the output tail.
 */
export function parseScore(output: string): number | null {
  const tail = output.slice(-2_000)
  const lines = tail.trimEnd().split(/\r?\n/)
  const lastLine = lines[lines.length - 1] ?? ''
  // Within the final line the RIGHTMOST number wins ("done in 3.2s (12 ops)"
  // scores 12): whatever the tool printed last is what it meant to report.
  const inLine = [...lastLine.matchAll(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)]
  const fromLastLine = inLine[inLine.length - 1]?.[0]
  if (fromLastLine) {
    const value = Number(fromLastLine)
    if (Number.isFinite(value)) return value
  }
  const all = [...tail.matchAll(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)]
  const last = all[all.length - 1]?.[0]
  if (!last) return null
  const value = Number(last)
  return Number.isFinite(value) ? value : null
}

/**
 * AVO commit rule: correctness first (eval exit code + optional test gate),
 * then a non-regressing score in the run's chosen direction. `best === null`
 * means no accepted version yet — any passing score becomes the baseline.
 * 'maximize' keeps a score that matches-or-beats the best; 'minimize' (runtime,
 * memory, error count) keeps one that matches-or-undercuts it.
 */
export function decideAccept(input: {
  evalExitCode: number | null
  score: number | null
  testPassed: boolean
  bestScore: number | null
  direction?: 'maximize' | 'minimize'
}): boolean {
  if (input.evalExitCode !== 0 || input.score === null || !input.testPassed) return false
  if (input.bestScore === null) return true
  return input.direction === 'minimize'
    ? input.score <= input.bestScore
    : input.score >= input.bestScore
}

export interface RoundPromptInput {
  goal: string
  evalCommand: string
  testCommand: string | null
  direction: 'maximize' | 'minimize'
  round: number
  maxRounds: number
  bestScore: number | null
  bestVersion: number | null
  /** Compact recent lineage, newest first — accepted AND rejected attempts. */
  versions: Array<{ seq: number; score: number | null; summary: string; accepted: boolean }>
  redirectHint: boolean
}

/** The per-round variation prompt. */
export function buildRoundPrompt(input: RoundPromptInput): string {
  const better = input.direction === 'minimize' ? 'LOWER is better' : 'HIGHER is better'
  const keepRule =
    input.direction === 'minimize'
      ? 'A new version is kept ONLY if its score matches or undercuts this. Increases are discarded.'
      : 'A new version is kept ONLY if its score matches or beats this. Decreases are discarded.'
  const parts: string[] = [
    'You are an autonomous OPTIMIZATION agent working directly in a real project ' +
      '(the folder tools are already scoped to it). The user will evaluate your work by ' +
      'running a fixed benchmark command afterwards — they do not read chat prose.',
    '',
    `GOAL: ${input.goal}`,
    `EVALUATION (run automatically after this round): ${input.evalCommand}`,
    ...(input.testCommand ? [`TEST GATE (must also pass): ${input.testCommand}`] : []),
    `The single number printed by the last line of the evaluation output is the SCORE (${better}).`,
    '',
    input.bestScore === null
      ? 'No accepted version exists yet — establish a correct baseline first.'
      : `Best accepted version so far: v${input.bestVersion} (score ${input.bestScore}). ${keepRule}`,
    '',
    'PROTOCOL:',
    '1. Make focused edits toward the goal with edit_file/write_file.',
    '2. Do not touch files outside the project or modify the evaluation setup itself.',
    '3. Do NOT run git commands; versioning is handled for you.',
    '4. End your reply with a one-paragraph summary of exactly what you changed.',
  ]
  if (input.versions.length > 0) {
    parts.push(
      '',
      'RECENT ATTEMPTS (newest first; build on what was KEPT, do not repeat what was DISCARDED):',
      ...input.versions
        .slice(0, 8)
        .map(
          (v) =>
            `- v${v.seq} [${v.accepted ? 'kept' : 'discarded'}] score=${v.score ?? 'n/a'}: ${v.summary.slice(0, 200)}`
        ),
    )
  }
  if (input.redirectHint) {
    parts.push(
      '',
      'REDIRECT: several consecutive attempts failed to improve the score. Stop refining ' +
        'the current idea; pick a materially different approach (different hot path, ' +
        'different algorithmic angle) — the discarded attempts above are approaches that ' +
        'did NOT work, so choose something distinct from them.'
    )
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface CommandResult {
  ok: boolean
  exitCode: number | null
  output: string
  /** True when the command was killed by the run's abort signal (a stop). */
  aborted?: boolean
}

export interface OptimizerDeps {
  db: {
    optimizer: {
      create(input: {
        projectId: string
        goal: string
        evalCommand: string
        testCommand: string | null
        providerId: string | null
        modelId: string | null
        maxRounds: number
        direction: 'maximize' | 'minimize'
        worktreePath: string
        worktreeBranch: string
        baseBranch: string
        baseSha: string
      }): OptimizerRun
      getById(id: string): OptimizerRun | null
      list(): OptimizerRun[]
      update(id: string, patch: Record<string, unknown>): OptimizerRun | null
      appendVersion(input: {
        runId: string
        seq: number
        score: number | null
        accepted: boolean
        summary: string
        commitSha: string | null
      }): OptimizerVersion
      listVersions(runId: string): OptimizerVersion[]
    }
    experiments: {
      add(input: {
        projectId: string
        title: string
        outcome: ExperimentEntry['outcome']
        detail?: string
        source?: string
      }): ExperimentEntry
      listForProject(projectId: string, limit?: number): ExperimentEntry[]
    }
    code: {
      projectGetById(id: string): { id: string; path: string } | null
      projectUpsertByPath(path: string, name?: string): { id: string }
    }
  }
  git: {
    status(root: string): Promise<{
      isRepo: boolean
      branch: string | null
      staged: unknown[]
      unstaged: unknown[]
      untracked: unknown[]
    }>
    stage(root: string, paths: string[]): Promise<unknown>
    commit(root: string, message: string): Promise<{ sha: string; branch: string | null }>
    discardAllChanges(root: string): Promise<void>
    createWorktree(
      root: string,
      worktreesDir: string,
      projectId: string,
      requestedName?: string
    ): Promise<{ path: string; branch: string; projectId: string }>
    removeWorktree(mainRoot: string, worktreePath: string, branch: string): Promise<void>
    revision(root: string): Promise<string>
    fastForwardWorktree(
      mainRoot: string,
      sourceBranch: string,
      expectedBranch: string,
      expectedHead: string
    ): Promise<void>
  }
  /** Wired to ChatService.generateForWorkflow (headless tool loop). */
  generate: (
    prompt: string,
    providerId: string | undefined,
    modelId: string | undefined,
    opts: {
      useTools: boolean
      approvedToolIds: string[]
      projectId: string
      sandboxLevel?: 'workspace-write' | 'full'
      signal?: AbortSignal
    }
  ) => Promise<string>
  /** Wired to runShell (tools/shell.ts). */
  runCommand: (command: string, cwd: string, signal?: AbortSignal) => Promise<CommandResult>
  broadcast: (channel: string, payload: unknown) => void
  notify?: (notification: { kind: 'result'; title: string; body: string }) => void
  worktreesDir: string
}

interface RunningOptimization {
  controller: AbortController
}

export class OptimizerService {
  private readonly running = new Map<string, RunningOptimization>()

  constructor(private readonly deps: OptimizerDeps) {}

  list(): OptimizerRun[] {
    return this.deps.db.optimizer.list()
  }

  versions(runId: string): OptimizerVersion[] {
    return this.deps.db.optimizer.listVersions(runId)
  }

  async start(input: {
    projectId: string
    goal: string
    evalCommand: string
    testCommand?: string
    providerId?: string | null
    modelId?: string | null
    maxRounds?: number
    direction?: 'maximize' | 'minimize'
    allowShell?: boolean
  }): Promise<OptimizerRun> {
    const goal = input.goal.trim()
    const evalCommand = input.evalCommand.trim()
    if (goal.length === 0) throw invalid('Describe what to optimize.')
    if (evalCommand.length === 0) throw invalid('An evaluation command is required.')
    const project = this.deps.db.code.projectGetById(input.projectId)
    if (!project) throw invalid('Project not found.')
    const existing = this.list().find((r) => r.projectId === project.id && r.status === 'running')
    if (existing) throw invalid('An optimizer run is already running for this project.')
    const status = await this.deps.git.status(project.path)
    if (!status.isRepo) throw invalid('The optimizer requires the project to be a git repository.')
    if (
      status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0
    ) {
      throw invalid('Commit or stash your changes first — the optimizer needs a clean tree.')
    }

    if (!status.branch) throw invalid('The optimizer requires a checked-out branch.')

    const maxRounds = Math.min(Math.max(Math.trunc(input.maxRounds ?? 6), 1), 40)
    const testCommand = input.testCommand?.trim() || null
    const baseSha = await this.deps.git.revision(project.path)
    const worktree = await this.deps.git.createWorktree(
      project.path,
      this.deps.worktreesDir,
      project.id,
      'optimizer'
    )
    let run: OptimizerRun
    let worktreeProjectId: string
    try {
      worktreeProjectId = this.deps.db.code.projectUpsertByPath(worktree.path, 'Optimizer').id
      run = this.deps.db.optimizer.create({
        projectId: project.id,
        goal,
        evalCommand,
        testCommand,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        maxRounds,
        direction: input.direction === 'minimize' ? 'minimize' : 'maximize',
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
        baseBranch: status.branch,
        baseSha,
      })
    } catch (error) {
      await this.deps.git.removeWorktree(project.path, worktree.path, worktree.branch)
      throw error
    }
    this.push(run)

    const controller = new AbortController()
    this.running.set(run.id, { controller })
    void this.loop(
      run.id,
      project.path,
      worktree.path,
      worktreeProjectId,
      input.allowShell === true,
      controller
    ).catch((error) => {
      // Loop-level crash: persist honestly instead of leaving a zombie 'running' row.
      const message = error instanceof Error ? error.message : String(error)
      void this.finish(run.id, 'failed', redactSecrets(message), project.path)
    })
    return run
  }

  stop(runId: string): OptimizerRun | null {
    const running = this.running.get(runId)
    if (!running) {
      // No live controller. If the row is nonetheless still 'running' (a
      // dangling row that escaped boot recovery), finalize it so the UI's
      // Stop button is never a no-op and the project unlocks.
      const row = this.deps.db.optimizer.getById(runId)
      if (row && row.status === 'running') {
        const updated = this.applyPatch(runId, {
          status: 'stopped',
          lastError:
            row.worktreePath === null
              ? null
              : `Interrupted run preserved at ${row.worktreePath} (${row.worktreeBranch ?? 'unknown branch'}).`,
        })
        this.push(updated)
        return this.deps.db.optimizer.getById(runId)
      }
      return row
    }
    running.controller.abort()
    return this.deps.db.optimizer.getById(runId)
  }

  stopAll(): void {
    for (const running of this.running.values()) running.controller.abort()
  }

  /** The full loop; every exit path funnels through finalize(). */
  private async loop(
    runId: string,
    mainRoot: string,
    root: string,
    worktreeProjectId: string,
    allowShell: boolean,
    controller: AbortController
  ): Promise<void> {
    let current = this.requireRun(runId)
    let consecutiveRejects = 0
    try {
      // Establish v0 on the untouched checkout before the agent can edit it.
      const baselineEval = await this.deps.runCommand(current.evalCommand, root, controller.signal)
      if (controller.signal.aborted || baselineEval.aborted) {
        await this.finish(runId, 'stopped', null, mainRoot)
        return
      }
      const baselineScore = baselineEval.ok ? parseScore(baselineEval.output) : null
      let baselineTestsPassed = true
      if (current.testCommand) {
        const baselineTest = await this.deps.runCommand(
          current.testCommand,
          root,
          controller.signal
        )
        if (controller.signal.aborted || baselineTest.aborted) {
          await this.finish(runId, 'stopped', null, mainRoot)
          return
        }
        baselineTestsPassed = baselineTest.ok
      }
      if (baselineEval.exitCode !== 0 || baselineScore === null || !baselineTestsPassed) {
        throw new Error('The pristine project failed the evaluation or test gate; no edits were made.')
      }
      this.deps.db.optimizer.appendVersion({
        runId,
        seq: 0,
        score: baselineScore,
        accepted: true,
        summary: 'Pristine project baseline.',
        commitSha: current.baseSha,
      })
      current = this.applyPatch(runId, { bestScore: baselineScore, bestVersion: 0 })
      this.push(current)

      for (let round = 1; round <= current.maxRounds; round++) {
        if (controller.signal.aborted) {
          await this.finish(runId, 'stopped', null, mainRoot)
          return
        }

        // Recent attempts, newest first — BOTH accepted and rejected, so the
        // agent can see (and stop repeating) approaches that already failed.
        const recent = this.deps.db.optimizer
          .listVersions(runId)
          .slice(-8)
          .reverse()
          .map((v) => ({ seq: v.seq, score: v.score, summary: v.summary, accepted: v.accepted }))

        const prompt = buildRoundPrompt({
          goal: current.goal,
          evalCommand: current.evalCommand,
          testCommand: current.testCommand,
          direction: current.direction,
          round,
          maxRounds: current.maxRounds,
          bestScore: current.bestScore,
          bestVersion: current.bestVersion,
          versions: recent,
          redirectHint: consecutiveRejects >= REDIRECT_AFTER_REJECTS,
        })

        let agentText: string
        try {
          agentText = await this.deps.generate(
            prompt,
            current.providerId ?? undefined,
            current.modelId ?? undefined,
            {
              useTools: true,
              approvedToolIds:
                allowShell === true ? [...OPTIMIZER_TOOL_IDS, SHELL_TOOL_ID] : OPTIMIZER_TOOL_IDS,
              projectId: worktreeProjectId,
              sandboxLevel: allowShell ? 'full' : 'workspace-write',
              signal: controller.signal,
            }
          )
        } catch (e) {
          if (controller.signal.aborted) {
            await this.finish(runId, 'stopped', null, mainRoot)
            return
          }
          throw e
        }

        if (controller.signal.aborted) {
          await this.finish(runId, 'stopped', null, mainRoot)
          return
        }

        // Deterministic scoring: main runs the eval command, never the agent.
        const evalRes = await this.deps.runCommand(current.evalCommand, root, controller.signal)
        // A stop that lands mid-eval must not be recorded as a genuine failed
        // round (that fake 'failed' would pollute the permanent experiment log
        // injected into future sessions). Finalize as stopped, discard nothing
        // extra — the next start() re-checks the tree.
        if (controller.signal.aborted || evalRes.aborted) {
          await this.finish(runId, 'stopped', null, mainRoot)
          return
        }
        const score = evalRes.ok ? parseScore(evalRes.output) : null
        let testPassed = true
        if (current.testCommand) {
          const testRes = await this.deps.runCommand(
            current.testCommand,
            root,
            controller.signal
          )
          if (controller.signal.aborted || testRes.aborted) {
            await this.finish(runId, 'stopped', null, mainRoot)
            return
          }
          testPassed = testRes.ok
        }

        let accepted = decideAccept({
          evalExitCode: evalRes.exitCode,
          score,
          testPassed,
          bestScore: current.bestScore,
          direction: current.direction,
        })

        let commitSha: string | null = null
        let noChanges = false
        if (accepted) {
          try {
            await this.deps.git.stage(root, ['.'])
            noChanges = (await this.deps.git.status(root)).staged.length === 0
            if (noChanges) {
              // A model can finish without editing a file. Keep the baseline
              // and count this as a rejected attempt, not a broken run.
              accepted = false
            } else {
            const commit = await this.deps.git.commit(
              root,
              `[optimizer v${round}] ${current.goal}\n\nscore: ${score}`
            )
            commitSha = commit.sha
            }
          } catch (e) {
            // Accepting without a commit would desync the ledger from the tree.
            throw new Error(
              `Accepted version could not be committed: ${
                e instanceof Error ? e.message : String(e)
              }`
            )
          }
        } else {
          // Roll the rejected attempt back so the next round starts clean.
          try {
            await this.deps.git.discardAllChanges(root)
          } catch (e) {
            throw new Error(
              `Rejected changes could not be rolled back: ${
                e instanceof Error ? e.message : String(e)
              }`
            )
          }
        }

        this.deps.db.optimizer.appendVersion({
          runId,
          seq: round,
          score,
          accepted,
          summary: `${noChanges ? 'No file changes produced. ' : ''}${agentText.trim()}`.slice(0, SUMMARY_MAX_CHARS),
          commitSha,
        })
        this.deps.db.experiments.add({
          projectId: current.projectId,
          title: `${current.goal} — attempt v${round}`,
          outcome: accepted ? 'improved' : 'failed',
          detail:
            score !== null
              ? `score ${score}${accepted ? ' (new best)' : ''}; ${agentText.trim()}`
              : 'evaluation failed or produced no score',
          source: 'optimizer',
        })

        current = this.applyPatch(runId, {
          roundsDone: round,
          ...(accepted && score !== null ? { bestScore: score, bestVersion: round } : {}),
        })
        this.push(current)

        consecutiveRejects = accepted ? 0 : consecutiveRejects + 1
        if (consecutiveRejects >= PLATEAU_AFTER_REJECTS) {
          await this.finish(runId, 'done', null, mainRoot)
          return
        }
      }
      await this.finish(runId, 'done', null, mainRoot)
    } catch (e) {
      const aborted = controller.signal.aborted
      await this.finish(
        runId,
        aborted ? 'stopped' : 'failed',
        aborted ? null : redactSecrets(e instanceof Error ? e.message : String(e)),
        mainRoot
      )
    }
  }

  private requireRun(runId: string): OptimizerRun {
    const run = this.deps.db.optimizer.getById(runId)
    if (!run) throw new Error(`Optimizer run ${runId} disappeared.`)
    return run
  }

  private applyPatch(
    runId: string,
    patch: Record<string, unknown>
  ): OptimizerRun {
    const updated = this.deps.db.optimizer.update(runId, patch)
    if (!updated) throw new Error(`Optimizer run ${runId} disappeared.`)
    return updated
  }

  private async finish(
    runId: string,
    status: OptimizerRun['status'],
    lastError: string | null,
    mainRoot: string
  ): Promise<void> {
    const run = this.requireRun(runId)
    let finalError = lastError
    const recovery = (message: string): void => {
      finalError = [finalError, message].filter(Boolean).join(' ')
    }

    if (run.worktreePath && run.worktreeBranch && run.baseBranch && run.baseSha) {
      let worktreeClean = true
      try {
        await this.deps.git.discardAllChanges(run.worktreePath)
      } catch (error) {
        worktreeClean = false
        recovery(
          `Could not clean the isolated worktree; it was preserved at ${run.worktreePath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }

      let removable = run.bestVersion === null || run.bestVersion === 0
      if (worktreeClean && run.bestVersion !== null && run.bestVersion > 0) {
        try {
          await this.deps.git.fastForwardWorktree(
            mainRoot,
            run.worktreeBranch,
            run.baseBranch,
            run.baseSha
          )
          removable = true
        } catch (error) {
          recovery(
            `Accepted commits were preserved at ${run.worktreePath} on ${run.worktreeBranch}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
      if (worktreeClean && removable) {
        try {
          await this.deps.git.removeWorktree(mainRoot, run.worktreePath, run.worktreeBranch)
        } catch (error) {
          recovery(
            `The isolated worktree could not be removed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
    }

    const updated = this.applyPatch(runId, { status, lastError: finalError })
    this.running.delete(runId)
    this.push(updated)
    if (status !== 'running') {
      this.deps.notify?.({
        kind: 'result',
        title:
          status === 'done'
            ? 'Optimizer finished'
            : status === 'stopped'
              ? 'Optimizer was stopped'
              : 'Optimizer failed',
        body:
          updated.bestScore !== null
            ? `Best score: ${updated.bestScore} (v${updated.bestVersion}).${updated.lastError ? ` ${updated.lastError}` : ''}`
            : (updated.lastError ?? 'No accepted version.'),
      })
    }
  }

  private push(run: OptimizerRun): void {
    this.deps.broadcast(CHANNELS.optimizerChanged, { run })
  }
}
