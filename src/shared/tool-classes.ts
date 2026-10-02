/**
 * Tool classes the approval layer reasons about (v53), shared because the
 * renderer shows the same classification next to rules and in the activity
 * view.
 *
 * OUTWARD = reaches a person or a system outside this app: sends a message,
 * posts, publishes, pushes, or submits something on the user's behalf. That
 * is the dots/Grok/Muse line between "looking" and "acting in the world":
 * proactive (read-only) turns may never cross it, auto-review checks it, and
 * it is what "hand off to me" rules are usually written for.
 *
 * Built-ins are listed by id. Custom HTTP tools are outward unless they GET
 * (mutating=false); MCP tools are outward unless their server marked them
 * read-only (mutating=false from the readOnlyHint annotation).
 */

export const OUTWARD_BUILTIN_TOOL_IDS: ReadonlySet<string> = new Set([
  'message_agent',
  'git_write',
  'run_shell_command',
  'computer',
  'desktop',
  'email_send',
  'channel_send',
])

/** Bot-chat-only tools: exist only in a canonical bot chat, never headless/delegate. */
/**
 * The Bot Mode protocol itself (messaging teammates, proposing, tracking
 * projects): always available in a bot's chat, whatever toolset the user
 * picked for the bot. Everything else — channel tools included — follows the
 * bot's toolset.
 */
export const BOT_PROTOCOL_TOOL_IDS: ReadonlySet<string> = new Set([
  'message_agent',
  'suggest_action',
  'update_project',
])

export const BOT_CHAT_TOOL_IDS: ReadonlySet<string> = new Set([
  'message_agent',
  'suggest_action',
  'update_project',
  'email_read',
  'email_send',
  'channel_send',
])

export interface ClassifiableTool {
  id: string
  source?: 'builtin' | 'custom' | 'mcp'
  builtin?: boolean
  mutating?: boolean
}

export function isOutwardTool(tool: ClassifiableTool): boolean {
  if (OUTWARD_BUILTIN_TOOL_IDS.has(tool.id)) return true
  const source = tool.source ?? (tool.builtin === false ? 'custom' : 'builtin')
  if (source === 'custom' || source === 'mcp') return tool.mutating !== false
  return false
}
