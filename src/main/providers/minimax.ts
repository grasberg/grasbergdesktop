/**
 * MiniMax adapter. The API is OpenAI-compatible with one quirk: it can return
 * HTTP 200 whose body carries an error in `base_resp` ({ status_code != 0,
 * status_msg }). The base class calls checkBodyForProviderError on every
 * parsed body (non-streaming and each streamed chunk), so overriding that
 * hook is all that's needed.
 */

import { z } from 'zod'
import type { ProviderErrorCode } from '@shared/types'
import type { AdapterContext } from './adapter'
import { ProviderError } from './errors'
import { redactSecrets } from './redact'
import { OpenAICompatibleAdapter } from './openai-compatible'

const baseRespSchema = z
  .object({
    base_resp: z
      .object({
        status_code: z.number(),
        status_msg: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export function mapMiniMaxStatusCode(statusCode: number): ProviderErrorCode {
  switch (statusCode) {
    case 1004: // invalid api key
    case 2049: // invalid token
      return 'auth'
    case 1002: // rate limit
    case 1008: // insufficient balance (throttled until topped up)
      return 'rate_limit'
    case 1013: // invalid params
    case 2013: // invalid input format
      return 'invalid_request'
    default:
      return 'server'
  }
}

export class MiniMaxAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super({ type: 'minimax' })
  }

  protected override checkBodyForProviderError(json: unknown, ctx: AdapterContext): void {
    const parsed = baseRespSchema.safeParse(json)
    if (!parsed.success || !parsed.data.base_resp) return
    const { status_code: statusCode, status_msg: statusMsg } = parsed.data.base_resp
    if (statusCode === 0) return
    const code = mapMiniMaxStatusCode(statusCode)
    const detail = statusMsg
      ? redactSecrets(statusMsg, [ctx.apiKey])
      : `error code ${statusCode}`
    throw new ProviderError(code, `MiniMax reported an error: ${detail}`, {
      retryable: code === 'rate_limit' || code === 'server',
      providerType: 'minimax',
    })
  }
}
