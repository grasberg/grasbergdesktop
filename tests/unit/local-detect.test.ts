import { describe, expect, it } from 'vitest'
import { detectLocalServers } from '../../src/main/providers/local-detect'

function fetchStub(
  handler: (url: string) => Response | Promise<Response>
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => handler(String(input))) as typeof fetch
}

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('detectLocalServers', () => {
  it('reports a running Ollama with its model ids', async () => {
    const found = await detectLocalServers({
      fetchImpl: fetchStub((url) => {
        if (url === 'http://localhost:11434/v1/models') {
          return modelsResponse(['llama3.2', 'qwen2.5-coder'])
        }
        throw new Error('ECONNREFUSED')
      }),
    })
    expect(found).toEqual([
      {
        kind: 'ollama',
        name: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        models: ['llama3.2', 'qwen2.5-coder'],
      },
    ])
  })

  it('reports multiple servers and ignores unreachable ports', async () => {
    const found = await detectLocalServers({
      fetchImpl: fetchStub((url) => {
        if (url.startsWith('http://localhost:11434/')) return modelsResponse(['llama3.2'])
        if (url.startsWith('http://localhost:1234/')) return modelsResponse([])
        throw new Error('ECONNREFUSED')
      }),
    })
    expect(found.map((s) => s.kind)).toEqual(['ollama', 'lmstudio'])
    expect(found[1]!.models).toEqual([])
  })

  it('ignores non-OK responses and malformed bodies', async () => {
    const found = await detectLocalServers({
      fetchImpl: fetchStub((url) => {
        if (url.startsWith('http://localhost:11434/')) return new Response('nope', { status: 404 })
        if (url.startsWith('http://localhost:1234/')) return new Response('not json', { status: 200 })
        if (url.startsWith('http://localhost:1337/')) {
          // OK but the body has no data array — still a valid (empty) hit.
          return new Response(JSON.stringify({ object: 'list' }), { status: 200 })
        }
        throw new Error('ECONNREFUSED')
      }),
    })
    expect(found.map((s) => s.kind)).toEqual(['jan'])
    expect(found[0]!.models).toEqual([])
  })

  it('returns [] when nothing is running', async () => {
    const found = await detectLocalServers({
      fetchImpl: fetchStub(() => {
        throw new Error('ECONNREFUSED')
      }),
    })
    expect(found).toEqual([])
  })

  it('only ever probes loopback URLs', async () => {
    const urls: string[] = []
    await detectLocalServers({
      fetchImpl: fetchStub((url) => {
        urls.push(url)
        throw new Error('ECONNREFUSED')
      }),
    })
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith('http://localhost:'))).toBe(true)
  })
})
