import { describe, expect, it } from 'vitest'
import {
  extractCodeChanges,
  extractMemoryDirectives,
  extractWorkspaceItems,
} from '../../src/main/services/mode-artifacts'

describe('extractCodeChanges', () => {
  it('extracts a single create block with its full content', () => {
    const content = [
      'Here is the new file:',
      '',
      '```uld-change',
      '{"path":"src/hello.ts","type":"create"}',
      'export function hello(): string {',
      "  return 'hi'",
      '}',
      '```',
      '',
      'Let me know what you think.',
    ].join('\n')

    const changes = extractCodeChanges(content)
    expect(changes).toHaveLength(1)
    expect(changes[0].path).toBe('src/hello.ts')
    expect(changes[0].type).toBe('create')
    expect(changes[0].newContent).toBe(
      "export function hello(): string {\n  return 'hi'\n}\n"
    )
  })

  it('extracts multiple blocks in document order', () => {
    const content = [
      '```uld-change',
      '{"path":"a.txt","type":"edit"}',
      'new a',
      '```',
      'and also:',
      '```uld-change',
      '{"path":"b.txt","type":"delete"}',
      '```',
    ].join('\n')

    const changes = extractCodeChanges(content)
    expect(changes.map((c) => c.path)).toEqual(['a.txt', 'b.txt'])
    expect(changes[0].type).toBe('edit')
    expect(changes[0].newContent).toBe('new a\n')
    expect(changes[1].type).toBe('delete')
    expect(changes[1].newContent).toBe('')
  })

  it('skips malformed blocks without throwing', () => {
    const content = [
      '```uld-change',
      'not json at all',
      'body',
      '```',
      '```uld-change',
      '{"path":"","type":"edit"}',
      'empty path',
      '```',
      '```uld-change',
      '{"path":"ok.txt","type":"overwrite"}',
      'bad type',
      '```',
      '```uld-change',
      '{"type":"edit"}',
      'missing path',
      '```',
      '```uld-change',
      '{"path":"good.txt","type":"edit"}',
      'kept',
      '```',
    ].join('\n')

    const changes = extractCodeChanges(content)
    expect(changes).toHaveLength(1)
    expect(changes[0].path).toBe('good.txt')
    expect(changes[0].newContent).toBe('kept\n')
  })

  it('ignores ordinary code fences and unterminated blocks', () => {
    const content = [
      '```ts',
      '{"path":"not-a-change.ts","type":"create"}',
      'const x = 1',
      '```',
      '```uld-change',
      '{"path":"never-closed.txt","type":"create"}',
      'no closing fence here',
    ].join('\n')

    expect(extractCodeChanges(content)).toEqual([])
  })

  it('handles CRLF content', () => {
    const content =
      '```uld-change\r\n{"path":"win.txt","type":"create"}\r\nline one\r\n```\r\n'
    const changes = extractCodeChanges(content)
    expect(changes).toHaveLength(1)
    expect(changes[0].path).toBe('win.txt')
    expect(changes[0].newContent).toBe('line one\r\n')
  })
})

describe('extractWorkspaceItems', () => {
  it('extracts a checklist item with its markdown body', () => {
    const content = [
      'Suggested plan:',
      '```uld-item',
      '{"kind":"checklist","title":"Launch checklist"}',
      '- [ ] Write copy',
      '- [ ] Review design',
      '- [x] Book venue',
      '```',
    ].join('\n')

    const items = extractWorkspaceItems(content)
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('checklist')
    expect(items[0].title).toBe('Launch checklist')
    expect(items[0].content).toBe('- [ ] Write copy\n- [ ] Review design\n- [x] Book venue')
  })

  it('extracts multiple items and skips malformed ones', () => {
    const content = [
      '```uld-item',
      '{"kind":"note","title":"First"}',
      'note body',
      '```',
      '```uld-item',
      '{"kind":"spreadsheet","title":"Bad kind"}',
      'skipped',
      '```',
      '```uld-item',
      '{"kind":"task","title":"   "}',
      'blank title -> skipped',
      '```',
      '```uld-item',
      'garbage header',
      'skipped too',
      '```',
      '```uld-item',
      '{"kind":"plan","title":"Second"}',
      '1. step one',
      '2. step two',
      '```',
    ].join('\n')

    const items = extractWorkspaceItems(content)
    expect(items.map((i) => i.title)).toEqual(['First', 'Second'])
    expect(items[0].kind).toBe('note')
    expect(items[1].kind).toBe('plan')
    expect(items[1].content).toBe('1. step one\n2. step two')
  })

  it('allows an empty body (title-only item)', () => {
    const content = ['```uld-item', '{"kind":"task","title":"Just do it"}', '```'].join('\n')
    const items = extractWorkspaceItems(content)
    expect(items).toHaveLength(1)
    expect(items[0].content).toBe('')
  })

  it('parses a valid status from the header', () => {
    const content = [
      '```uld-item',
      '{"kind":"task","title":"Ship it","status":"doing"}',
      'working on it',
      '```',
    ].join('\n')
    const items = extractWorkspaceItems(content)
    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('doing')
  })

  it('ignores an invalid or non-string status without dropping the item', () => {
    const content = [
      '```uld-item',
      '{"kind":"task","title":"Bad status","status":"blocked"}',
      'body',
      '```',
      '```uld-item',
      '{"kind":"task","title":"Numeric status","status":1}',
      'body',
      '```',
    ].join('\n')
    const items = extractWorkspaceItems(content)
    expect(items.map((i) => i.title)).toEqual(['Bad status', 'Numeric status'])
    expect(items[0].status).toBeUndefined()
    expect(items[1].status).toBeUndefined()
  })

  it('does not cross-match uld-change and uld-item blocks', () => {
    const content = [
      '```uld-change',
      '{"path":"x.txt","type":"create"}',
      'file body',
      '```',
    ].join('\n')
    expect(extractWorkspaceItems(content)).toEqual([])
    expect(extractCodeChanges(content)).toHaveLength(1)
  })
})

describe('extractMemoryDirectives', () => {
  it('extracts a remember directive with a multiline body (trailing whitespace trimmed)', () => {
    const content = [
      'Noted — saving that.',
      '```uld-memory',
      '{"title":"preferred-language","action":"remember"}',
      'The user prefers answers in Swedish.',
      '',
      'Formal tone.  ',
      '```',
    ].join('\n')
    const directives = extractMemoryDirectives(content)
    expect(directives).toHaveLength(1)
    expect(directives[0]).toEqual({
      action: 'remember',
      title: 'preferred-language',
      content: 'The user prefers answers in Swedish.\n\nFormal tone.',
    })
  })

  it('defaults action to remember when the header omits it', () => {
    const content = ['```uld-memory', '{"title":"role"}', 'Backend developer.', '```'].join('\n')
    const directives = extractMemoryDirectives(content)
    expect(directives).toHaveLength(1)
    expect(directives[0].action).toBe('remember')
  })

  it('extracts a forget directive with empty content regardless of body', () => {
    const content = [
      '```uld-memory',
      '{"title":"old-fact","action":"forget"}',
      'this body is ignored',
      '```',
    ].join('\n')
    const directives = extractMemoryDirectives(content)
    expect(directives).toHaveLength(1)
    expect(directives[0]).toEqual({ action: 'forget', title: 'old-fact', content: '' })
  })

  it('skips malformed blocks: blank title, unknown action, bad JSON, empty remember body', () => {
    const content = [
      '```uld-memory',
      '{"title":"   "}',
      'blank title',
      '```',
      '```uld-memory',
      '{"title":"x","action":"archive"}',
      'unknown action',
      '```',
      '```uld-memory',
      'not json',
      'bad header',
      '```',
      '```uld-memory',
      '{"title":"empty-body"}',
      '```',
      '```uld-memory',
      '{"title":"kept"}',
      'valid memory',
      '```',
    ].join('\n')
    const directives = extractMemoryDirectives(content)
    expect(directives).toHaveLength(1)
    expect(directives[0].title).toBe('kept')
  })

  it('extracts multiple directives in document order', () => {
    const content = [
      '```uld-memory',
      '{"title":"a"}',
      'first',
      '```',
      'and',
      '```uld-memory',
      '{"title":"b","action":"forget"}',
      '```',
    ].join('\n')
    expect(extractMemoryDirectives(content).map((d) => d.title)).toEqual(['a', 'b'])
  })

  it('does not cross-match other uld block types', () => {
    const content = [
      '```uld-item',
      '{"kind":"note","title":"Not a memory"}',
      'workspace item',
      '```',
    ].join('\n')
    expect(extractMemoryDirectives(content)).toEqual([])
  })
})
