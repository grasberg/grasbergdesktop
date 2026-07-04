/**
 * Minimal Server-Sent Events parser for streaming chat completions.
 *
 * Yields the data payload of each event (multi-line `data:` fields joined with
 * '\n'). Tolerates CRLF/LF line endings and chunk boundaries that split lines
 * or UTF-8 sequences. Stops cleanly on the OpenAI '[DONE]' sentinel (which is
 * not yielded) and on stream end. Aborting `signal` rejects with an 'aborted'
 * ProviderError and cancels the underlying stream.
 */

import { ProviderError, abortedError } from './errors'

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let dataLines: string[] = []

  let onAbort: (() => void) | undefined
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(abortedError())
        signal.addEventListener('abort', onAbort!, { once: true })
      })
    : undefined
  // Pre-attach a handler so a late abort never surfaces as an unhandled rejection.
  abortPromise?.catch(() => {})

  // Processes one complete line; returns the event payload when the line
  // terminates an event, the '[DONE]' sentinel included (caller filters it).
  const feedLine = (rawLine: string): string | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      if (dataLines.length === 0) return undefined
      const payload = dataLines.join('\n')
      dataLines = []
      return payload
    }
    if (line.startsWith(':')) return undefined // comment / keep-alive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    // event:/id:/retry: fields are irrelevant for our providers.
    return undefined
  }

  try {
    if (signal?.aborted) throw abortedError()
    while (true) {
      let result: Awaited<ReturnType<typeof reader.read>>
      try {
        const readPromise = reader.read()
        if (abortPromise) {
          // If abort wins the race, the still-pending read must not become
          // an unhandled rejection later.
          readPromise.catch(() => {})
          result = await Promise.race([readPromise, abortPromise])
        } else {
          result = await readPromise
        }
      } catch (e) {
        if (e instanceof ProviderError) throw e
        if (e instanceof Error && e.name === 'AbortError') throw abortedError()
        throw new ProviderError('network', 'Connection lost while streaming the response.', {
          retryable: false,
          cause: e,
        })
      }
      if (result.done) break

      buffer += decoder.decode(result.value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const payload = feedLine(line)
        if (payload !== undefined) {
          if (payload === '[DONE]') return
          yield payload
        }
      }
    }

    // Flush any buffered decoder state and a final line without trailing
    // newline, then dispatch a pending event that was never terminated.
    buffer += decoder.decode()
    if (buffer.length > 0) {
      const payload = feedLine(buffer)
      if (payload !== undefined && payload !== '[DONE]') yield payload
    }
    if (dataLines.length > 0) {
      const payload = dataLines.join('\n')
      dataLines = []
      if (payload !== '[DONE]') yield payload
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    try {
      await reader.cancel()
    } catch {
      // Underlying stream may already be errored/closed — nothing to do.
    }
  }
}
