import { describe, expect, it } from 'vitest'
import {
  isMcpToolId,
  namespaceMcpToolId,
  namespaceMcpToolIds,
  MCP_TOOL_ID_PREFIX,
} from '../../../src/main/tools/mcp/naming'

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

  it('keeps two long names distinct after truncation (no collision)', () => {
    // Two names that share their first 64 chars must NOT collapse to one id,
    // which would silently dispatch one tool's calls to the other.
    const base = 'search_documents_in_knowledge_base_by_semantic_similarity_'
    const a = namespaceMcpToolId('srv', `${base}v1`)
    const b = namespaceMcpToolId('srv', `${base}v2`)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(b.length).toBeLessThanOrEqual(64)
    expect(a).not.toBe(b)
  })

  it('is deterministic for the same input', () => {
    const name = 'x'.repeat(120)
    expect(namespaceMcpToolId('srv', name)).toBe(namespaceMcpToolId('srv', name))
  })

  it('disambiguates names that sanitize to the same id', () => {
    // 'get.item' and 'get/item' both sanitize to 'get_item': without a
    // disambiguator the second tool would take over the first tool's id.
    const [a, b, c] = namespaceMcpToolIds('srv', ['get.item', 'get/item', 'other'])
    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(b.length).toBeLessThanOrEqual(64)
    // Untouched names keep their plain id (stored permissions stay valid).
    expect(c).toBe('mcp__srv__other')
  })

  it('the disambiguated ids do not depend on discovery order', () => {
    const forward = namespaceMcpToolIds('srv', ['a b', 'a:b'])
    const reversed = namespaceMcpToolIds('srv', ['a:b', 'a b'])
    expect(forward).toEqual([reversed[1], reversed[0]])
  })

  it('a single tool set with no collisions matches namespaceMcpToolId', () => {
    expect(namespaceMcpToolIds('srv', ['search', 'fetch'])).toEqual([
      namespaceMcpToolId('srv', 'search'),
      namespaceMcpToolId('srv', 'fetch'),
    ])
  })
})
