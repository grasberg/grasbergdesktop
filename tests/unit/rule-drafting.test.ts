/** Natural-language rules (v53): prompt contents and strict validation of proposals. */

import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@shared/types'
import { buildRuleDraftPrompt, parseRuleDraft } from '../../src/main/services/rule-drafting'

const tool = (id: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  id,
  name: id,
  description: `${id} description`,
  parameters: {},
  risk: 'sensitive',
  builtin: true,
  enabled: true,
  ...extra,
})

const tools = [
  tool('email_send', { mutating: true }),
  tool('fetch_url'),
  tool('git_write', { mutating: true, noStandingApproval: true }),
  tool('disabled_tool', { enabled: false }),
]

describe('rule drafting', () => {
  it('lists only enabled tools with their class and pattern support', () => {
    const prompt = buildRuleDraftPrompt('never email strangers', tools)
    expect(prompt).toContain('- email_send (outward, changes things)')
    expect(prompt).toContain('- fetch_url (read-only) [pattern allowed]')
    expect(prompt).not.toContain('disabled_tool')
    expect(prompt).toContain('never email strangers')
  })

  it('keeps only valid, non-duplicate proposals and never a go-rule on a per-call tool', () => {
    const draft = parseRuleDraft(
      'Here: ' +
        JSON.stringify({
          rules: [
            { toolId: 'email_send', effect: 'require_approval', pattern: 'ignored' },
            { toolId: 'email_send', effect: 'require_approval', pattern: null },
            { toolId: 'fetch_url', effect: 'block', pattern: 'evil.example.com' },
            { toolId: 'git_write', effect: 'allow' },
            { toolId: 'git_write', effect: 'handoff' },
            { toolId: 'made_up', effect: 'block' },
            { toolId: 'fetch_url', effect: 'yolo' },
          ],
          note: 'Two rules.',
        }),
      tools
    )
    expect(draft.rules).toEqual([
      { toolId: 'email_send', effect: 'require_approval', scope: 'global', pattern: null },
      { toolId: 'fetch_url', effect: 'block', scope: 'global', pattern: 'evil.example.com' },
      { toolId: 'git_write', effect: 'handoff', scope: 'global', pattern: null },
    ])
    expect(draft.note).toBe('Two rules.')
    expect(parseRuleDraft('no json here', tools).rules).toEqual([])
  })
})
