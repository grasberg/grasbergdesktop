/**
 * Tool system public surface (main process).
 *
 * Quick start for the integration layer:
 *
 *   import { createToolSystem } from '../tools'
 *   const { registry, executor } = createToolSystem(db, codeService)
 *
 *   // IPC:  toolsList -> registry.listDefinitions()
 *   //       toolsSetEnabled -> registry.setEnabled(...)
 *   //       toolsPermissionsList -> registry.listPermissions()
 *   //       toolsPermissionSet -> registry.setPermission(...)
 *   // Chat: offer registry.listEnabledDefinitions() to the model, then for
 *   //       each model tool_call:
 *   //         const result = await executor.execute(toolCall, {
 *   //           conversation, streamId,
 *   //           approval: (req) => askRendererForApproval(req), // adds requestId
 *   //         })
 *   //       executor.execute never throws; feed `result` back as the
 *   //       role-'tool' message and store it on the ToolCallRecord.
 *
 * The default getProjectRoot resolves conversation.projectId through
 * db.code.projectGetById — pass a custom one to override (e.g. in tests).
 */

import type { Conversation } from '@shared/types'
import type { AppDatabase } from '../db/database'
import { ToolRegistry, type DynamicToolSource } from './registry'
import {
  ToolExecutor,
  type ToolBrowser,
  type ToolCodeService,
  type ToolExecutorDeps,
} from './executor'
import { RepoMapService } from '../code/repo-map'

/** MCP surface the tool system consumes (satisfied by McpManager). */
export type ToolMcpSource = DynamicToolSource & NonNullable<ToolExecutorDeps['mcpClient']>

export { ToolRegistry } from './registry'
export {
  ToolExecutor,
  USER_DECLINED_RESULT,
  type ToolCodeService,
  type ToolExecutorDeps,
  type ToolExecuteContext,
} from './executor'
export {
  BUILTIN_TOOL_DEFINITIONS,
  DEFAULT_PERMISSION_BY_RISK,
  TOOL_RESULT_MAX_CHARS,
} from './definitions'
export {
  CUSTOM_TOOL_ID_PREFIX,
  CUSTOM_TOOL_METHODS,
  isCustomToolId,
  customToolDbId,
} from './custom-tools'

export interface ToolSystem {
  registry: ToolRegistry
  executor: ToolExecutor
}

export interface CreateToolSystemOptions {
  /** Override how a conversation maps to its granted project root. */
  getProjectRoot?: (conversation: Conversation) => string | null
  /** Resolves a custom tool's secret headers (name -> decrypted value). */
  resolveSecretHeaders?: (toolId: string) => Record<string, string>
  /** Connected MCP servers: their tools join the registry and execution loop. */
  mcp?: ToolMcpSource
  /** Whether run_shell_command may execute (user opt-in). */
  shellEnabled?: () => boolean
  /** Command prefixes that skip the per-call shell approval dialog. */
  shellAllowlist?: () => string[]
  /** Background shell jobs (run_shell_command background=true). */
  shellBackground?: NonNullable<ToolExecutorDeps['shellBackground']>
  /** Whether the browser/computer tools may run (user opt-in). */
  browserEnabled?: () => boolean
  /** Embedded browser backing the browser/computer tools. */
  browser?: ToolBrowser
  /** Knowledge-base retrieval for the 'knowledge_search' tool. */
  knowledgeSearch?: ToolExecutorDeps['knowledgeSearch']
  /** Runs a sub-agent for the 'delegate' tool (wired to ChatService.runDelegate). */
  delegate?: ToolExecutorDeps['delegate']
  /** Background sub-agent tasks (delegate background=true, task_output, task_stop). */
  delegateBackground?: NonNullable<ToolExecutorDeps['delegateBackground']>
  /** Approval-gated project writes for edit_file/write_file (wired to CodeService). */
  codeChanges?: NonNullable<ToolExecutorDeps['codeChanges']>
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Builds the registry + executor pair. `codeService` may be null/omitted —
 * read_file then falls back to a direct (still root-confined, read-only)
 * filesystem read.
 */
export function createToolSystem(
  db: AppDatabase,
  codeService?: ToolCodeService | null,
  options: CreateToolSystemOptions = {}
): ToolSystem {
  const registry = new ToolRegistry(db, options.mcp)
  const getProjectRoot =
    options.getProjectRoot ??
    ((conversation: Conversation): string | null => {
      if (!conversation.projectId) return null
      return db.code.projectGetById(conversation.projectId)?.path ?? null
    })
  const executor = new ToolExecutor({
    registry,
    codeService: codeService ?? null,
    repoMap: new RepoMapService(),
    mcpClient: options.mcp ?? null,
    shellEnabled: options.shellEnabled,
    shellAllowlist: options.shellAllowlist,
    shellBackground: options.shellBackground ?? null,
    browserEnabled: options.browserEnabled,
    browser: options.browser ?? null,
    knowledgeSearch: options.knowledgeSearch,
    delegate: options.delegate,
    delegateBackground: options.delegateBackground ?? null,
    codeChanges: options.codeChanges ?? null,
    // update_task_list: persists the list as a 'Task list' checklist item in
    // the conversation's workspace (created and linked on first use).
    taskList: {
      update: (conversationId, markdown) => {
        const conversation = db.conversations.getById(conversationId)
        if (!conversation) return 'Error: conversation not found.'
        let workspaceId = conversation.workspaceId
        if (!workspaceId) {
          const workspace = db.workspaces.create({ name: conversation.title || 'Tasks' })
          workspaceId = workspace.id
          db.conversations.update(conversationId, { workspaceId })
        }
        db.workspaces.itemUpsertByKindTitle({
          workspaceId,
          kind: 'checklist',
          title: 'Task list',
          content: markdown,
          origin: 'assistant',
        })
        return 'Task list updated.'
      },
    },
    skills: {
      getEnabledByName: (name) => {
        const skill = db.skills.getByName(name)
        return skill && skill.enabled ? { name: skill.name, content: skill.content } : null
      },
      listEnabledNames: () => db.skills.listEnabled().map((skill) => skill.name),
    },
    getProjectRoot,
    resolveSecretHeaders: options.resolveSecretHeaders,
    fetchImpl: options.fetchImpl,
  })
  return { registry, executor }
}
