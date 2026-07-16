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
 * - dangerous tools also ask; per-call explicit approval is the strictest
 *   default that still lets a tool work. Mutating tools (edit_file,
 *   write_file, run_shell_command, computer) are 'dangerous'.
 */
export const DEFAULT_PERMISSION_BY_RISK: Record<ToolRiskLevel, ToolPermissionDecision> = {
  safe: 'always_allow',
  sensitive: 'ask',
  dangerous: 'ask',
}

/** Result strings are capped at this length (with a truncation marker). */
export const TOOL_RESULT_MAX_CHARS = 8000

/** Caps a tool result at TOOL_RESULT_MAX_CHARS, appending a truncation marker. */
export function capToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…[truncated]`
}

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
    id: 'grep',
    name: 'grep',
    description:
      'Search file CONTENTS in the granted project folder with a JavaScript regular ' +
      'expression. Returns matching lines as "relPath:lineNo: line". Optionally filter ' +
      'which files are searched with a glob pattern (e.g. "src/**/*.ts"). Binary files, ' +
      'oversized files and dependency/build directories are skipped. Prefer this over ' +
      'file_search when you need a pattern rather than a plain substring.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'JavaScript regular expression to search for (without slashes).',
        },
        glob: {
          type: 'string',
          description: 'Optional glob filter on relative paths, e.g. "src/**/*.ts" or "*.md".',
        },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive matching (default false).' },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of matching lines to return (default 40, max 100).',
        },
      },
      required: ['pattern'],
    },
    risk: 'sensitive',
    builtin: true,
    enabled: true,
  },
  {
    id: 'glob',
    name: 'glob',
    description:
      'Find files in the granted project folder whose relative path matches a glob pattern ' +
      '(e.g. "src/**/*.test.ts", "**/*.css"). Returns matching relative paths, most recently ' +
      'modified first. Dependency/build directories are skipped.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts".' },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum number of paths to return (default 50, max 200).',
        },
      },
      required: ['pattern'],
    },
    risk: 'sensitive',
    builtin: true,
    enabled: true,
  },
  {
    id: 'git',
    name: 'git',
    description:
      'Run a READ-ONLY git query in the granted project folder. Actions: "status" (branch + ' +
      'porcelain status), "diff" (working tree; set staged=true for the index; optionally limit ' +
      'to one file with path), "log" (recent commits, one line each). This tool can never ' +
      'modify the repository - commits, checkouts, pushes and any other mutations are not ' +
      'possible with it. Fails cleanly when the folder is not a git repository.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'diff', 'log'] },
        path: {
          type: 'string',
          description: 'Optional file path (relative to the project root) to limit diff/log to.',
        },
        staged: { type: 'boolean', description: 'For "diff": show staged changes instead.' },
        maxCount: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'For "log": number of commits to show (default 20).',
        },
      },
      required: ['action'],
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
    id: 'web_search',
    name: 'web_search',
    description:
      'Search the web (DuckDuckGo) and return the top results as "title - url" plus a snippet ' +
      'for each. Use it to find current information or pages to read with fetch_url. No API ' +
      'key, no credentials; the query is sent to the search engine.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'Maximum results to return (default 5, max 10).',
        },
      },
      required: ['query'],
    },
    risk: 'sensitive',
    builtin: true,
    enabled: true,
  },
  {
    id: 'generate_image',
    name: 'generate_image',
    description:
      'Generate an image from a text prompt with the image model the user configured ' +
      '(Settings → Defaults → Image generation). The image is saved locally and shown to ' +
      'the user inside your reply — never describe it as a link or fabricate a URL. It ' +
      'costs API credits and each call needs approval, so call it only when the user asks ' +
      'for an image. Write the prompt as a complete visual description (subject, style, ' +
      'composition, lighting).',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Complete visual description of the image to generate.',
        },
        size: {
          type: 'string',
          enum: ['auto', 'square', 'landscape', 'portrait'],
          description: 'Aspect ratio (default auto = provider default).',
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          description: 'Number of images (default 1; some providers cap at 1).',
        },
      },
      required: ['prompt'],
    },
    // 'sensitive' => per-call approval by default, which doubles as the
    // cost-consent gate. Not 'mutating': plan mode may still illustrate.
    risk: 'sensitive',
    builtin: true,
    enabled: true,
  },
  {
    id: 'git_write',
    name: 'git_write',
    description:
      'Perform ONE git operation in the granted project: "stage" (git add the ' +
      'given relative paths), "commit" (commit what is staged with the given message), or ' +
      '"create_branch" (create and switch to a new branch), "set_origin" (connect an HTTPS/SSH remote), ' +
      'plus remote "fetch", fast-forward-only ' +
      '"pull", non-force "push", "create_pull_request" through GitHub CLI, and "pr_review" ' +
      '(post a comment/approve/request_changes review on a pull request via review_event + ' +
      "body). EVERY call requires the user's " +
      'explicit approval — there are no standing grants. Committing on the repository\'s ' +
      'default branch and pushing it additionally require confirm_default_branch: true. Pull ' +
      'requires a clean worktree and can never create a merge commit. Push can never force. ' +
      'Merge, rebase and switching to an existing branch remain unavailable.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'stage',
            'commit',
            'create_branch',
            'set_origin',
            'fetch',
            'pull',
            'push',
            'create_pull_request',
            'pr_review',
          ],
          description: 'The single git operation to perform.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'For "stage": file paths relative to the project root.',
        },
        message: { type: 'string', description: 'For "commit": the commit message.' },
        branch: { type: 'string', description: 'For "create_branch": the new branch name.' },
        url: { type: 'string', description: 'For "set_origin": HTTPS or SSH repository URL.' },
        title: { type: 'string', description: 'For "create_pull_request": PR title.' },
        body: { type: 'string', description: 'For "create_pull_request": optional PR body.' },
        base: { type: 'string', description: 'For "create_pull_request": optional base branch.' },
        draft: { type: 'boolean', description: 'For "create_pull_request": create as draft.' },
        review_event: {
          type: 'string',
          enum: ['comment', 'approve', 'request_changes'],
          description: 'For "pr_review": the kind of review to post.',
        },
        number: {
          type: 'integer',
          minimum: 1,
          description: 'For "pr_review": PR number (omit for the current branch pull request).',
        },
        confirm_default_branch: {
          type: 'boolean',
          description:
            'Set true ONLY when the user explicitly asked to commit on or push the default branch.',
        },
      },
      required: ['action'],
    },
    risk: 'dangerous',
    builtin: true,
    enabled: true,
    mutating: true,
    noStandingApproval: true,
  },
  {
    id: 'github',
    name: 'github',
    description:
      'Read-only GitHub queries for the granted project via the GitHub CLI (gh must be ' +
      'installed and authenticated): "list_issues" (optionally state "closed"/"all"), ' +
      '"view_issue" (number — title, body, comments), "view_pr" (a pull request incl. its CI ' +
      'status rollup; number optional = the current branch PR), "pr_diff" (the PR diff), ' +
      '"ci_runs" (recent workflow runs), "ci_failed_logs" (the failing steps of a run; run_id ' +
      'optional = latest failed run). Typical flows: fix an issue (view_issue, create a ' +
      'branch, edit, commit, push, create_pull_request), review a PR (view_pr + pr_diff, then ' +
      'git_write pr_review), fix CI (ci_failed_logs, edit, commit, push).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_issues', 'view_issue', 'view_pr', 'pr_diff', 'ci_runs', 'ci_failed_logs'],
          description: 'The single GitHub query to run.',
        },
        number: {
          type: 'integer',
          minimum: 1,
          description:
            'Issue/PR number for "view_issue" (required) and "view_pr"/"pr_diff" (optional).',
        },
        run_id: {
          type: 'integer',
          minimum: 1,
          description: 'For "ci_failed_logs": the workflow run id (omit = latest failed run).',
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'For "list_issues": which issues to list (default open).',
        },
      },
      required: ['action'],
    },
    // Read-only, but it talks to the network about the user's repository:
    // per-call approval by default, relaxable in Settings like any tool.
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
  {
    id: 'edit_file',
    name: 'edit_file',
    description:
      'Propose an exact string replacement in a project file and, after the user approves ' +
      'this call, apply it to disk. Read the file first - old_string must match the current ' +
      'content exactly and must be unique in the file (or set replace_all). The change is ' +
      'recorded in the Changes list with a diff. Rejected approval means nothing is written.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        old_string: { type: 'string', description: 'Exact existing text to replace.' },
        new_string: { type: 'string', description: 'Replacement text (must differ).' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring a unique match.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    // Writes into the user's project (via the audited change pipeline) - the
    // strictest default: per-call approval.
    risk: 'dangerous',
    builtin: true,
    enabled: true,
    mutating: true,
  },
  {
    id: 'write_file',
    name: 'write_file',
    description:
      'Create a new project file, or fully replace an existing one you have already read, ' +
      'after the user approves this call. The change is recorded in the Changes list with a ' +
      'diff. For partial changes to existing files prefer edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        content: { type: 'string', description: 'The complete new file content.' },
      },
      required: ['path', 'content'],
    },
    risk: 'dangerous',
    builtin: true,
    enabled: true,
    mutating: true,
  },
  {
    id: 'browser',
    name: 'browser',
    description:
      'Drive an embedded, sandboxed web browser (isolated from your machine; http/https only, ' +
      'downloads blocked). Use it to look things up and interact with web pages. Actions: ' +
      '"navigate" (url), "read" (return the current page text + interactive elements with their ' +
      '[x,y] centers), "click" (a CSS "selector" or visible "text"), "type" (into a "selector" ' +
      'with "text"), "back". Requires the user to have enabled browser tools.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['navigate', 'read', 'click', 'type', 'back'] },
        url: { type: 'string', description: 'For "navigate": an absolute http(s) URL.' },
        selector: { type: 'string', description: 'For "click"/"type": a CSS selector.' },
        text: {
          type: 'string',
          description: 'For "type": the text to enter. For "click": visible text to match (instead of a selector).',
        },
      },
      required: ['action'],
    },
    risk: 'sensitive',
    builtin: true,
    enabled: true,
    // Acts on live pages (click/type/keypress) - not read-only investigation.
    mutating: true,
  },
  {
    id: 'computer',
    name: 'computer',
    description:
      'Control the embedded browser viewport (1280x800) by coordinate, like a computer-use agent. ' +
      'Each action returns the page state and, for vision-capable models, a screenshot of the ' +
      'result. Actions: "screenshot", "left_click", "right_click", "middle_click", "double_click", ' +
      '"mouse_move", "left_click_drag", "scroll", "type", "key", "wait". Provide "coordinate" as ' +
      '[x, y] for pointer actions, "text" for type/key (e.g. "Return", "ctrl+a") and scroll ' +
      'direction ("up"/"down"). Navigate first with the browser tool. Requires browser tools enabled.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'screenshot',
            'cursor_position',
            'mouse_move',
            'left_click',
            'right_click',
            'middle_click',
            'double_click',
            'left_click_drag',
            'scroll',
            'type',
            'key',
            'wait',
          ],
        },
        coordinate: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Pixel [x, y] in the 1280x800 viewport, for pointer actions.',
        },
        text: { type: 'string', description: 'Text for type/key, or scroll direction.' },
      },
      required: ['action'],
    },
    // Acts on live web pages; always asks for approval and is hidden unless the
    // user opted into browser tools.
    risk: 'dangerous',
    builtin: true,
    enabled: true,
    mutating: true,
  },
  {
    id: 'use_skill',
    name: 'use_skill',
    description:
      'Load the full instructions of an installed skill by name. The available skills ' +
      '(name + description) are listed in the system prompt. Call this BEFORE performing ' +
      'a task that a skill covers, then follow the returned instructions — do not guess ' +
      'at what a skill contains. Read-only: it only returns stored instruction text.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name of the skill to load, exactly as listed.',
        },
      },
      required: ['name'],
    },
    risk: 'safe',
    builtin: true,
    enabled: true,
  },
  {
    id: 'knowledge_search',
    name: 'knowledge_search',
    description:
      "Search the conversation's attached knowledge base (the user's own documents, embedded " +
      'for semantic retrieval) and return the most relevant passages. Use it BEFORE answering ' +
      'questions the attached documents may cover, and ground your answer in the passages. ' +
      'Errors if no knowledge base is attached.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to look for — a question or key phrases.',
        },
      },
      required: ['query'],
    },
    risk: 'safe',
    builtin: true,
    enabled: true,
  },
  {
    id: 'delegate',
    name: 'delegate',
    description:
      'Delegate a focused sub-task to a fresh sub-agent and get back its result. The sub-agent ' +
      'runs its own bounded reasoning loop with project tools (search, repo map, read/list, grep, ' +
      'glob, git queries, fetch URL, and approval-gated file edits) and returns a concise answer. ' +
      'Use it to decompose work, investigate a specific question, or carry out a well-scoped ' +
      'change independently. Give it a self-contained task and any context it needs — it does ' +
      'not see this conversation.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'A self-contained task or question for the sub-agent to work on.',
        },
        context: {
          type: 'string',
          description: 'Optional background the sub-agent needs (it has no other context).',
        },
        agent: {
          type: 'string',
          description:
            'Optional named agent profile to run as (the user defines these in Settings → ' +
            'Agents, each with its own persona, model and toolset). Omit for the general sub-agent.',
        },
        background: {
          type: 'boolean',
          description:
            'Run in the background: returns a task id immediately instead of the result. ' +
            'Start several background tasks to work in parallel, then poll with task_output.',
        },
      },
      required: ['task'],
    },
    risk: 'safe',
    builtin: true,
    enabled: true,
  },
  {
    id: 'task_output',
    name: 'task_output',
    description:
      'Get the status and result of a background task (a delegate background=true sub-agent or ' +
      'a run_shell_command background=true job). While a shell job is running this returns its ' +
      'output so far.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task id returned by delegate.' },
      },
      required: ['taskId'],
    },
    risk: 'safe',
    builtin: true,
    enabled: true,
  },
  {
    id: 'task_stop',
    name: 'task_stop',
    description:
      'Stop a running background task (sub-agent or shell job). A stopped sub-agent discards ' +
      'its partial result; a stopped shell job reports the output captured so far.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task id returned by delegate.' },
      },
      required: ['taskId'],
    },
    risk: 'safe',
    builtin: true,
    enabled: true,
  },
  {
    id: 'update_task_list',
    name: 'update_task_list',
    description:
      'Replace your working task list for this conversation (shown to the user as a ' +
      'checklist). Send the FULL list on every call. Use it for multi-step work: add the ' +
      'steps up front, keep at most one item in_progress, and mark items completed as you ' +
      'finish them. Writes only to the app database, never to project files.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
          description: 'The complete, ordered task list.',
        },
      },
      required: ['tasks'],
    },
    risk: 'safe',
    builtin: true,
    enabled: true,
  },
  {
    id: 'ask_user_question',
    name: 'ask_user_question',
    description:
      'Ask the user ONE clarifying question with a short list of suggested answers, shown as ' +
      'a dialog they can click (they may also type a custom answer or dismiss). Use it only ' +
      'when you are genuinely blocked on a decision the user must make - not for questions ' +
      'you can answer yourself from the code or the conversation.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The complete question to ask.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '2-4 short suggested answers.',
        },
      },
      required: ['question'],
    },
    risk: 'safe',
    builtin: true,
    enabled: true,
  },
  {
    id: 'schedule_task',
    name: 'schedule_task',
    description:
      'Create, list or cancel scheduled tasks: saved prompts this app runs automatically at a ' +
      'chosen local time, once or repeating hourly/daily/weekly (while the app is running). ' +
      'The saved prompt runs headlessly in a FRESH context with tools enabled — it does not ' +
      'see this conversation, so write it self-contained. Results land in the Scheduled tasks ' +
      'panel, not in this chat. For "create": give title, prompt, recurrence, and when — ' +
      'either time ("HH:MM", 24-hour local; a passed time rolls to the next occurrence), ' +
      'optionally with date ("YYYY-MM-DD"), or in_minutes from now. "Every hour" needs no ' +
      'time at all. In headless runs approval-gated tools are normally auto-declined; list ' +
      'the tool ids the prompt needs in "tools" to pre-approve them for this task (the ' +
      "user's approval of THIS call is that consent — the approval dialog names them). The " +
      "task inherits this conversation's working folder for file/shell tools. Use \"list\" " +
      'to see existing tasks with their ids, "cancel" with an id to remove one. Each call ' +
      "needs the user's approval.",
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'cancel'],
          description: 'The operation to perform.',
        },
        title: {
          type: 'string',
          description: 'For "create": a short task name shown to the user (max 120 chars).',
        },
        prompt: {
          type: 'string',
          description:
            'For "create": the complete, self-contained instruction to run on schedule ' +
            '(the runner has no access to this conversation).',
        },
        recurrence: {
          type: 'string',
          enum: ['once', 'hourly', 'daily', 'weekly'],
          description: 'For "create": how often the task runs.',
        },
        time: {
          type: 'string',
          description:
            'For "create": wall-clock run time "HH:MM" (24-hour, the user\'s local time). ' +
            'Without a date this means the next occurrence of that time.',
        },
        date: {
          type: 'string',
          description:
            'For "create": first-run calendar date "YYYY-MM-DD" (local), combined with time.',
        },
        in_minutes: {
          type: 'integer',
          minimum: 1,
          description: 'For "create": run this many minutes from now (instead of time/date).',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For "create": tool ids to pre-approve for this task\'s headless runs, e.g. ' +
            '["run_shell_command", "write_file"]. Omit for prompts that only need ' +
            'always-allowed tools. Tools requiring a fresh approval per call (git_write) ' +
            'cannot be pre-approved.',
        },
        id: {
          type: 'string',
          description: 'For "cancel": the task id (from "list" or a create result).',
        },
      },
      required: ['action'],
    },
    // Creates standing autonomous runs => per-call approval is the consent
    // gate, so no standing grant may ever cover it. Not 'mutating': it writes
    // app state, never project files.
    risk: 'sensitive',
    builtin: true,
    enabled: true,
    noStandingApproval: true,
  },
  {
    id: 'run_shell_command',
    name: 'run_shell_command',
    description:
      'Execute a shell command in the project folder the user granted for this conversation and ' +
      'return its exit code, stdout and stderr. This ACTUALLY RUNS the command, so it requires the ' +
      'user to have enabled shell execution AND to approve each call. Commands run with a timeout ' +
      '(default 60s, raisable via timeoutSeconds up to 600) and capped output. Set background=true ' +
      'for long-running processes (dev servers, watchers): it returns a task id immediately — poll ' +
      'output with task_output and stop it with task_stop. Prefer propose_shell_command when you ' +
      'only need to suggest a command for the user to run themselves. Only works when a project ' +
      'folder is granted.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The exact command to run, e.g. "npm test".',
        },
        explanation: {
          type: 'string',
          description: 'One or two sentences explaining what the command does and why.',
        },
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: 600,
          description: 'Timeout for a foreground run (default 60, max 600).',
        },
        background: {
          type: 'boolean',
          description:
            'Run as a detached background job; returns a task id for task_output/task_stop.',
        },
        cwd: {
          type: 'string',
          description:
            'Optional working directory: a path relative to the project folder, or an absolute ' +
            "path when the conversation's sandbox level is 'full' (otherwise refused).",
        },
      },
      required: ['command'],
    },
    // Highest-risk builtin: it can mutate the project and the system. Always
    // asks for approval, and is filtered out entirely unless the user opted in.
    risk: 'dangerous',
    builtin: true,
    enabled: true,
    mutating: true,
  },
]
