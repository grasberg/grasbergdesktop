/**
 * Zhipu (GLM) adapter. The chat endpoint is OpenAI-compatible and error
 * bodies are OpenAI-ish, so the base class covers everything. Zhipu has no
 * /models endpoint: supportsModelListing=false in the catalog makes the base
 * fall back to known models and test connectivity with a minimal chat call.
 */

import { OpenAICompatibleAdapter } from './openai-compatible'

export class ZhipuAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super({ type: 'zhipu' })
  }
}
