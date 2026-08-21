/**
 * Which tools a standing approval rule can NARROW, and what its pattern is
 * compared against. Shared because both sides need the same answer: main
 * matches calls against it (tools/tool-rules.ts) and the renderer uses it to
 * decide whether to offer a pattern field at all, and what to call it.
 *
 * A tool absent from this map has no subject — a pattern cannot narrow it. The
 * matcher resolves that fail-safe: such a pattern makes a stop rule match the
 * whole tool and an allow rule match nothing.
 */

export type ToolRuleSubjectKind = 'command' | 'url' | 'path'

export interface ToolRuleSubject {
  kind: ToolRuleSubjectKind
  /** Argument name the subject is read from. */
  arg: string
}

export const TOOL_RULE_SUBJECTS: Readonly<Record<string, ToolRuleSubject>> = {
  run_shell_command: { kind: 'command', arg: 'command' },
  propose_shell_command: { kind: 'command', arg: 'command' },
  fetch_url: { kind: 'url', arg: 'url' },
  browser: { kind: 'url', arg: 'url' },
  read_file: { kind: 'path', arg: 'path' },
  edit_file: { kind: 'path', arg: 'path' },
  write_file: { kind: 'path', arg: 'path' },
}

/** Whether a rule for this tool may carry a narrowing pattern. */
export function toolRuleSupportsPattern(toolId: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_RULE_SUBJECTS, toolId)
}

/** Placeholder/hint describing what a pattern means for this tool. */
export function toolRulePatternHint(toolId: string): string | null {
  const subject = TOOL_RULE_SUBJECTS[toolId]
  if (!subject) return null
  if (subject.kind === 'command') return 'Command prefix, e.g. npm test'
  if (subject.kind === 'url') return 'Host, e.g. docs.example.com'
  return 'Path prefix in the project, e.g. src/generated'
}
