/**
 * ToolRegistry — the single source of truth for which tools exist, whether
 * they are enabled, and what permission decision applies to each.
 *
 * Definitions = builtins (./definitions) + user-defined custom HTTP tools
 * (db.customTools), with per-tool enabled flags overlaid from db.tools.
 *
 * Permissions come from db.tools; when the user has not decided yet, the
 * default is derived from the tool's risk level (DEFAULT_PERMISSION_BY_RISK:
 * safe -> 'always_allow', sensitive/dangerous -> 'ask').
 *
 * Intended IPC wiring (integration agent):
 * - toolsList            -> registry.listDefinitions()
 * - toolsSetEnabled      -> registry.setEnabled(toolId, enabled)
 * - toolsPermissionsList -> registry.listPermissions()
 * - toolsPermissionSet   -> registry.setPermission(toolId, decision)
 */

import type {
  CustomToolInfo,
  CustomToolInput,
  CustomToolPatch,
  ToolDefinition,
  ToolPermission,
  ToolPermissionDecision,
} from '@shared/types'
import type { AppDatabase } from '../db/database'
import type { CustomToolRecord } from '../db/repositories/custom-tools'
import { BUILTIN_TOOL_DEFINITIONS, DEFAULT_PERMISSION_BY_RISK } from './definitions'
import {
  customToolDbId,
  customToolDefinitionId,
  customToolHeaders,
  customToolToDefinition,
  isCustomToolId,
  parseParamsSchema,
  toCustomToolCreateInput,
  toCustomToolUpdateInput,
} from './custom-tools'

/** A dynamic tool source (e.g. connected MCP servers). */
export interface DynamicToolSource {
  listToolDefinitions(isEnabled: (toolId: string) => boolean): ToolDefinition[]
}

export class ToolRegistry {
  constructor(
    private readonly db: AppDatabase,
    private readonly mcpSource?: DynamicToolSource
  ) {}

  /** All tools the model may see: builtins + customs + MCP, enabled flags applied. */
  listDefinitions(): ToolDefinition[] {
    const enabledMap = this.db.tools.enabledMap()
    const isEnabled = (toolId: string): boolean => enabledMap[toolId] ?? true

    // Opt-in tools are hidden entirely unless the user enabled them — the model
    // is never even offered them otherwise.
    const settings = this.db.settings.get()
    const hidden = new Set<string>()
    if (!settings.shellExecutionEnabled) hidden.add('run_shell_command')
    if (!settings.browserToolsEnabled) {
      hidden.add('browser')
      hidden.add('computer')
    }
    // use_skill is pointless (and prompt noise) without any enabled skills.
    if (this.db.skills.listEnabled().length === 0) hidden.add('use_skill')
    const builtins = BUILTIN_TOOL_DEFINITIONS.filter((tool) => !hidden.has(tool.id)).map((tool) => ({
      ...tool,
      enabled: isEnabled(tool.id),
      source: 'builtin' as const,
    }))
    const customs = this.db.customTools
      .list()
      .map((record) => customToolToDefinition(record, isEnabled(customToolDefinitionId(record.id))))
    const mcp = this.mcpSource?.listToolDefinitions(isEnabled) ?? []
    return [...builtins, ...customs, ...mcp]
  }

  /** Enabled tools only — what actually gets offered to the model. */
  listEnabledDefinitions(): ToolDefinition[] {
    return this.listDefinitions().filter((tool) => tool.enabled)
  }

  /** Lookup by ToolDefinition id ('file_search', 'custom:<uuid>'). */
  getById(toolId: string): ToolDefinition | null {
    return this.listDefinitions().find((tool) => tool.id === toolId) ?? null
  }

  /**
   * Resolve a model-issued tool call. Models call tools by NAME; builtin
   * names equal their ids, custom names are user-chosen. Ids are accepted
   * too. Builtins win on a name collision.
   */
  resolveForCall(nameOrId: string): ToolDefinition | null {
    const definitions = this.listDefinitions()
    return (
      definitions.find((tool) => tool.id === nameOrId) ??
      definitions.find((tool) => tool.name === nameOrId) ??
      null
    )
  }

  setEnabled(toolId: string, enabled: boolean): void {
    if (!this.getById(toolId)) throw new Error(`Unknown tool: ${toolId}`)
    this.db.tools.setEnabled(toolId, enabled)
  }

  // -- permissions ------------------------------------------------------------

  /**
   * One entry per known tool. Stored decisions win; tools the user never
   * decided on get the default for their risk level (updatedAt 0 marks a
   * default, i.e. "not explicitly set by the user").
   */
  listPermissions(): ToolPermission[] {
    const stored = new Map(this.db.tools.permissionsList().map((p) => [p.toolId, p]))
    return this.listDefinitions().map(
      (tool) =>
        stored.get(tool.id) ?? {
          toolId: tool.id,
          decision: DEFAULT_PERMISSION_BY_RISK[tool.risk],
          updatedAt: 0,
        }
    )
  }

  /** Effective decision for one tool (default by risk when unset/unknown). */
  getPermission(tool: ToolDefinition): ToolPermissionDecision {
    const stored = this.db.tools.permissionsList().find((p) => p.toolId === tool.id)
    return stored?.decision ?? DEFAULT_PERMISSION_BY_RISK[tool.risk]
  }

  setPermission(toolId: string, decision: ToolPermissionDecision): void {
    if (!this.getById(toolId)) throw new Error(`Unknown tool: ${toolId}`)
    this.db.tools.permissionSet(toolId, decision)
  }

  // -- custom tools -------------------------------------------------------------

  /**
   * Validates, stores and returns the resulting definition (enabled). Handles
   * only the row; secret headers are stored separately by the IPC layer.
   */
  addCustomTool(input: CustomToolInput): ToolDefinition {
    const record = this.db.customTools.create(toCustomToolCreateInput(input))
    return customToolToDefinition(record, true)
  }

  /** Applies a partial edit to a custom tool (non-secret fields only). */
  updateCustomTool(toolId: string, patch: CustomToolPatch): ToolDefinition {
    const dbId = customToolDbId(toolId)
    if (this.db.customTools.getById(dbId) === null) {
      throw new Error(`Not a custom tool: ${toolId}`)
    }
    const record = this.db.customTools.update(dbId, toCustomToolUpdateInput(patch))
    if (!record) throw new Error(`Not a custom tool: ${toolId}`)
    return customToolToDefinition(record, this.db.tools.enabledMap()[toolId] ?? true)
  }

  /** Accepts 'custom:<uuid>' or the bare uuid. Builtins cannot be removed. */
  removeCustomTool(toolId: string): void {
    if (!isCustomToolId(toolId) && this.db.customTools.getById(toolId) === null) {
      throw new Error(`Not a custom tool: ${toolId}`)
    }
    this.db.customTools.remove(customToolDbId(toolId))
  }

  /** Raw stored record for the executor (null for builtins/unknown). */
  getCustomToolRecord(toolId: string): CustomToolRecord | null {
    if (!isCustomToolId(toolId)) return null
    return this.db.customTools.getById(customToolDbId(toolId))
  }

  /** Full details (values excluded) for the Settings edit form. */
  listCustomToolInfos(): CustomToolInfo[] {
    const enabledMap = this.db.tools.enabledMap()
    return this.db.customTools.list().map((record) => {
      const definitionId = customToolDefinitionId(record.id)
      return {
        id: definitionId,
        name: record.name,
        description: record.description,
        baseUrl: record.baseUrl,
        method: record.method,
        headers: customToolHeaders(record),
        secretHeaders: this.db.secrets
          .listNames('custom_tool', record.id)
          .map((s) => ({ name: s.name, preview: s.preview })),
        paramsSchema: parseParamsSchema(record.paramsSchemaJson),
        enabled: enabledMap[definitionId] ?? true,
      }
    })
  }
}
