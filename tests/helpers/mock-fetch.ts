/**
 * Fetch-mocking utilities for adapter tests. No test framework dependency —
 * plain factories so they compose with vi.fn or direct injection alike.
 */

export interface RecordedRequest {
  url: string
  init: RequestInit | undefined
  /** JSON-parsed request body when the body was a parseable string. */
  body: unknown
}

export function makeJsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/**
 * Builds an SSE Response whose body enqueues exactly the given chunks, so the
 * test controls chunk boundaries. Uint8Array chunks allow splitting a
 * multi-byte UTF-8 sequence across reads.
 */
export function makeSSEResponse(chunks: Array<string | Uint8Array>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

export type FetchStep = Response | Error | (() => Response | Promise<Response>)

/** First parameter of fetch (`RequestInfo | URL`, spelled portably for @types/node). */
type FetchInput = string | URL | Request

export interface FetchMock {
  (input: FetchInput, init?: RequestInit): Promise<Response>
  requests: RecordedRequest[]
}

/**
 * Returns a fetch-compatible mock replaying the given responses (or throwing
 * the given errors) in order, recording every request it receives. Any call
 * beyond the provided sequence throws.
 */
export function makeFetchSequence(...steps: FetchStep[]): FetchMock {
  let next = 0
  const requests: RecordedRequest[] = []

  const mock = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    let parsedBody: unknown
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body)
      } catch {
        parsedBody = init.body
      }
    }
    requests.push({ url: String(input), init, body: parsedBody })

    if (next >= steps.length) {
      throw new Error(`makeFetchSequence: unexpected fetch call #${next + 1} to ${String(input)}`)
    }
    const step = steps[next++]
    if (step instanceof Error) throw step
    if (typeof step === 'function') return step()
    return step
  }) as FetchMock
  mock.requests = requests
  return mock
}
