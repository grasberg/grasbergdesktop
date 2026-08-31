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
import { ensureConversationWorkspace } from '../services/artifact-hooks'
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
  /** Bot Mode: fire-and-forget bot-to-bot delivery for 'message_agent' (wired to BotService). */
  botMessenger?: NonNullable<ToolExecutorDeps['botMessenger']>
  /** Text-to-image for 'generate_image' (wired to ChatService.generateImage). */
  imageGeneration?: NonNullable<ToolExecutorDeps['imageGeneration']>
  /** Local git writes for 'git_write' (wired to GitService). */
  gitWrite?: NonNullable<ToolExecutorDeps['gitWrite']>
  /** Read-only GitHub queries for the 'github' tool (wired to GitService). */
  gitHub?: NonNullable<ToolExecutorDeps['gitHub']>
  /** Background sub-agent tasks (delegate background=true, task_output, task_stop). */
  delegateBackground?: NonNullable<ToolExecutorDeps['delegateBackground']>
  /** Approval-gated project writes for edit_file/write_file (wired to CodeService). */
  codeChanges?: NonNullable<ToolExecutorDeps['codeChanges']>
  /**
   * Lazily creates + links a Work task's own workspace folder so file tools
   * work without a user-granted folder (wired to WorkspaceRootService).
   */
  ensureWorkspaceRoot?: NonNullable<ToolExecutorDeps['ensureWorkspaceRoot']>
  /**
   * Called after schedule_task mutates the scheduled-tasks table, so main can
   * push CHANNELS.scheduledTasksChanged to the renderer.
   */
  onScheduledTasksChanged?: () => void
  /**
   * Called after a *_document tool created or edited a notebook, so main can
   * push CHANNELS.documentsChanged to the renderer.
   */
  onDocumentsChanged?: () => void
  /** Called after an approval answer persisted a new standing rule. */
  onToolRulesChanged?: () => void
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
      // Re-read from the DB: a Work task's workspace folder can be linked
      // mid-stream (first write), and the caller's conversation object would
      // otherwise be stale for the read tools that follow in the same loop.
      // Headless stubs (synthetic ids) miss and fall back to the given object.
      const fresh = db.conversations.getById(conversation.id)
      const projectId = fresh ? fresh.projectId : conversation.projectId
      if (!projectId) return null
      return db.code.projectGetById(projectId)?.path ?? null
    })
  const executor = new ToolExecutor({
    registry,
    codeService: codeService ?? null,
    repoMap: new RepoMapService(),
    mcpClient: options.mcp ?? null,
    shellEnabled: options.shellEnabled,
    shellAllowlist: options.shellAllowlist,
    // The audit trail: one record per tool call, with why it was allowed.
    activityLog: { record: (entry) => db.activity.record(entry) },
    // Standing approval rules live in the database, so "always allow" and
    // "always ask" survive a restart (see tools/tool-rules.ts).
    toolRules: {
      list: () => db.toolRules.list(),
      add: (input) => {
        db.toolRules.create(input)
        options.onToolRulesChanged?.()
      },
    },
    shellBackground: options.shellBackground ?? null,
    browserEnabled: options.browserEnabled,
    browser: options.browser ?? null,
    knowledgeSearch: options.knowledgeSearch,
    delegate: options.delegate,
    botMessenger: options.botMessenger ?? null,
    imageGeneration: options.imageGeneration ?? null,
    gitWrite: options.gitWrite ?? null,
    gitHub: options.gitHub ?? null,
    delegateBackground: options.delegateBackground ?? null,
    codeChanges: options.codeChanges ?? null,
    ensureWorkspaceRoot: options.ensureWorkspaceRoot ?? null,
    // update_task_list: persists the list as a 'Task list' checklist item in
    // the conversation's workspace (created and linked on first use — the
    // same shared helper the uld-item artifact hook uses).
    taskList: {
      update: (conversationId, markdown) => {
        const workspaceId = ensureConversationWorkspace(db, conversationId)
        if (!workspaceId) return 'Error: conversation not found.'
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
    // schedule_task: reads/writes db.scheduledTasks directly; the 30 s clock
    // scheduler queries the table each tick, so created tasks just get picked
    // up. Mutations signal main so the renderer's popover stays live.
    scheduledTasks: {
      create: (input) => {
        const task = db.scheduledTasks.create(input)
        options.onScheduledTasksChanged?.()
        return task
      },
      list: () => db.scheduledTasks.list(),
      getById: (id) => db.scheduledTasks.getById(id),
      remove: (id) => {
        db.scheduledTasks.remove(id)
        options.onScheduledTasksChanged?.()
      },
      conversationProjectId: (conversationId) =>
        db.conversations.getById(conversationId)?.projectId ?? null,
      projectPath: (projectId) => db.code.projectGetById(projectId)?.path ?? null,
    },
    // Notebooks for the *_document tools: mutations signal main so the Home
    // Notes card stays live while the model writes.
    documents: {
      list: () => db.documents.list(),
      getById: (id) => db.documents.getById(id),
      findByTitle: (title) => db.documents.findByTitle(title),
      create: (input) => {
        const doc = db.documents.create(input)
        options.onDocumentsChanged?.()
        return doc
      },
      update: (id, patch) => {
        const doc = db.documents.update(id, patch)
        if (doc) options.onDocumentsChanged?.()
        return doc
      },
    },
    // schedule_task's optional `agent`: names an agent profile to own the task.
    agents: {
      getByName: (name) => db.agents.getByName(name),
      listEnabledNames: () => db.agents.listEnabled().map((agent) => agent.name),
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
