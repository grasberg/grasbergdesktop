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

/**
 * Short deterministic hash (djb2 → base36) for disambiguating truncated ids.
 * Keeps the LOW-order base36 digits: names that differ only near the end (e.g.
 * '…_v1' vs '…_v2') differ in the low bits, so slicing the high digits would
 * collide.
 */
function shortHash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0
  }
  return h.toString(36).padStart(6, '0').slice(-6)
}

/** Appends `_<hash>`, keeping the id within the 64-char cap. */
function withHash(id: string, hash: string): string {
  const suffix = `_${hash}`
  if (id.length + suffix.length <= MAX_TOOL_ID_LENGTH) return id + suffix
  return id.slice(0, MAX_TOOL_ID_LENGTH - suffix.length) + suffix
}

/**
 * 'mcp__<key>__<sanitizedName>' capped at 64 chars. When the full id exceeds
 * the cap, a short hash of it is appended so two long tool names that share
 * their first 64 chars can't collapse to the same id (which would silently
 * dispatch one tool's calls to the other and conflate their permissions).
 */
export function namespaceMcpToolId(serverKey: string, toolName: string): string {
  const sanitized = toolName.replace(/[^A-Za-z0-9_-]/g, '_')
  const id = `${MCP_TOOL_ID_PREFIX}${serverKey}__${sanitized}`
  if (id.length <= MAX_TOOL_ID_LENGTH) return id
  return withHash(id, shortHash(id))
}

/**
 * Ids for a server's whole discovered tool set, in input order. Sanitization is
 * lossy, so two distinct names ('get.item' and 'get/item') can produce the same
 * id — the SAME misdispatch/permission-conflation the length cap's hash guards
 * against. Every name in a colliding group gets a hash of its ORIGINAL name
 * appended, so the result never depends on discovery order.
 */
export function namespaceMcpToolIds(serverKey: string, toolNames: string[]): string[] {
  const ids = toolNames.map((name) => namespaceMcpToolId(serverKey, name))
  const counts = new Map<string, number>()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  return ids.map((id, i) =>
    (counts.get(id) ?? 0) > 1 ? withHash(id, shortHash(toolNames[i])) : id
  )
}
