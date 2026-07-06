/**
 * Prefix allowlist for run_shell_command: commands matching a user-configured
 * prefix skip the per-call approval dialog (shell execution itself must still
 * be enabled, and 'deny' on the tool still wins).
 *
 * Matching is deliberately conservative:
 * - the command must equal the prefix, or continue it at a word boundary
 *   ("npm test" matches "npm test -- --watch", NOT "npm tests");
 * - commands with shell chaining/substitution characters (;, &&, |, `, $( …)
 *   NEVER match — "git status; rm -rf ~" must not ride in on "git status".
 */

/** Shell metacharacters that can smuggle a second command past the prefix. */
const CHAINING_CHARS = /[;&|`$<>\n\r]/

/** Collapses runs of whitespace so spacing differences don't defeat matching. */
function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

/**
 * True when `command` is covered by one of the allowlisted prefixes and
 * contains no chaining metacharacters.
 */
export function commandMatchesAllowlist(command: string, allowlist: readonly string[]): boolean {
  // Check the RAW command: normalize() collapses newlines into spaces, which
  // would hide a '\n'-smuggled second command from this test.
  if (CHAINING_CHARS.test(command)) return false
  const cmd = normalize(command)
  if (cmd.length === 0) return false
  for (const entry of allowlist) {
    const prefix = normalize(entry)
    if (prefix.length === 0) continue
    if (cmd === prefix) return true
    if (cmd.startsWith(prefix) && cmd[prefix.length] === ' ') return true
  }
  return false
}
