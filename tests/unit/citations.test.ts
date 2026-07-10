import { describe, expect, it } from 'vitest'
import type { ResearchSource } from '@shared/types'
import { formatSourcesSection, linkifyCitations } from '@shared/citations'

function source(id: number, url: string, title = `Title ${id}`): ResearchSource {
  return { id, url, title, status: 'fetched' }
}

describe('linkifyCitations', () => {
  const sources = [source(1, 'https://a.example/x'), source(2, 'https://b.example/y')]

  it('turns bare [n] markers into markdown links with the marker as text', () => {
    expect(linkifyCitations('Heat pumps win [1].', sources)).toBe(
      'Heat pumps win [[1]](https://a.example/x).'
    )
  })

  it('handles adjacent markers and repeated use', () => {
    expect(linkifyCitations('Both agree [1][2], see [1].', sources)).toBe(
      'Both agree [[1]](https://a.example/x)[[2]](https://b.example/y), see [[1]](https://a.example/x).'
    )
  })

  it('leaves out-of-range ids as plain text', () => {
    expect(linkifyCitations('Unknown [7] stays.', sources)).toBe('Unknown [7] stays.')
  })

  it('never touches markers that already are links', () => {
    const already = 'Linked [1](https://other.example) stays.'
    expect(linkifyCitations(already, sources)).toBe(already)
  })

  it('skips code fences and inline code', () => {
    const md = 'Use `arr[1]` here.\n\n```js\nconst x = a[1]\n```\n\nReal cite [1].'
    expect(linkifyCitations(md, sources)).toBe(
      'Use `arr[1]` here.\n\n```js\nconst x = a[1]\n```\n\nReal cite [[1]](https://a.example/x).'
    )
  })

  it('is a no-op with no sources', () => {
    expect(linkifyCitations('Nothing [1].', [])).toBe('Nothing [1].')
  })
})

describe('formatSourcesSection', () => {
  it('renders a deterministic numbered markdown list', () => {
    const text = formatSourcesSection([
      source(1, 'https://a.example/x', 'Alpha'),
      source(2, 'https://b.example/y', 'Beta'),
    ])
    expect(text).toBe('## Sources\n\n1. [Alpha](https://a.example/x)\n2. [Beta](https://b.example/y)')
  })

  it('keeps titles from breaking the link syntax and falls back to the url', () => {
    const text = formatSourcesSection([
      source(1, 'https://a.example/x', 'Bad [brackets] here'),
      source(2, 'https://b.example/y', '   '),
    ])
    expect(text).toContain('1. [Bad (brackets) here](https://a.example/x)')
    expect(text).toContain('2. [https://b.example/y](https://b.example/y)')
  })
})
