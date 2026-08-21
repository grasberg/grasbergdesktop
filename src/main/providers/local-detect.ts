/**
 * Best-effort detection of OpenAI-compatible model servers on localhost
 * (Ollama, LM Studio, Jan, llama.cpp) for the zero-key first chat: probes
 * each well-known port's /v1/models with a short timeout. Read-only and
 * never throws — an unreachable or non-conforming port is simply absent
 * from the result. Only ever talks to loopback URLs.
 */

import type { LocalServerInfo } from '@shared/ipc'

const CANDIDATES: ReadonlyArray<{ kind: LocalServerInfo['kind']; name: string; port: number }> = [
  { kind: 'ollama', name: 'Ollama', port: 11434 },
  { kind: 'lmstudio', name: 'LM Studio', port: 1234 },
  { kind: 'jan', name: 'Jan', port: 1337 },
  { kind: 'llamacpp', name: 'llama.cpp', port: 8080 },
]

const PROBE_TIMEOUT_MS = 800
/** A models list is tiny; anything bigger is not the endpoint we expect. */
const PROBE_MAX_BYTES = 256 * 1024

export interface LocalDetectDeps {
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Reads at most `maxBytes` of the body, then cancels the rest — whatever is
 * listening on a well-known port could stream an arbitrarily large response,
 * and res.json() would buffer all of it in the main process.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes)
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let out = ''
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The body may already be closed/errored — nothing to do.
    }
  }
  return (out + decoder.decode()).slice(0, maxBytes)
}

function parseModelIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data
    .map((entry) => (entry as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

export async function detectLocalServers(deps: LocalDetectDeps = {}): Promise<LocalServerInfo[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const probes = CANDIDATES.map(async (candidate): Promise<LocalServerInfo | null> => {
    const baseUrl = `http://localhost:${candidate.port}/v1`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const res = await fetchImpl(`${baseUrl}/models`, { signal: controller.signal })
      if (!res.ok) return null
      const models = parseModelIds(JSON.parse(await readCapped(res, PROBE_MAX_BYTES)))
      return { kind: candidate.kind, name: candidate.name, baseUrl, models }
    } catch {
      return null // not running / not OpenAI-compatible / timed out
    } finally {
      clearTimeout(timer)
    }
  })
  return (await Promise.all(probes)).filter((r): r is LocalServerInfo => r !== null)
}
