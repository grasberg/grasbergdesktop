import { describe, expect, it, vi } from 'vitest'
import { TelegramBridge } from '../../../src/main/im/telegram'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

describe('TelegramBridge.pollOnce', () => {
  it('handles a text message: calls onMessage and sends the reply', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).includes('getUpdates')) {
        return jsonResponse({
          ok: true,
          result: [{ update_id: 10, message: { text: 'hello', chat: { id: 42 } } }],
        })
      }
      return jsonResponse({ ok: true })
    })
    const onMessage = vi.fn(async (_chatId: number, text: string) => `echo: ${text}`)
    const bridge = new TelegramBridge({ token: 'TOKEN', onMessage, fetchImpl: fetchImpl as unknown as typeof fetch })

    await bridge.pollOnce()

    expect(onMessage).toHaveBeenCalledWith(42, 'hello')
    const sendCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('sendMessage'))
    expect(sendCall).toBeDefined()
    const init = sendCall![1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({ chat_id: 42, text: 'echo: hello' })
    // The bot token is in the URL path, not leaked into logs by us.
    expect(String(sendCall![0])).toContain('/botTOKEN/')
  })

  it('ignores non-text updates and advances the offset', async () => {
    const fetchImpl = vi.fn(async (_url?: string | URL | Request) =>
      jsonResponse({ ok: true, result: [{ update_id: 5, message: { chat: { id: 1 } } }] })
    )
    const onMessage = vi.fn(async () => 'x')
    const bridge = new TelegramBridge({ token: 't', onMessage, fetchImpl: fetchImpl as unknown as typeof fetch })
    await bridge.pollOnce()
    expect(onMessage).not.toHaveBeenCalled()
    // Next poll uses offset 6.
    await bridge.pollOnce()
    expect(String(fetchImpl.mock.calls[1][0])).toContain('offset=6')
  })

  it('replies with an error message when onMessage throws', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).includes('getUpdates')
        ? jsonResponse({ ok: true, result: [{ update_id: 1, message: { text: 'hi', chat: { id: 7 } } }] })
        : jsonResponse({ ok: true })
    )
    const bridge = new TelegramBridge({
      token: 't',
      onMessage: async () => {
        throw new Error('no provider')
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await bridge.pollOnce()
    const sendCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('sendMessage'))!
    expect(JSON.parse(String((sendCall[1] as RequestInit).body)).text).toMatch(/no provider/i)
  })

  it('raises an API error (ok:false) so the loop backs off instead of spinning', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error_code: 409, description: 'Conflict' })
    )
    const bridge = new TelegramBridge({
      token: 't',
      onMessage: async () => 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(bridge.pollOnce()).rejects.toThrow(/telegram api error/i)
  })
})

describe('TelegramBridge.loop', () => {
  it('backs off between polls and gives up after repeated token rejections', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, error_code: 401 }))
      const onError = vi.fn()
      const bridge = new TelegramBridge({
        token: 'revoked',
        onMessage: async () => 'x',
        onError,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      bridge.start()
      // A minute of a hot loop would be hundreds of requests; five is the cap.
      await vi.advanceTimersByTimeAsync(60_000)

      expect(fetchImpl).toHaveBeenCalledTimes(5)
      expect(onError).toHaveBeenCalledWith(expect.stringMatching(/token/i))
    } finally {
      vi.useRealTimers()
    }
  })
})
