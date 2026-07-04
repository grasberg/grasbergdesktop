import { describe, expect, it } from 'vitest'
import { isMcpToolId, namespaceMcpToolId, MCP_TOOL_ID_PREFIX } from '../../../src/main/tools/mcp/naming'

describe('MCP tool id namespacing', () => {
  it('namespaces and recognizes ids', () => {
    const id = namespaceMcpToolId('abc123', 'search')
    expect(id).toBe('mcp__abc123__search')
    expect(isMcpToolId(id)).toBe(true)
    expect(isMcpToolId('file_search')).toBe(false)
    expect(isMcpToolId('custom:x')).toBe(false)
  })

  it('sanitizes disallowed characters', () => {
    expect(namespaceMcpToolId('srv', 'do something!')).toBe('mcp__srv__do_something_')
  })

  it('caps ids at 64 characters', () => {
    const id = namespaceMcpToolId('srv', 'x'.repeat(100))
    expect(id.length).toBeLessThanOrEqual(64)
    expect(id.startsWith(MCP_TOOL_ID_PREFIX)).toBe(true)
  })
})
