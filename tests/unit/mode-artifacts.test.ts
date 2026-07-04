import { describe, expect, it } from 'vitest'
import {
  extractCodeChanges,
  extractDocument,
  extractHtmlArtifacts,
  extractWorkspaceItems,
} from '../../src/main/services/mode-artifacts'

describe('extractDocument (Write mode)', () => {
  it('extracts the last uld-doc block with title and full body', () => {
    const content = [
      'Here is a draft:',
      '```uld-doc',
      '{"title":"My Essay"}',
      '# Intro',
      '',
      'Body text.',
      '```',
    ].join('\n')
    expect(extractDocument(content)).toEqual({
      title: 'My Essay',
      content: '# Intro\n\nBody text.',
    })
  })

  it('returns null when there is no document block', () => {
    expect(extractDocument('just chatting')).toBeNull()
  })
})

describe('extractHtmlArtifacts (Design mode)', () => {
  it('extracts uld-html prototypes', () => {
    const content = [
      '```uld-html',
      '{"title":"Landing"}',
      '<!doctype html><html><body>Hi</body></html>',
      '```',
    ].join('\n')
    const arts = extractHtmlArtifacts(content)
    expect(arts).toHaveLength(1)
    expect(arts[0].title).toBe('Landing')
    expect(arts[0].content).toContain('<!doctype html>')
  })
})

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
