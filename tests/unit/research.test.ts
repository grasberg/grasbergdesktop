/**
 * Deep Research pipeline units: depth budgets, the source registry (parsing,
 * dedupe, citation ids, title fallbacks), planner degradation, the
 * never-throws discipline, and the coupling between the REAL executor's
 * web_search output format and parseWebSearchResult.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ResearchActivity, ToolCallRecord } from '@shared/types'
import type { AdapterChatResult } from '../../src/main/providers/adapter'
import {
  RESEARCH_DEPTHS,
  SourceRegistry,
  extractHtmlTitle,
  normalizeUrl,
  parseWebSearchResult,
  runResearchPipeline,
  type ResearchChatOptions,
  type ResearchDeps,
} from '../../src/main/services/research'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { createToolSystem } from '../../src/main/tools'
import { makeFetchSequence } from '../helpers/mock-fetch'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEB_SEARCH_DEF = { name: 'web_search', description: 'search', parameters: {} }
const FETCH_URL_DEF = { name: 'fetch_url', description: 'fetch', parameters: {} }

let callSeq = 0
function toolCall(name: string, args: Record<string, unknown>): ToolCallRecord {
  return {
    id: `tc-${++callSeq}`,
    name,
    arguments: JSON.stringify(args),
    status: 'proposed',
  }
}

function textResult(text: string): AdapterChatResult {
  return { text, toolCalls: [], finishReason: 'stop' }
}

function toolsResult(calls: ToolCallRecord[]): AdapterChatResult {
  return { text: '', toolCalls: calls, finishReason: 'tool_calls' }
}

interface FakeDeps extends ResearchDeps {
  executed: ToolCallRecord[]
  activities: ResearchActivity[]
}

/**
 * Fake deps: `chat` scripted by the test; `executeTool` returns canned
 * search/page strings and records every executed call.
 */
function makeDeps(chat: (opts: ResearchChatOptions) => Promise<AdapterChatResult>): FakeDeps {
  const executed: ToolCallRecord[] = []
  const activities: ResearchActivity[] = []
  return {
    chat,
    executeTool: async (call) => {
      executed.push(call)
      if (call.name === 'web_search') {
        return '1. Example Site — https://example.com/a\n   A snippet about the topic.'
      }
      return 'HTTP 200 OK\n\n<html><head><title>Example Page</title></head><body>Facts.</body></html>'
    },
    listToolDefs: () => [WEB_SEARCH_DEF, FETCH_URL_DEF],
    emit: (activity) => {
      activities.push(activity)
    },
    signal: new AbortController().signal,
    executed,
    activities,
  }
}

const PLAN_JSON = JSON.stringify({ queries: ['topic one', 'topic two'] })

/** Scripts planner (JSON mode) vs worker calls; workers keyed by round. */
function scriptedChat(
  worker: (opts: ResearchChatOptions, toolRounds: number) => Promise<AdapterChatResult>
): (opts: ResearchChatOptions) => Promise<AdapterChatResult> {
  return (opts) => {
    if (opts.params.responseFormat === 'json') return Promise.resolve(textResult(PLAN_JSON))
    const toolRounds = opts.messages.filter((m) => m.role === 'tool').length
    return worker(opts, toolRounds)
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

describe('parseWebSearchResult', () => {
  it('parses the executor line format including snippets', () => {
    const hits = parseWebSearchResult(
      '1. First Result — https://a.example/x\n   Snippet one.\n2. Second — https://b.example/y'
    )
    expect(hits).toEqual([
      { title: 'First Result', url: 'https://a.example/x', snippet: 'Snippet one.' },
      { title: 'Second', url: 'https://b.example/y' },
    ])
  })

  it('splits on the LAST separator so titles may contain " — "', () => {
    const hits = parseWebSearchResult('1. Pros — and cons — https://a.example/x')
    expect(hits).toEqual([{ title: 'Pros — and cons', url: 'https://a.example/x' }])
  })

  it('skips non-result lines and non-http urls', () => {
    expect(parseWebSearchResult('No results found for "x".')).toEqual([])
    expect(parseWebSearchResult('1. Weird — ftp://a.example/x')).toEqual([])
  })
})

describe('extractHtmlTitle / normalizeUrl', () => {
  it('extracts and cleans a <title>', () => {
    expect(extractHtmlTitle('<html><title>A &amp; B &#39;quoted&#39;</title></html>')).toBe(
      "A & B 'quoted'"
    )
    expect(extractHtmlTitle('<html><body>no title</body></html>')).toBeNull()
  })

  it('normalizes hash, tracking params, host case and bare trailing slash', () => {
    expect(normalizeUrl('https://EXAMPLE.com/?utm_source=x&q=1#frag')).toBe(
      'https://example.com/?q=1'
    )
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com')
    expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path/')
    expect(normalizeUrl('not a url')).toBe('not a url')
  })
})

// ---------------------------------------------------------------------------
// SourceRegistry
// ---------------------------------------------------------------------------

describe('SourceRegistry', () => {
  it('dedupes search + fetch of the same url into one fetched source, keeping the search title', () => {
    const registry = new SourceRegistry()
    registry.observe(
      toolCall('web_search', { query: 'q' }),
      '1. Search Title — https://example.com/a?utm_campaign=x\n   Snip.'
    )
    registry.observe(
      toolCall('fetch_url', { url: 'https://EXAMPLE.com/a' }),
      'HTTP 200 OK\n\n<title>Page Title</title>'
    )
    const sources = registry.finalize(10, '')
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      id: 1,
      title: 'Search Title',
      snippet: 'Snip.',
      status: 'fetched',
    })
    expect(registry.searches).toBe(1)
    expect(registry.pagesRead).toBe(1)
  })

  it('titles a fetch-only source from <title>, falling back to the hostname', () => {
    const registry = new SourceRegistry()
    registry.observe(
      toolCall('fetch_url', { url: 'https://titled.example/p' }),
      'HTTP 200 OK\n\n<title>Fetched Title</title>'
    )
    registry.observe(toolCall('fetch_url', { url: 'https://bare.example/p' }), 'HTTP 200 OK\n\nplain text')
    const sources = registry.finalize(10, '')
    expect(sources.map((s) => s.title)).toEqual(['Fetched Title', 'bare.example'])
  })

  it('includes search-only candidates only when the findings reference their url', () => {
    const registry = new SourceRegistry()
    registry.observe(
      toolCall('web_search', { query: 'q' }),
      '1. Cited — https://cited.example/x\n2. Ignored — https://ignored.example/y'
    )
    const sources = registry.finalize(10, 'Fact from https://cited.example/x it seems.')
    expect(sources.map((s) => s.url)).toEqual(['https://cited.example/x'])
    expect(sources[0].status).toBe('search-only')
  })

  it('caps at maxSources with fetched sources first and marks failed fetches', () => {
    const registry = new SourceRegistry()
    registry.observe(
      toolCall('web_search', { query: 'q' }),
      '1. A — https://a.example/1\n2. B — https://b.example/2\n3. C — https://c.example/3'
    )
    registry.observe(toolCall('fetch_url', { url: 'https://c.example/3' }), 'HTTP 200 OK\n\nok')
    registry.observe(toolCall('fetch_url', { url: 'https://d.example/4' }), 'HTTP 404 Not Found\n\nno')
    const referenced = 'https://a.example/1 https://b.example/2'
    const sources = registry.finalize(3, referenced)
    expect(sources).toHaveLength(3)
    expect(sources[0].url).toBe('https://c.example/3')
    expect(sources[0].status).toBe('fetched')
    expect(sources[1].url).toBe('https://d.example/4')
    expect(sources[1].status).toBe('error')
    expect(sources.map((s) => s.id)).toEqual([1, 2, 3])
  })
})

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

describe('runResearchPipeline', () => {
  it('plans, gathers with parallel workers, and builds a cited synthesis context', async () => {
    const deps = makeDeps(
      scriptedChat(async (opts, toolRounds) => {
        if (toolRounds === 0) return toolsResult([toolCall('web_search', { query: 'sub q' })])
        if (toolRounds === 1) {
          return toolsResult([toolCall('fetch_url', { url: 'https://example.com/a' })])
        }
        return textResult('Finding: facts from https://example.com/a hold.')
      })
    )
    const outcome = await runResearchPipeline('big question', 'quick', deps)

    expect(outcome.research.plan).toEqual(['topic one', 'topic two'])
    expect(outcome.research.searches).toBe(2)
    expect(outcome.research.pagesRead).toBe(2)
    expect(outcome.research.sources).toHaveLength(1) // deduped across workers
    expect(outcome.research.sources[0]).toMatchObject({
      id: 1,
      url: 'https://example.com/a',
      title: 'Example Site',
      status: 'fetched',
    })
    expect(outcome.injectedContext).toContain('### Topic: topic one')
    expect(outcome.injectedContext).toContain('[1] Example Site — https://example.com/a')
    expect(outcome.injectedContext).toContain('Cite claims inline with [n]')

    // Activities: planning done, per-call searching/reading, synthesizing.
    const phases = new Set(deps.activities.map((a) => a.phase))
    expect(phases).toEqual(new Set(['planning', 'searching', 'reading', 'synthesizing']))
    expect(deps.activities.find((a) => a.id === 'plan' && a.status === 'done')).toBeTruthy()
  })

  it('enforces the per-worker round budget', async () => {
    const deps = makeDeps((opts) => {
      if (opts.params.responseFormat === 'json') {
        return Promise.resolve(textResult(JSON.stringify({ queries: ['only'] })))
      }
      // The worker asks for another search every single round.
      return Promise.resolve(toolsResult([toolCall('web_search', { query: 'again' })]))
    })
    const outcome = await runResearchPipeline('q', 'quick', deps)
    expect(deps.executed).toHaveLength(RESEARCH_DEPTHS.quick.roundsPerWorker)
    expect(outcome.research.searches).toBe(RESEARCH_DEPTHS.quick.roundsPerWorker)
  })

  it('enforces the per-worker fetch budget without executing over-budget calls', async () => {
    const deps = makeDeps(
      scriptedChat(async (opts, toolRounds) => {
        if (toolRounds === 0) {
          // One round asking for 4 fetches at once (quick allows 2).
          return toolsResult([
            toolCall('fetch_url', { url: 'https://a.example/1' }),
            toolCall('fetch_url', { url: 'https://a.example/2' }),
            toolCall('fetch_url', { url: 'https://a.example/3' }),
            toolCall('fetch_url', { url: 'https://a.example/4' }),
          ])
        }
        return textResult('done')
      })
    )
    // Planner returns two queries; each worker has its own fetch budget.
    await runResearchPipeline('q', 'quick', deps)
    const fetches = deps.executed.filter((c) => c.name === 'fetch_url')
    expect(fetches).toHaveLength(RESEARCH_DEPTHS.quick.fetchesPerWorker * 2)
  })

  it('declines tools outside web_search/fetch_url without executing them', async () => {
    let declineText = ''
    const deps = makeDeps(
      scriptedChat(async (opts, toolRounds) => {
        if (toolRounds === 0) return toolsResult([toolCall('run_shell_command', { command: 'ls' })])
        const tool = opts.messages.filter((m) => m.role === 'tool').at(-1)
        declineText = typeof tool?.content === 'string' ? tool.content : ''
        return textResult('done anyway')
      })
    )
    const outcome = await runResearchPipeline('q', 'quick', deps)
    expect(deps.executed).toHaveLength(0)
    expect(declineText).toContain("not available to research workers")
    expect(outcome.research.sources).toHaveLength(0)
  })

  it('degrades to the raw question when the planner returns garbage', async () => {
    const deps = makeDeps((opts) => {
      if (opts.params.responseFormat === 'json') {
        return Promise.resolve(textResult('sorry, no JSON from me'))
      }
      return Promise.resolve(textResult('findings'))
    })
    const outcome = await runResearchPipeline('the raw question', 'quick', deps)
    expect(outcome.research.plan).toEqual(['the raw question'])
  })

  it('never rejects: total model failure yields the degraded outcome', async () => {
    const deps = makeDeps(async () => {
      throw new Error('provider down')
    })
    const outcome = await runResearchPipeline('q', 'standard', deps)
    expect(outcome.research.sources).toHaveLength(0)
    expect(outcome.research.plan).toEqual(['q']) // planner failure fallback
    expect(outcome.injectedContext).toContain('research for this question failed')
  })

  it('sums planner + worker usage into workerUsage', async () => {
    const deps = makeDeps(
      scriptedChat(async () => ({
        text: 'findings',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }))
    )
    // Planner (no usage in PLAN_JSON path — scriptedChat returns textResult
    // without usage) + two workers with usage each.
    const outcome = await runResearchPipeline('q', 'quick', deps)
    expect(outcome.research.workerUsage?.totalTokens).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// Coupling: the REAL executor's web_search output must stay parseable
// ---------------------------------------------------------------------------

describe('real executor web_search → parseWebSearchResult coupling', () => {
  let dir: string
  let db: AppDatabase

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uld-research-exec-'))
    db = openDatabase(join(dir, 'app.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const conversation: Conversation = {
    id: 'conv-r',
    mode: 'chat',
    title: 'r',
    providerId: null,
    modelId: null,
    systemPrompt: null,
    params: {},
    workspaceId: null,
    projectId: null,
    projectRef: null,
    moaPresetId: null,
    createdAt: 0,
    updatedAt: 0,
  }

  it('parses hits from the executor output for a DuckDuckGo HTML page', async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://example.com/a">Example <b>Site</b></a>
        <a class="result__snippet">A snippet about needles.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://beta.example/x">Beta — Dashes</a>
        <a class="result__snippet">Second snippet.</a>
      </div>`
    const fetchImpl = makeFetchSequence(
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
    )
    const { executor } = createToolSystem(db, null, { fetchImpl })
    const approval = vi.fn(async () => ({ approved: true, scope: 'once' as const }))
    const result = await executor.execute(
      { id: 't1', name: 'web_search', arguments: '{"query":"needles"}', status: 'proposed' },
      { conversation, approval }
    )

    const hits = parseWebSearchResult(result)
    expect(hits.map((h) => h.url)).toEqual(['https://example.com/a', 'https://beta.example/x'])
    expect(hits[0].title).toContain('Example')
    expect(hits[0].snippet).toContain('needles')
    // The title's own " — " must not break url extraction (last-separator split).
    expect(hits[1].title).toContain('Beta')
  })

  it("permission 'deny' on web_search yields a refusal string the pipeline survives", async () => {
    const { registry, executor } = createToolSystem(db, null, {
      fetchImpl: makeFetchSequence(),
    })
    registry.setPermission('web_search', 'deny')
    const approval = vi.fn(async () => ({ approved: true, scope: 'once' as const }))
    const result = await executor.execute(
      { id: 't1', name: 'web_search', arguments: '{"query":"x"}', status: 'proposed' },
      { conversation, approval }
    )
    expect(result).toMatch(/denied/i)
    // Feeding the refusal into the registry records nothing.
    const reg = new SourceRegistry()
    reg.observe({ id: 't1', name: 'web_search', arguments: '{"query":"x"}', status: 'done' }, result)
    expect(reg.finalize(5, result)).toHaveLength(0)
    expect(reg.searches).toBe(1)
  })
})
