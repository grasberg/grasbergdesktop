/**
 * MCP tool id namespacing. A discovered tool becomes 'mcp__<serverKey>__<tool>'
 * so it never collides with builtins/customs and the wire function name stays
 * within OpenAI's 64-char + [A-Za-z0-9_-] limit. Sanitization is lossy, so the
 * manager keeps an authoritative reverse map (id -> original tool name).
 */

export const MCP_TOOL_ID_PREFIX = 'mcp__'
const MAX_TOOL_ID_LENGTH = 64

export function isMcpToolId(toolId: string): boolean {
  return toolId.startsWith(MCP_TOOL_ID_PREFIX)
}

/** 'mcp__<key>__<sanitizedName>' capped at 64 chars. */
export function namespaceMcpToolId(serverKey: string, toolName: string): string {
  const sanitized = toolName.replace(/[^A-Za-z0-9_-]/g, '_')
  const id = `${MCP_TOOL_ID_PREFIX}${serverKey}__${sanitized}`
  return id.length <= MAX_TOOL_ID_LENGTH ? id : id.slice(0, MAX_TOOL_ID_LENGTH)
}
