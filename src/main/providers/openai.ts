/**
 * OpenAI adapter (API-key auth). OpenAI's /v1/chat/completions and /v1/models
 * are the canonical OpenAI-compatible endpoints, so the base class covers the
 * wire format; we only opt into the streamed usage chunk it supports.
 *
 * The separate "Sign in with ChatGPT" (OAuth) path does NOT use this adapter —
 * ChatGPT subscription tokens only work against the ChatGPT backend, which
 * speaks the Responses API; see openai-codex.ts.
 */

import { OpenAICompatibleAdapter } from './openai-compatible'

export class OpenAIAdapter extends OpenAICompatibleAdapter {
  protected override sendStreamOptions = true

  constructor() {
    super({ type: 'openai' })
  }
}
