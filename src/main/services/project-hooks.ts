import type { AppDatabase } from '../db/database'
import type { Conversation, ProjectHookEvent } from '@shared/types'
import { commandMatchesAllowlist } from '../tools/shell-allowlist'
import { runShell } from '../tools/shell'

const HOOK_TIMEOUT_MS = 120_000

/**
 * Executes declarative hooks through the same opt-in and allowlist gates as
 * standing-approved shell tools. Hooks never prompt in the background: a
 * command that is not explicitly allowlisted is skipped.
 */
export class ProjectHookService {
  constructor(private readonly db: AppDatabase) {}

  async run(event: ProjectHookEvent, conversation: Conversation): Promise<void> {
    const settings = this.db.settings.get()
    if (!settings.shellExecutionEnabled || !conversation.projectId) return
    const project = this.db.code.projectGetById(conversation.projectId)
    if (!project) return
    const hooks = settings.projectHooks.filter((hook) => hook.enabled && hook.event === event)
    for (const hook of hooks) {
      if (!commandMatchesAllowlist(hook.command, settings.shellCommandAllowlist)) continue
      const result = await runShell(hook.command, project.path, HOOK_TIMEOUT_MS)
      if (event === 'beforeCommit' && (result.timedOut || result.aborted || result.code !== 0)) {
        throw new Error(
          `Required hook '${hook.name}' failed${result.timedOut ? ' (timed out)' : ` (exit ${result.code ?? 'unknown'})`}.`
        )
      }
    }
  }

  async runForRoot(event: ProjectHookEvent, root: string): Promise<void> {
    const project = this.db.code.projectsList().find((item) => item.path === root)
    if (!project) return
    const row = this.db.driver.get<{ id: string }>(
      'SELECT id FROM conversations WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1',
      [project.id]
    )
    if (!row) return
    const conversation = this.db.conversations.getById(row.id)
    if (conversation) await this.run(event, conversation)
  }
}
