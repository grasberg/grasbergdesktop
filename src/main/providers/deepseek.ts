/**
 * DeepSeek adapter. Fully OpenAI-compatible: reasoning_content (deepseek-
 * reasoner) and error normalization are handled by the base class. DeepSeek
 * supports stream_options, so we opt in to the final usage chunk.
 */

import { OpenAICompatibleAdapter } from './openai-compatible'

export class DeepSeekAdapter extends OpenAICompatibleAdapter {
  protected override sendStreamOptions = true

  constructor() {
    super({ type: 'deepseek' })
  }
}
