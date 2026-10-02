/**
 * Natural-language rules (v53, dots "describe the action the rule covers,
 * then choose a behaviour"). The user writes "never touch my billing" or
 * "ask before you email anyone outside the company"; an economy model maps
 * it onto concrete standing rules (tool + effect + optional pattern) that the
 * user reviews and confirms one by one. The model only PROPOSES: nothing is
 * stored until the user accepts, matching stays deterministic, and every
 * proposal is validated against the real tool list here.
 */

import type { ToolDefinition, ToolRuleEffect, ToolRuleInput } from '@shared/types'
import { toolRuleSupportsPattern } from '@shared/tool-rules'
import { isOutwardTool } from '@shared/tool-classes'

const EFFECTS: readonly ToolRuleEffect[] = ['allow', 'allow_if_requested', 'require_approval', 'handoff', 'block']

export interface RuleDraft {
  rules: ToolRuleInput[]
  note: string
}

export function buildRuleDraftPrompt(request: string, tools: readonly ToolDefinition[]): string {
  const catalog = tools
    .filter((tool) => tool.enabled)
    .map((tool) => {
      const description = tool.description.replace(/\s+/g, ' ').slice(0, 140)
      const tags = [isOutwardTool(tool) ? 'outward' : '', tool.mutating ? 'changes things' : 'read-only']
        .filter(Boolean)
        .join(', ')
      const pattern = toolRuleSupportsPattern(tool.id) ? ' [pattern allowed]' : ''
      return `- ${tool.id} (${tags})${pattern}: ${description}`
    })
    .join('\n')
  return [
    "Turn the user's instruction into standing permission rules for their AI agent.",
    '',
    'Instruction (data):',
    '"""',
    request.slice(0, 2000),
    '"""',
    '',
    'Effects (choose per rule):',
    '- block: never run it',
    '- handoff: never run it; hand the step to the user to do themselves',
    '- require_approval: always ask the user first',
    '- allow_if_requested: run without asking only when the user asked in the conversation; ask otherwise',
    '- allow: run without asking',
    '',
    'A pattern narrows a rule (only for tools marked [pattern allowed]): a command prefix for shell',
    'tools, a host like "example.com" for web tools, a path prefix for file tools. Use null otherwise.',
    '',
    'Available tools:',
    catalog,
    '',
    'Pick only tools the instruction is really about; prefer the stricter effect when unsure.',
    'Reply with ONLY JSON: {"rules": [{"toolId": "...", "effect": "...", "pattern": null}], "note": "one sentence for the user"}',
  ].join('\n')
}

/** Parses + validates the model's answer against the real tool list. */
export function parseRuleDraft(text: string, tools: readonly ToolDefinition[]): RuleDraft {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return { rules: [], note: 'No rules could be derived from that — try naming the action more concretely.' }
  let parsed: { rules?: unknown; note?: unknown }
  try {
    parsed = JSON.parse(match[0]) as typeof parsed
  } catch {
    return { rules: [], note: 'The answer could not be read — try again.' }
  }
  const known = new Map(tools.map((tool) => [tool.id, tool]))
  const seen = new Set<string>()
  const rules: ToolRuleInput[] = []
  for (const raw of Array.isArray(parsed.rules) ? parsed.rules : []) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { toolId?: unknown; effect?: unknown; pattern?: unknown }
    const toolId = typeof entry.toolId === 'string' ? entry.toolId : ''
    const tool = known.get(toolId)
    const effect = EFFECTS.includes(entry.effect as ToolRuleEffect) ? (entry.effect as ToolRuleEffect) : null
    if (!tool || !effect) continue
    // A "go" rule can never cover a tool whose contract is approval per call.
    if ((effect === 'allow' || effect === 'allow_if_requested') && tool.noStandingApproval) continue
    const pattern =
      typeof entry.pattern === 'string' && entry.pattern.trim() && toolRuleSupportsPattern(toolId)
        ? entry.pattern.trim().slice(0, 500)
        : null
    const key = `${toolId}|${effect}|${pattern ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    rules.push({ toolId, effect, scope: 'global', pattern })
    if (rules.length >= 12) break
  }
  const note =
    typeof parsed.note === 'string' && parsed.note.trim()
      ? parsed.note.trim().slice(0, 300)
      : rules.length > 0
        ? 'Review these rules before saving them.'
        : 'No matching tools — the instruction may refer to something no tool does.'
  return { rules, note }
}
