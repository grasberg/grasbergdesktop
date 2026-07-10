/**
 * Zhipu (GLM) adapter. The chat endpoint is OpenAI-compatible and error
 * bodies are OpenAI-ish, so the base class covers everything. Zhipu has no
 * /models endpoint: supportsModelListing=false in the catalog makes the base
 * fall back to known models and test connectivity with a minimal chat call.
 *
 * Image generation (CogView) shares the /images/generations path but takes a
 * pruned body: one image per call, its own size strings, no response_format
 * (results always come back as a URL — the base downloads it).
 */

import type { AdapterImageRequest } from './adapter'
import { OpenAICompatibleAdapter } from './openai-compatible'

/** CogView size strings per abstract size ('auto' stays off the wire). */
export function mapCogViewSize(size: AdapterImageRequest['size']): string | undefined {
  if (!size || size === 'auto') return undefined
  return size === 'square' ? '1024x1024' : size === 'landscape' ? '1344x768' : '768x1344'
}

export class ZhipuAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super({ type: 'zhipu' })
  }

  protected override buildImageBody(req: AdapterImageRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { model: req.modelId, prompt: req.prompt }
    const size = mapCogViewSize(req.size)
    if (size) body.size = size
    return body
  }
}
