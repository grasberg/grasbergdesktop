/**
 * Z.ai GLM Coding Plan adapter. The Coding Plan exposes an OpenAI-compatible
 * endpoint (https://api.z.ai/api/coding/paas/v4) authenticated with the
 * subscription's API key, so the base class handles everything. Model listing
 * is treated as unavailable: the coding endpoint's /models path is unreliable
 * across tools, so we fall back to the catalog and probe with a chat call.
 */

import { OpenAICompatibleAdapter } from './openai-compatible'

export class ZaiCodingAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super({ type: 'zai-coding' })
  }
}
