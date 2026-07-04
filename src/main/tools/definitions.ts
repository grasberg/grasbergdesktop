/**
 * Built-in tool definitions (MCP-style local tools).
 *
 * These are the ToolDefinitions the model sees. Descriptions must stay honest:
 * they describe exactly what the executor does, including what it will NOT do.
 *
 * SAFETY INVARIANT: 'propose_shell_command' NEVER executes anything. It has no
 * execution path — its result is a note that the command was shown to the user
 * as a suggestion. That is why it is risk 'safe'.
 */

import type { ToolDefinition, ToolPermissionDecision, ToolRiskLevel } from '@shared/types'

/**
 * Default permission decision per risk level, used when the user has not set
 * an explicit permission for a tool:
 * - safe tools run without asking (they cannot touch files, network or shell),
 * - sensitive tools ask for approval on every call,
 * - dangerous tools also ask (nothing built-in is 'dangerous'; a per-call
 *   explicit approval is the strictest default that still lets the tool work).
 */
export const DEFAULT_PERMISSION_BY_RISK: Record<ToolRiskLevel, ToolPermissionDecision> = {
  safe: 'always_allow',
  sensitive: 'ask',
  dangerous: 'ask',
}

/** Result strings are capped at this length (with a truncation marker). */
export const TOOL_RESULT_MAX_CHARS = 8000

/**
 * Built-in tools shipped with the app. `enabled: true` is the default; the
 * registry overlays the user's per-tool enabled flags from the database.
 * For builtins, `id` doubles as the function name the model calls.
 */
export const BUILTIN_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    id: 'file_search',
    name: 'file_search',
    description:
      'Search the files of the project folder the user granted for this conversation. ' +
      'Matches a case-insensitive substring against relative file paths and against the ' +
      'content of text files (files larger than 256 KB and binary files are skipped). ' +
      'Returns matching lines as "relPath:lineNo: line" (or just "relPath" for path-only ' +
      'matches). Only works when the conversation has a granted project folder; it can ' +
      'never see files outside that folder.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring to search for in file paths and contents.',
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum number of result lines to return (default 20, max 50).',
        },
      },
      required: ['query'],
    },
    risk: 'sensitive',
    builtin: true,
    enabled: true,
  },
  {
    id: 'repo_map',
    name: 'repo_map',
    description:
      'Build a ranked map of the project folder the user granted for this conversation and ' +
      'return the files most relevant to a natural-language query, each with its top-level ' +
      'symbols (functions, classes, exports). Ranking uses in-app BM25 over file paths and ' +
      'extracted symbol/import names — it is a best-effort locator, not a compiler. Use it to ' +
      'find where to look before reading files. Only works when the conversation has a granted ' +
      'project folder; it can never see files outside it.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What you are looking for, e.g. "where API keys are encrypted".',
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: 'Maximum number of files to return (default 12, max 30).',
        },
      },
      required: ['query'],
    },
    risk: 'sensitive',
    builtin: true,
    enabled: true,
  },
  {
    id: 'read_file',
    name: 'read_file',
    description:
      'Read a text file from the project folder the user granted for this conversation. ' +
      'The path must be relative to the project root; paths outside the project are ' +
      'rejected. Large files are truncated. Only works when the conversation has a ' +
      'granted project folder.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the project root, e.g. "src/index.ts".',
        },
      },
      required: ['path'],
    },
    risk: 'sensitive',
    builtin: true,
    enabled: true,
  },
  {
    id: 'list_directory',
    name: 'list_directory',
    description:
      'List the immediate children (files and subdirectories) of a directory inside the ' +
      'project folder the user granted for this conversation. Directories are suffixed ' +
      'with "/". Paths outside the project are rejected. Only works when the ' +
      'conversation has a granted project folder.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory path relative to the project root. Omit or use "." for the root.',
        },
      },
      required: [],
    },
    risk: 'sensitive',
    builtin: true,
    enabled: true,
  },
  {
    id: 'fetch_url',
    name: 'fetch_url',
    description:
      'Fetch a public https:// URL with a GET request and return the HTTP status plus the ' +
      'response body text (up to 512 KB). Only https URLs are allowed; only textual ' +
      'responses (text/*, JSON, XML) are returned. No credentials or cookies are ever ' +
      'sent. Times out after 15 seconds.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute https:// URL to fetch.',
        },
      },
      required: ['url'],
    },
    risk: 'sensitive',
    builtin: true,
    enabled: true,
  },
  {
    id: 'propose_shell_command',
    name: 'propose_shell_command',
    description:
      'Suggest a shell/terminal command for the user to review and run themselves. ' +
      'IMPORTANT: this application NEVER executes shell commands — the command is only ' +
      'displayed to the user as a suggestion, and the tool result simply confirms that ' +
      'the suggestion was shown. Use it whenever a terminal step would help the user.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The exact command to suggest, e.g. "npm install".',
        },
        explanation: {
          type: 'string',
          description: 'One or two sentences explaining what the command does and why.',
        },
      },
      required: ['command'],
    },
    risk: 'safe',
    builtin: true,
    enabled: true,
  },
]

/** Convenience id set for "is this one of ours?" checks. */
export const BUILTIN_TOOL_IDS: ReadonlySet<string> = new Set(
  BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id)
)
