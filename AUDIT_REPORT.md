# Grasberg codebase audit — verified findings


17 subsystem/lens reviewers -> 88 raw -> 79 deduped -> **75 confirmed** (each survived 2 independent adversarial verifiers). Verification gates (typecheck, 594 tests, build, smoke) all pass.


## HIGH severity


### `src/main/db/driver.ts:61` — transaction() cannot nest, and a real caller nests it: deleting the default provider always fails

*bug*


driver.transaction() unconditionally execs BEGIN, and node-sqlite3-wasm throws 'cannot start a transaction within a transaction' on a nested BEGIN (verified empirically against the bundled wasm build). A real nesting exists today: the providersDelete IPC handler (src/main/ipc/register.ts:547) wraps its work in db.driver.transaction() and, when the provider being deleted is the current default, calls db.settings.update() inside it — and settings.update() opens its own driver.transaction() (src/main/db/repositories/settings.ts:45). Concrete failure: user sets provider X as the default provider, then deletes provider X -> inner BEGIN throws -> outer transaction rolls back -> the IPC call returns an error and the provider can never be deleted while it is the default. Any future repo method that uses a transaction (knowledge.replaceSourceChunks is the other one) called from a composed transaction hits the same wall.


**Fix:** Make transaction() nesting-safe. node-sqlite3-wasm exposes db.inTransaction, so the minimal fix is: if (db.inTransaction) return fn() (join the ambient transaction; the outermost owner commits/rolls back). A fuller fix uses SAVEPOINT/RELEASE/ROLLBACK TO for inner levels. Either way, add a unit test that nests settings.update inside driver.transaction.


### `src/main/db/database.ts:111` — Restart after a failed noTransaction migration overwrites the good pre-migration snapshot with the broken DB

*bug*


The snapshot name is derived from the from-version (`${filePath}.pre-v${current}.bak`). If a noTransaction rebuild crashes or throws mid-way, recordVersion never runs, so on the next launch `current` is unchanged and needsSnapshot is true again — and the code first rmSync's the existing snapshot (the good pre-migration copy taken on the first attempt) and re-runs VACUUM INTO on the now half-rebuilt database. The re-run of the migration then fails ('table conversations_new already exists', reproduced against the wasm build), so the app cannot boot and the user's only recovery copy has been replaced by a snapshot of the broken state. No power loss is required: any SQL error partway through a noTransaction migration triggers this deterministically on the second launch. This defeats the exact scenario the snapshot exists for.


**Fix:** Never overwrite an existing snapshot for the same from-version — it is by construction at least as trustworthy as the current file: `if (!existsSync(snapshotPath)) driver.exec('VACUUM INTO ...')`. (Optionally also attempt automatic restore from the .bak when a re-run fails.)


### `src/main/db/database.ts:125` — noTransaction rebuild migrations are needlessly non-atomic; a crash mid-rebuild permanently bricks the database

*bug*


The noTransaction branch execs each statement bare, so migrations v8/v11/v13/v25 have a window (between CREATE TABLE ..._new and the final RENAME) where a crash, power loss, or an unexpected SQL error leaves the schema half-built with nothing to roll back. Reproduced: killing after DROP TABLE conversations leaves no conversations table; re-running the migration on next boot fails with 'table conversations_new already exists', so openDatabase throws forever and the app never starts (recovery requires manually restoring the .bak — which finding 2 destroys). This is avoidable: PRAGMA foreign_keys is only a no-op INSIDE a transaction, so SQLite's documented 12-step rebuild procedure is exactly PRAGMA foreign_keys=OFF; BEGIN; <rebuild>; COMMIT; PRAGMA foreign_keys=ON. Only the two PRAGMA toggles must be outside the transaction; the entire rebuild plus the schema_version write can be atomic.


**Fix:** In the noTransaction branch, exec the leading/trailing PRAGMA statements bare but wrap everything between them plus recordVersion() in driver.transaction() (e.g. treat first/last statements as pre/post, or add explicit BEGIN/COMMIT markers to the migration arrays). A crash then rolls the whole rebuild back and the migration re-runs cleanly, making the VACUUM snapshot a belt-and-braces measure instead of the only recovery path.


### `src/main/services/chat-service.ts:622` — editAndRerun leaves stale compaction summary after deleteAfterSeq, making the edited message and all subsequent turns invisible to the model

*bug*


editAndRerun allows editing ANY user message and then calls messages.deleteAfterSeq(conversation.id, target.seq), but never clamps/clears conversations.summary_through_seq. In a long compacted conversation (e.g. summary_through_seq = 40), editing a user message at seq 20 truncates seqs 21+, yet buildHistory (line 1166: `if (message.seq <= throughSeq) continue`) still skips every message with seq <= 40. Because messages.nextSeq is MAX(seq)+1, all post-edit turns get seqs 21, 22, ... — all <= 40 — so the provider receives ONLY the stale summary (which describes the just-deleted messages) with no user turn at all: the edited content never reaches the model, and every subsequent send in that conversation is silently dropped from the wire history until seq climbs past 40. The renderer meanwhile shows the full transcript, so the model's replies appear to ignore everything the user says.


**Fix:** In editAndRerun, after deleteAfterSeq, reset the summary when it extends past the truncation point: if ((conversation.summaryThroughSeq ?? 0) >= target.seq) { this.db.conversations.setSummary(conversation.id, '', 0); conversation.summaryText = null; conversation.summaryThroughSeq = null } (or add a clearSummary method to ConversationsRepository). Compaction will rebuild the summary on the next long generation.


### `src/main/scheduled-tasks/scheduler.ts:59` — Scheduled task can execute twice when another due task's run outlasts the 30 s tick

*bug*


tick() iterates a snapshot of listDue() and guards only with the in-memory `running` Set, but markRunning never advances next_run_at (only finish() does), and setInterval fires overlapping ticks. Scenario: T1 and T2 are both due at 09:00. Tick A gets due=[T1,T2] and awaits run(T1), a 2-minute generation. Tick B at 09:00:30 gets due=[T1,T2] again, skips T1 (in `running`), runs T2 to completion and removes it from `running`. When tick A finally reaches T2 in its stale list, `running.has(T2)` is false and T2's stale snapshot still looks due, so tick A runs T2 a second time — with tools enabled and pre-approved (e.g. a 'send this email once at 09:00' task fires twice). 'once' semantics are broken because the stale loop never re-reads enabled/nextRunAt (getById after the run only checks existence).


**Fix:** After acquiring the `running` guard, re-fetch the row and re-verify it is still due before executing: `const fresh = this.deps.db.scheduledTasks.getById(task.id); if (!fresh || !fresh.enabled || fresh.nextRunAt === null || fresh.nextRunAt > Date.now()) { this.running.delete(task.id); continue }` (and use `fresh` for nextOccurrence). Alternatively add a re-entrancy flag so ticks never overlap.


### `src/main/workflows/scheduler.ts:49` — Scheduled workflow can run twice when another due workflow's run outlasts the 60 s tick

*bug*


Same stale-snapshot race as the task scheduler: tick A computes due=[A,B] and awaits runById(A) (runs can last up to WORKFLOW_RUN_TIMEOUT_MS = 10 min). Tick B at +60 s sees B still due (its lastRunAt is only stamped when runById(B) starts), runs B to completion, and the runner's `running` map entry for B is deleted. Tick A then unconditionally calls runById(B, 'schedule') from its stale list — runById never re-checks isDue, only per-workflow concurrency — so B executes a full second time immediately after finishing (notify nodes send duplicate Telegram/webhook messages, http_request nodes fire twice). The runner comment 'stamped up front so the due check can't double-fire' only covers the still-running case, not the stale-due-list case.


**Fix:** Re-verify due-ness with a fresh row right before running: `const fresh = this.deps.db.workflows.getById(workflow.id); if (!fresh || !isDue(fresh, Date.now())) continue; await this.deps.runner.runById(fresh.id, 'schedule')`. Or guard tick() against re-entrancy with an in-flight flag.


### `src/renderer/src/components/settings/ToolsTab.tsx:489` — Edit forms rendered without a key silently overwrite item B with item A's values

*bug*


CustomToolForm (and McpForm, PromptForm, MemoryForm, SkillForm) seed all fields with useState(editing?.x ?? '') and are rendered without a React key. useEditorState.openEdit(item) merely swaps the `editing` state while the form stays mounted, so the stale field state survives. Failure scenario: with the edit form open for custom tool A, the tool list is still visible below; the user clicks Edit on tool B -> the form still shows A's name/baseUrl/headers but `editing` is now B -> clicking Save calls customUpdate(B.id, {A's values}), silently corrupting B. For CustomToolForm/McpForm this also mangles secrets: splitRows(rows /* A's rows */, editing.secretHeaders /* B's names */) computes deleteSecrets = B's secrets missing from A's rows, deleting B's stored encrypted headers/env vars. Same defect in McpServersTab.tsx:254, PromptsTab.tsx:110, MemoryTab.tsx:172, SkillsTab.tsx:152. AgentsTab.tsx:241 proves the intended pattern (key={editing?.id ?? 'new'}) — the other five tabs miss it.


**Fix:** Add key={editing?.id ?? 'new'} to CustomToolForm, McpForm, PromptForm, MemoryForm and SkillForm render sites (as AgentsTab already does) so switching the edited item remounts the form with fresh initial state.


### `src/main/tools/definitions.ts:756` — schedule_task lacks noStandingApproval, so a conversation-scope grant lets the model mint autonomous shell-enabled tasks with no dialog

*security*


executor.ts executeInner grants standing conversation approval to any tool without noStandingApproval (lines 806-813), and the renderer dialog offers 'Allow for this conversation' whenever the flag is absent (ToolApprovalDialog.tsx:113). schedule_task's entire pre-approved-tools consent model depends on the per-call dialog: its description says "the user's approval of THIS call is that consent - the approval dialog names them", and the executor comment (executor.ts:1500-1503) says "a task must not mint further standing grants". Failure scenario: shell execution is enabled; the user clicks 'Allow for this conversation' on a benign schedule_task call (e.g. action=list). From then on, a prompt-injected model (e.g. via fetch_url/web content) can call schedule_task action=create with tools:["run_shell_command","write_file"] and an hourly recurrence with NO approval dialog ever shown - creating a persistent job that runs arbitrary shell commands headlessly every hour (the headless runner auto-approves the granted ids). git_write got noStandingApproval for far less consequential per-call actions; schedule_task creates standing autonomous execution and grants other tools, so it needs the same flag.


**Fix:** Add `noStandingApproval: true` to the schedule_task definition (this also removes the 'Allow for this conversation' button in the dialog and blocks conversationApprovals grants in the executor, matching git_write). Alternatively, special-case action=create in executor.approvalPreGranted so creates with a non-empty 'tools' array always require a fresh dialog.


### `src/main/code/code-service.ts:293` — Path-jail escape: 'create' apply and 'delete' revert write through dangling symlinks outside the project root

*security*


In applyChange's 'create' branch, when the target does not pass existsSync the code calls writeFileSync(target, ...) with the default 'w' flag. existsSync() follows symlinks and returns false for a DANGLING symlink, so a symlink inside the project pointing to a non-existent path outside the root (e.g. checked into a cloned repo, or created by the opt-in shell tool) skips both the existsSync branch and the realInsideRoot canonicalization — writeFileSync then follows the symlink and creates the file at the outside target (e.g. ~/.ssh/authorized_keys, a startup folder script). This defeats the module's central SAFETY INVARIANT that every write is jailed to the project root. The same hole exists in revertChange's 'delete' branch (line 376): existsSync(abs) is false for a dangling symlink, so the restore writes through it. A secondary side effect: in the 'create' branch mkdirSync(dirname(abs), { recursive: true }) runs BEFORE the realDir containment check, so a live symlinked intermediate directory causes directories to be created outside the root even though the file write itself is then rejected.


**Fix:** In both 'file does not exist' branches, open with the exclusive-create flag — writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' }) — which fails with EEXIST when the path exists as a symlink (even dangling), or lstatSync the leaf and reject symlinks explicitly. Also move the realInsideRoot(dirname) check (or an lstat walk) before mkdirSync so no directories are created through a symlinked parent.


### `src/main/code/workspace-root.ts:52` — Backup-imported conversation id escapes the per-task workspace sandbox (arbitrary directory creation + file writes outside {userData}/data/workspaces)

*security*


WorkspaceRootService.ensure() builds a Work task's auto workspace with `const dir = join(this.base, conversationId)` and then `mkdirSync(dir, {recursive:true})` + `projectUpsertByPath(dir, ...)`, trusting conversationId to be an app-generated UUID. It is not always: the backup importer accepts a conversation whose id is fully attacker-controlled. In src/main/services/backup.ts `conversationItemSchema` validates `id: z.string().min(1).max(100)` with NO charset restriction, and applyBackup() calls `db.conversations.create({ id: c.id, mode: c.mode==='chat'?'chat':'work', ... })`, which the repository stores verbatim (`input.id ?? randomUUID()`). A malicious backup file can therefore create a Work conversation with id `../../../../Users/<user>/evil`. When that conversation later triggers workspace creation — via write_file/edit_file, schedule_task-with-grants, or even just an assistant `uld-change` block (the artifact-hooks path calls ensureWorkspaceRoot with no user approval) — `join(base,'../../../../Users/<user>/evil')` resolves OUTSIDE the workspaces base (verified: resolves to the user's home tree, escapes:true). mkdirSync creates that directory and registers it as a code_projects root; all subsequent path-jailed file writes then land outside the app-owned {userData}/data/workspaces sandbox (e.g. into the user's home directory: .gitconfig, startup scripts). This breaks the documented invariant that auto workspaces live only under the workspaces base. (It also defeats the auto-delete path-prefix guard, since isAutoPath() returns false for the escaped path.)


**Fix:** Reject any conversationId that is not a bare app id before joining: after computing `dir = resolve(join(this.base, conversationId))`, assert `dir === base || dir.startsWith(base + sep)` and throw otherwise; and/or constrain the backup `conversationItemSchema.id` to a safe charset (e.g. /^[A-Za-z0-9._-]{1,100}$/, matching how randomUUID ids look) so traversal segments can never enter the DB.


## MEDIUM severity


### `src/main/db/repositories/conversations.ts:147` — Conversation search cannot match non-ASCII uppercase text — JS toLowerCase needle vs SQLite ASCII-only LOWER()

*bug*


list() lowercases the search needle in JS (full Unicode fold) but folds the columns with SQLite's built-in LOWER(), which only folds ASCII A-Z in the bundled node-sqlite3-wasm build. Any stored title or message text containing uppercase non-ASCII letters (Å, Ä, Ö, É, ...) can never match: the needle side becomes 'ö' while LOWER('Ö') stays 'Ö'. Verified empirically against the project's node-sqlite3-wasm: title 'Örebro plan' + search 'Örebro' returns 0 rows, while a plain LIKE with the exact-case needle returns 1. This is a regression versus plain LIKE — even an exact-case query fails — and it silently hides conversations from sidebar search for any non-English content (the comment on line 144-146 claims the opposite behavior).


**Fix:** Register a Unicode-aware lower UDF in driver.ts using node-sqlite3-wasm's db.function('ulower', (s) => (s ?? '').toLowerCase(), { deterministic: true }) and use ulower(c.title)/ulower(m.content) in the query. A cheaper partial fix (still misses cross-case non-ASCII but restores exact-case matching): also OR a plain `c.title LIKE ?` with the original-case pattern.


### `src/main/providers/openai-compatible.ts:563` — Explicit finish_reason 'stop' alongside streamed tool calls prevents tool execution

*bug*


chatStream only infers 'tool_calls' when the provider never sent a finish_reason (`finishReason ?? (emitted.size > 0 ? 'tool_calls' : 'stop')`); an explicit 'stop' wins even though tool_call events were emitted. Non-streaming chat() (line 502) has the same gap. Every native adapter deliberately overrides this (bedrock.ts:453 `sawToolCalls ? 'tool_calls' : stopReason`, google.ts:260, openai-codex.ts:281, native.ts collectStream:61), so the OAI-compatible family is the odd one out. Failure scenario: known-quirky OpenAI-compatible servers (llama.cpp server, older vLLM builds among the 120+ presets) stream tool_calls deltas but finish with 'stop'; chat-service's tool loop gates on `roundFinish !== 'tool_calls'` (chat-service.ts:2483, also 1488/1917) and breaks, so the model's tool calls are persisted as 'proposed' but never executed and the turn dead-ends.


**Fix:** Match the native adapters: `yield { type: 'finish', reason: emitted.size > 0 ? 'tool_calls' : (finishReason ?? 'stop') }`, and in chat() use `toolCalls.length > 0 ? 'tool_calls' : (mapFinishReason(choice.finish_reason) ?? 'stop')`.


### `src/main/providers/google.ts:236` — Gemini adapter silently swallows in-stream error payloads and blocked prompts, persisting empty/truncated replies as successful

*bug*


parseGeminiChunk only inspects `candidates` and `usageMetadata`. Two failure shapes the Generative Language API returns with HTTP 200 are ignored: (1) a prompt blocked by safety returns `promptFeedback.blockReason` with zero candidates, and (2) a mid-stream failure arrives as an in-band `{"error": {code, message, status}}` SSE payload. In both cases chatStream falls out of the loop and yields the synthetic `finish: 'stop'` (line 260), so chat-service persists an empty or truncated assistant message with status complete and shows no error. Additionally SAFETY/RECITATION finishReasons map to 'other', which chat-service rewrites to 'stop', so a mid-answer safety cut is also indistinguishable from success. Every other native adapter guards this: anthropic.ts throws on `type === 'error'`, openai-codex.ts on `response.failed`/`error`, bedrock.ts on exception frames plus a `sawMessageStop` guard. Notably the same file already handles `promptFeedback.blockReason` for image generation (line 356) but not for chat. Failure scenario: a user prompt trips Gemini's safety filter (or the backend errors mid-stream during a scheduled task/workflow run) -> the app records an empty assistant reply marked complete, with no error surfaced anywhere.


**Fix:** In chatStream's payload loop (and thus chat() via collectStream), before parseGeminiChunk: if the parsed JSON has an `error` object, throw a ProviderError mapped from error.code/status with the redacted message; if it has `promptFeedback.blockReason` with no candidate content, throw ProviderError('invalid_request', `The prompt was blocked (${blockReason}).`) mirroring generateImage. Optionally map SAFETY/RECITATION finishReasons to a surfaced condition instead of 'other'.


### `src/main/services/chat-service.ts:2554` — Stop mid tool-round drops already-executed tool-call records from the persisted message

*bug*


In runStream's tool loop, roundCalls are only appended to the persisted toolCalls array after the whole per-call loop finishes (line 2554), but the abort check inside the loop (line 2536) throws between calls. Scenario: a round has 3 tool calls; call 1 executes (e.g. write_file mutates the workspace, or run_shell_command runs); the user clicks Stop while call 2 is pending; the abort check throws; finalize('stopped') persists the message WITHOUT any of this round's calls. The executed side effect is now invisible: the tool card disappears on reload, and the next generation's history replay omits the call, so the model does not know it already performed the mutation and may repeat it (double file write / double shell command).


**Fix:** Record calls incrementally: push each call into toolCalls as soon as it settles (or wrap the per-call loop in try/finally that pushes the round's already-processed calls before rethrowing the abort), so finalize('stopped') persists every executed call with its result.


### `src/main/services/chat-service.ts:1494` — Scheduled-task pre-approved custom tools are always auto-declined (definition id compared against wire name)

*bug*


generateForWorkflow's headless approval callback checks approvedTools.has(req.toolCall.name). approvedToolIds are definition IDs — validateScheduledTaskGrants (register.ts:1377) validates them via registry.getById, and the schedule_task tool stores tool.id (executor.ts:1519), which for custom HTTP tools is 'custom:<uuid>'. But req.toolCall.name is the WIRE name (the user-chosen name for custom tools; executor.ts:796 passes the raw ToolCallRecord). So a scheduled task that pre-approves a custom tool (offered by the ScheduledTasks UI grant list) always fails the has() check at run time and the call resolves to USER_DECLINED_RESULT — the user's explicit standing grant silently never works. Builtins and MCP tools only work by the coincidence name === id.


**Fix:** Resolve the call to its definition before checking, mirroring runDelegate's fix: e.g. const def = tools.registry.listEnabledDefinitions().find(d => d.id === req.toolCall.name || d.name === req.toolCall.name); approved: !!def && approvedTools.has(def.id).


### `src/main/services/chat-service.ts:647` — App quit leaves agent_runs rows stuck at 'running' forever (no runFinish on stopAll, no boot recovery)

*bug*


stopAll() sets task.status = 'stopped' in memory before aborting, so the .then/.catch handlers in startDelegateBackground (which guard on record.status === 'running') never call db.agentPlatform.runFinish — the persistent agent_runs row stays 'running'. Boot recovery only fixes messages (index.ts:274 markDanglingStreamingAsStopped); nothing ever updates dangling agent_runs (the only UPDATE is runFinish). After any quit or crash with a background delegate running, the Agent Control Center (AgentsTab) shows a phantom 'running' run forever, its Stop button is a no-op (stopAgentRun scans the now-empty in-memory backgroundTasks map and returns false), and the tab's 2-second refresh interval (AgentsTab.tsx:203-207) polls indefinitely whenever it is open because runs.some(status === 'running') never clears.


**Fix:** In stopAll, call this.db.agentPlatform.runFinish(task.runId, 'stopped', task.result) for delegate tasks when flipping them to 'stopped'; additionally add a boot-time recovery mirroring markDanglingStreamingAsStopped (UPDATE agent_runs SET status='stopped', finished_at=? WHERE status='running') to cover crashes.


### `src/main/services/research.ts:492` — Research context cap truncates the numbered sources and report instructions, not the findings

*bug*


buildInjectedContext assembles preamble + findings + numbered sources + report instructions, then caps the WHOLE string from the tail with capChars(context, 24000). Worker findings alone can reach 36,120 chars on 'deep' (6 workers x WORKER_FINDINGS_MAX_CHARS 6,000) and 24,000+ on 'standard' (4 x 6,000), so any verbose run cuts off everything after char 24,000 - i.e. the '--- Numbered sources ---' list and all 'Report instructions'. The synthesizer then never sees the citation ids or the instruction not to add its own Sources section, yet chat-service.ts (line ~2589) still appends formatSourcesSection(research.sources) to the final message - producing a report with a dangling numbered Sources block, no matching [n] citations, and a model free to mention the internal research scaffolding.


**Fix:** Budget the findings section instead of the whole context: compute remaining = INJECTED_CONTEXT_MAX_CHARS - (preamble + sourceLines + instructions).length and truncate findingBlocks (per-block or proportionally) to that budget, so sources and instructions always survive. Alternatively place instructions/sources before the findings and cap only the findings blob.


### `src/main/services/bundled-skills.ts:48` — Bundled-skill seeding silently overwrites a same-named user-authored skill and adopts it into the bundle

*bug*


db.skills.upsertByName matches by name globally (skills.ts repository, getByName has no pluginName scope). If a user has authored a skill whose name collides with a skill shipped in a new BUNDLED_SKILLS_VERSION, the boot-time seeding overwrites the user's content/description and rewrites plugin_name to the bundle's plugin. From then on the skill is treated as bundled: a later bundle version that stops shipping that name will DELETE it in the reconciliation loop (lines 39-46). This contradicts the module's own guarantee that 'user-authored skills are never touched because reconciliation is scoped to the bundle's plugin name' - the upsert step is not so scoped. Failure scenario: user creates skill 'code-review'; an app update ships a bundled 'code-review' and bumps the version; on next boot the user's skill content is silently replaced with no way to recover it.


**Fix:** Before upserting, look up the existing skill by name and skip (or rename the bundled copy) when existing.pluginName !== pluginName - i.e. only upsert rows that are new or already owned by this bundle.


### `src/main/tools/executor.ts:1932` — Stop cannot abort a running run_shell_command: the executor passes signal=undefined to runShell

*bug*


runShell (src/main/tools/shell.ts:45-99) fully supports an AbortSignal that kill-trees the child, but runShellCommand hardcodes `undefined` for it, and ToolExecuteContext carries no signal at all. The chat loop (chat-service.ts:2536) only checks controller.signal.aborted BETWEEN tool calls. Failure scenario: the model runs a command with timeoutSeconds=600 (e.g. a build or test suite); the user clicks Stop - the AbortController fires but nothing reaches the child process, so the command keeps executing side effects and the stream loop stays blocked in `await executor.execute(...)` for up to 10 minutes before the 'stopped' state can persist. On app quit it is worse: stopAll's 3s guard elapses, the DB is closed while the loop is still awaiting the shell, and the child process (spawned detached on POSIX) survives the app entirely; the eventual persistence attempt then fails against the closed DB.


**Fix:** Add an optional `signal?: AbortSignal` to ToolExecuteContext, pass the stream's controller.signal from chat-service (all executor.execute call sites), and forward `ctx.signal` here as runShell's 4th argument (it already implements abort => killTree). Consider also honoring the signal in fetchWithTimeout and the delegate path.


### `src/main/tools/git.ts:26` — git tool fails entirely on output over 64 KB instead of truncating, breaking diffs/logs on real repos

*bug*


runGitQuery caps output with execFile's `maxBuffer: 64*1024`, but exceeding maxBuffer does not truncate — execFile kills the child and returns an error whose code is ERR_CHILD_PROCESS_STDIO_MAXBUFFER (error.killed is undefined, not a timeout, not ENOENT). That falls through to the generic `if (error)` branch, so a large `git diff`/`git log`/`git status` returns ok:false with output 'stdout maxBuffer length exceeded', surfaced to the model as e.g. 'git diff failed: stdout maxBuffer length exceeded'. Real working-tree diffs routinely exceed 64 KB, so the read-only git tool fails on exactly the cases (reviewing a substantial diff) it exists to serve, unlike shell.ts which correctly caps output at MAX_OUTPUT_BYTES. The constant is even named GIT_MAX_OUTPUT implying truncation. Verified experimentally: 200 KB stdout with maxBuffer 64 KB yields killed=undefined, code=ERR_CHILD_PROCESS_STDIO_MAXBUFFER, and stdout captured up to 65536 bytes.


**Fix:** Detect the maxBuffer error code and return the captured (truncated) stdout with a '…[truncated]' marker instead of a failure, or spawn git and cap the stream manually the way shell.ts does (append up to a byte cap, kill on exceed) so large diffs are truncated rather than erroring out.


### `src/main/ipc/register.ts:543` — providersDelete leaves dangling provider ids in modeModels, moaPresets, researchWorker and image settings

*bug*


The handler's transaction clears settings.defaultProviderId and conversation.provider_id ('so no dangling ... survives' per its own comment), but not the other settings that store provider ids: modeModels.{chat,work}.providerId, moaPresets[].referenceModels/aggregator.providerId, researchWorkerProviderId, defaultImageProviderId. Failure scenario: user enables per-mode models with provider A for chat, then deletes provider A. convCreate (register.ts:671-686) still stamps the deleted id onto every new chat via modeModelDefault(), and resolveTarget then fails each send with 'No provider configured. Open Settings to add one.' even though other providers and a global default exist. MoA presets aggregating through the deleted provider fail the same way; deep-research/image-generation defaults silently break.


**Fix:** Inside the same transaction, scrub every settings reference to the deleted id: null out modeModels entries whose providerId matches, null researchWorkerProviderId/defaultImageProviderId when they match, and disable (or drop advisor entries from) moaPresets that reference the provider.


### `src/main/ipc/register.ts:1274` — im:setWebhook accepts any string with no URL, https, or length validation

*bug*


Unlike MCP URLs and provider base URLs (validated with isAllowedHttpUrl at set time) and even settingsPatchSchema (max 2000 for outboundWebhookUrl), this handler only checks typeof and stores the raw string via ImBridgeManager.setWebhook straight into settings — no zod, no length cap, no URL parse. postWebhook (im/manager.ts:177-186) then silently treats any unparsable or http://non-localhost URL as 'unconfigured'. Failure scenario: user enters 'example.com/hook' (no scheme) or an http:// remote URL; the call succeeds, im.status() shows the webhook as configured, but completion webhooks silently never fire and a workflow notify node throws the misleading 'No delivery channel available — connect the Telegram bridge or configure a webhook.' Also allows persisting an arbitrarily large string into the settings row.


**Fix:** Validate at the boundary like the MCP handler does: parseInput(z.string().trim().max(2000).nullable(), url) and, for non-null non-empty values, throw invalid(...) unless isAllowedHttpUrl(url) — so a bad webhook is rejected at set time instead of silently dropped at send time.


### `src/main/im/telegram.ts:65` — Long-poll loop spins with zero delay when Telegram returns ok:false (invalid/revoked token, 409 conflict)

*bug*


loop() only backs off (3 s sleep) when pollOnce throws. Telegram API errors (401 for a bad/revoked token, 409 when the same token long-polls from two clients) are returned as valid JSON `{"ok":false,...}` with an immediate response, so pollOnce returns normally via `if (!data.ok ...) return` and the while-loop re-issues getUpdates instantly. Scenario: user pastes a mistyped token or revokes the bot via BotFather while the bridge is enabled — the main process then hammers api.telegram.org in a tight network loop (limited only by RTT, roughly 5-10 req/s) indefinitely, burning CPU/bandwidth and risking an IP-level ban from Telegram.


**Fix:** Treat a non-ok API response as an error: either `throw new Error('telegram api error')` so the existing 3 s backoff applies, or `await sleep(3000)` before returning when `!data.ok`.


### `src/shared/pricing.ts:51` — Pricing table missing the catalog's own default models (gpt-5.5, MiniMax-M3), breaking auto-routing ranking

*bug*


catalog.ts sets defaultModelId 'gpt-5.5' for the openai family (catalog.ts:88) and 'MiniMax-M3' for minimax (catalog.ts:72), but MODEL_PRICING.openai only goes up to 'gpt-5' and MODEL_PRICING.minimax only has M2/M1/Text-01. pickAutoRouteProvider (chat-service.ts:96-123) prices providers via findPricing(provider.type, provider.defaultModelId): a freshly added OpenAI or MiniMax provider at family defaults returns null cost, so (a) with autoRoutingMaxCostUsd set it is silently excluded from routing entirely ('unknown-priced remote models cannot satisfy a budget'), (b) under 'lowest_cost' it sorts last (Infinity), and (c) under 'highest_quality' it gets cost -1 — ranked WORSE than a free glm-4.5-flash — so the flagship model is never chosen. The per-message cost estimate also silently disappears for the default models users are most likely on.


**Fix:** Add MODEL_PRICING entries for 'gpt-5.5' and 'MiniMax-M3' (the ids catalog.ts points new providers at). Consider a unit test asserting every PROVIDER_TYPES[t].defaultModelId with a non-empty family pricing table has a pricing entry, so catalog default bumps can't drift from the table again.


### `src/shared/schemas.ts:360` — Webhook URL accepted without validation while delivery silently drops non-https/non-localhost URLs

*bug*


settingsPatchSchema accepts any string (max 2000) for outboundWebhookUrl, and the im:setWebhook handler (register.ts:1274) plus ImBridgeManager.setWebhook store any string verbatim. But postWebhook (im/manager.ts:179-187) silently returns 'unconfigured' when the stored value is not parseable or is http:// to a host other than localhost/127.0.0.1, and all failures are swallowed. Failure scenario: user enters 'http://192.168.1.10:9000/hook' (a LAN receiver — the plausible setup for a local-first app) or a typo like 'htp://…' in Settings → Bridges; the UI toasts 'Webhook updated.' (BridgesTab.tsx:65) and every completion event is silently discarded forever — no error is ever surfaced. Also note postWebhook's allowlist omits '::1', inconsistent with LOCAL_HTTP_HOSTS in this same file.


**Fix:** Validate at accept time so misconfiguration fails loudly: in settingsPatchSchema use z.string().trim().url().refine(isAllowedHttpUrl, …).max(2000).nullable(), and apply the same check in the imSetWebhook handler / ImBridgeManager.setWebhook. Align postWebhook's host check with LOCAL_HTTP_HOSTS (include '::1').


### `src/renderer/src/stores/chat.ts:203` — send/regenerate/editAndRerun apply results to whichever conversation is open, locking the composer and rendering ghost messages

*bug*


send() captures `conversation` before the IPC call, but its success set() (lines 203-210) does not re-check that the same conversation is still open. Main-side chat.send awaits resolveTarget() (async OAuth token refresh / model resolution) before responding, so a later-issued conversations.get/messages for a newly selected conversation can resolve first. Failure scenario: user hits Send in conversation A, immediately clicks conversation B in the sidebar; openConversation(B) completes, then the chat.send response resolves and appends A's user message + streaming placeholder into B's message list and sets `streaming` to A's stream. Every subsequent envelope for A now hits the foreign-conversation early-return (`conversation?.id !== envelope.conversationId`, line 313), so A's 'done' never clears `streaming` — the composer (Composer.tsx line 186, `streaming !== null`) stays permanently locked and A's messages ghost-render inside B until the user navigates away. regenerate() (via beginReplacementStream, line 39) and editAndRerun() (set at lines 275-289; a not-found messageId makes `kept` the whole foreign list) have the identical defect. pickCompareWinner (lines 240-247) already guards this exact race, proving the hazard is known.


**Fix:** Mirror pickCompareWinner's guard in all three actions: `set((s) => s.conversation?.id === conversation.id ? { messages: ..., streaming: ... } : {})`. When stale, do nothing — the generation continues in main and is re-adopted by handleStreamEvent's placeholder-recovery path if the user returns to that conversation.


### `src/renderer/src/stores/code.ts:163` — loadForConversation keeps the previous project's allChanges, so the 'All chats' review queue shows (and acts on) another project's changes

*bug*


When switching to a conversation bound to a different project, the non-samePath set() updates project/tree/selectedPaths/openFile but leaves `allChanges` from the previous project, and only loadChanges/loadGitStatus are re-run — loadAllChanges is not. Failure scenario: user has project P1 open with the Changes panel scope set to 'all' (allChanges loaded for P1), then selects a conversation linked to project P2. ChangesPanel (scope still 'all') renders P1's entire review queue labeled as P2's, and its Apply/Reject/Revert buttons operate on those stale change ids — the user applies file writes belonging to a project that is not on screen. The onChangesChanged subscription won't correct it either, since it only refreshes on events for the *current* project.


**Fix:** In the non-samePath branch, also reset `allChanges: []` (and `gitStatus: null`), and after the project switch run `if (get().changesScope === 'all') void get().loadAllChanges()` so the 'All chats' scope reloads for the new project.


### `src/preload/index.ts:85` — push:conversationsChanged is broadcast by main but never exposed/subscribed — IM-bridge replies never appear live in the renderer

*bug*


The channel is declared (src/shared/ipc.ts:294) and main broadcasts it after headless Telegram-bridge replies (chat-service.ts runHeadless, line 1382) and mid-stream compaction (line 1232), but preload exposes no onConversationsChanged subscription and no renderer store listens (verified: zero matches for the channel anywhere under src/renderer, and git history shows the subscription never existed). Failure scenario: the Telegram bridge inserts a user message and assistant reply into a conversation (generateHeadless emits no stream envelopes); if that conversation is open in the app the new messages never render, and the sidebar's updatedAt/snippet/order stay stale — the exchange is invisible until the user manually re-selects the conversation or restarts. The compaction broadcast is likewise a dead letter (that case happens to self-heal via refreshOpenConversation on 'done').


**Fix:** Expose `onConversationsChanged: subscribe(CHANNELS.conversationsChanged)` in preload (plus the UldApi type), and in App.tsx subscribe it to `useConversationsStore.getState().load()` and, when the pushed conversation is the open one, re-fetch its messages (or include the conversationId in the payload and route through syncSummary/refreshOpenConversation).


### `src/renderer/src/components/chat/ChatView.tsx:53` — Escape in conversation-settings popover (and FilePreview / AddItemMenu) also aborts an in-flight generation

*bug*


ConversationSettingsButton's document keydown handler closes the popover on Escape but does not stopPropagation. The global shortcut handler (useKeyboardShortcuts, window bubble listener) explicitly lets Escape through even from editable targets and falls through to `if (chat.streaming) void chat.stop()`. Failure scenario: while an answer is streaming, the user opens the chat-header gear popover to tweak the system prompt (the button is not disabled during streaming) and presses Escape to dismiss it -> the popover closes AND the generation is aborted, persisting a truncated 'stopped' message. Same missing guard in code/FilePreview.tsx:25-27 (Esc while previewing a file during a Work-mode run) and work/WorkspaceItems.tsx:256-259 (AddItemMenu). The codebase treats this as a known hazard: Composer's confirm bar, ModelSelector, ScheduledTasks, ToolApprovalDialog and ArtifactPanel all call e.stopPropagation() (mostly capture-phase) with comments saying exactly this.


**Fix:** In all three handlers, call e.stopPropagation() (and register with capture: true, matching ScheduledTasks/ToolApprovalDialog) when handling Escape so the event never reaches the global stop-generation handler.


### `src/renderer/src/components/chat/Composer.tsx:172` — Attachments, pending-confirm files and draft text leak across conversation switches

*bug*


The per-conversation reset effect (comment: "per-conversation intents; don't leak them across switches") resets only compareOn/researchOn/researchDepth. `attachments`, `pendingFiles` and `value` survive because Composer is a single persistent instance for all conversations of a mode (App renders ChatView/WorkView unkeyed). Failure scenario: user attaches a sensitive file in conversation A (confirming the warnBeforeSendingFiles bar against A's provider), clicks conversation B in the sidebar (possibly a different cloud provider), types a quick question and hits Enter -> the file contents are sent to B's provider with no re-confirmation, since the confirm already happened in A's context. The half-typed draft for A likewise gets sent to B.


**Fix:** In the same [conversation?.id] effect also reset setValue(''), setAttachments([]), setPendingFiles(null), setMention(null)/setMentionItems([]) — or key <Composer key={conversation?.id}> to remount per conversation (optionally persisting drafts per id if drafts should survive).


### `src/main/ipc/register.ts:549` — Deleting the default provider always fails: nested BEGIN inside providersDelete transaction

*bug*


The providersDelete handler wraps its cleanup in db.driver.transaction(), but when the deleted provider is the current default it calls db.settings.update(), and SettingsRepository.update() opens its own driver.transaction() (settings.ts:45). driver.transaction() issues a plain 'BEGIN', and SQLite rejects a nested BEGIN. Verified against node-sqlite3-wasm in this repo: nested BEGIN throws 'cannot start a transaction within a transaction'. The outer transaction rolls back and the error is returned to the renderer, so a provider that is currently set as the default provider can NEVER be deleted through the UI — the operation fails 100% of the time for exactly that case, while deleting non-default providers works, making the bug look intermittent.


**Fix:** Either make driver.transaction() nesting-safe (track an inTransaction flag and use SAVEPOINT/RELEASE for inner calls), or clear the default with direct non-transactional writes inside the handler (e.g. a settings.clearDefaultProvider() that uses plain driver.run), or run the settings update after the transaction commits.


### `src/main/index.ts:274` — agent_runs rows stuck in status 'running' forever — no boot recovery and stopAll() never finishes them

*bug*


Boot recovery only covers messages (markDanglingStreamingAsStopped). agent_runs rows created by startDelegateBackground (chat-service.ts:1705) are only moved out of 'running' by runFinish in the task's .then/.catch or delegateTaskStop. ChatService.stopAll() (app quit) sets the in-memory record to 'stopped' and aborts WITHOUT calling agentPlatform.runFinish, and the .then/.catch guards ('if record.status === running') then skip runFinish too — so EVERY app quit with a background delegate running, and every crash, permanently strands a DB row at status 'running' with finished_at NULL. The Agent Control Center (agentRunsList, LIMIT 100) then shows phantom perpetually-running agents across restarts, and stopAgentRun() cannot stop them (it only scans the in-memory backgroundTasks map), so the stale rows accumulate forever.


**Fix:** At boot, next to markDanglingStreamingAsStopped(), run an agent-runs sweep: UPDATE agent_runs SET status='stopped', finished_at=<now> WHERE status='running' (add a repository method). Also make stopAll() call this.db.agentPlatform.runFinish(record.runId, 'stopped', record.result) for each running task it aborts.


### `src/main/ipc/register.ts:754` — convFork copies messages without a transaction: partial forks on failure and one journal commit per message

*bug*


The fork handler creates the conversation then inserts every copied message with individual driver.run calls, no transaction. (1) Integrity: if an insert throws midway (disk full, app crash), the fork conversation remains in the DB with a silently truncated transcript — the error surfaces to the renderer but the half-fork persists and looks like a valid conversation. (2) Performance: node-sqlite3-wasm's VFS does not support WAL (the driver's journal_mode=WAL attempt is expected to fail), so each INSERT is its own rollback-journal commit; forking a 500-message conversation executes 500 separate commits synchronously on the main process, blocking all IPC and stream-event delivery for the duration instead of one commit.


**Fix:** Wrap the conversation create + message copy loop in db.driver.transaction(() => { ... }) so the fork is atomic and commits once.


### `src/main/services/backup.ts:325` — Backup import inserts messages without a transaction: crash makes the conversation permanently skipped with missing messages

*bug*


applyBackup inserts each conversation's messages with individual auto-committed INSERTs. The catch-block rollback (db.conversations.remove) only handles thrown errors — a crash or forced quit mid-import leaves the conversation row committed with only part of its transcript. Because import dedupes by id ('if (db.conversations.getById(c.id)) { skip }'), every subsequent re-import of the same backup silently skips that conversation forever, so the missing messages are unrecoverable through the import flow — a real data-loss path. Additionally, applyBackup is fully synchronous on the main process: importing a backup with e.g. 10k messages performs 10k separate rollback-journal commits (WAL unavailable under the WASM VFS), freezing the UI far longer than a single-commit import would.


**Fix:** Wrap each conversation's create + message inserts in db.driver.transaction(() => { ... }) so a conversation imports atomically (crash = clean rollback, re-import retries it) and commits once. (Note: if the fix for the providersDelete nesting lands as driver-level SAVEPOINT support, db.settings.update inside such a wrapper also becomes safe.)


### `src/main/providers/redact.ts:21` — Quadratic backtracking in base64 redaction regex freezes the main process on large digit-free text

*performance*


The generic base64 pattern uses an unbounded lookahead `(?=[A-Za-z0-9+/_]*[0-9])` evaluated at every position of a long alphanumeric run; when the run contains no digit (letters g-z, so the hex pattern doesn't consume it) the scan is O(n^2). Measured in Node: 100 KB run = 2.7 s, 200 KB run = 13 s of synchronous CPU. redactSecrets runs on the Electron main thread over up to ~128 KB of shell output per tool call (executor.ts:1943 and chat-service.ts:1780 call it on stdout+stderr, each capped at 64 KB in tools/shell.ts). Failure scenario: the model (or a prompt-injected page) runs `run_shell_command` printing e.g. `python -c "print('g'*100000)"`; every IPC handler, active stream, and window freezes for several seconds per tool round.


**Fix:** Make it linear: match the plain run `/[A-Za-z0-9+/_]{32,}={0,3}/g` and use a replace callback that returns '[redacted]' only when /[0-9]/.test(match), otherwise returns the match unchanged. Same semantics (digit required somewhere in the run), O(n).


### `src/main/tools/executor.ts:490` — ReDoS guard misses {m,} quantifiers and overlapping alternation, so grep can still freeze the entire app

*performance*


hasCatastrophicBacktracking only marks a group body 'unbounded' on literal '*' or '+' characters. Two exponential families pass: (1) the exact documented bad shape with braces - '(\\w{1,}\\s?)*;$' ({1,} === + but never sets bodyQuantified); (2) overlapping alternation - '(a|a)+$' or '(\\w|\\d)+=$' (no quantifier inside the body at all). Measured on this machine: /(a|a)+$/ takes 2.4s at just 28 chars of input and /(\w{1,}\s?)*;$/ takes 4.4s at 26 chars - both doubling per character. runGrep executes the pattern synchronously on the Electron main process against every line (up to SEARCH_LINE-length lines across 256KB files, 20k files), so one such pattern on a modest line (~40-60 chars, e.g. any long identifier for '(\\w|\\d)+=$') freezes the whole app for hours - the exact outcome the guard's own comment promises to prevent ('Stop can't even be delivered'). A model plausibly emits {1,} spellings or overlapping alternations on its own, and a prompt-injected page can dictate one deliberately once grep has a conversation-scope grant.


**Fix:** In the body scan, also treat '{' quantifiers with no finite upper bound ('{m,}') as unbounded (scan ahead for ',}'), and flag quantified groups containing '|' whose alternatives can overlap (conservatively: any '|' inside a '+'/'*'/'{'-quantified group). Better long-term: enforce a hard wall-clock budget by running the scan line-slice by line-slice and bailing out, or move grep matching to a worker thread that can be killed.


### `src/main/code/workspace-root.ts:73` — Synchronous recursive rmSync inside IPC handlers can freeze the whole main process

*performance*


conv:delete (register.ts:697-708) and data:deleteAllContent (register.ts:783-797) call WorkspaceRootService.deleteIfAutoRegistered/deleteAll, which use rmSync(path, { recursive: true }) on the main thread. Auto workspaces are the working dirs for Work-mode agents, which can run 'npm install' there via run_shell_command, leaving tens of thousands of files in node_modules. Deleting such a conversation blocks the main process event loop for the entire recursive delete (seconds to tens of seconds on Windows NTFS): every IPC call, stream event push, menu and window event in ALL windows stalls until it finishes. The handlers are already async, so there is no reason to block.


**Fix:** Use await rm(project.path, { recursive: true, force: true }) from node:fs/promises in deleteIfAutoRegistered and deleteAll (make them async and await them in the conv:delete / data:deleteAllContent handlers), so the deletion runs on the libuv threadpool instead of blocking the event loop.


### `src/main/code/code-service.ts:265` — applyChange loads and JSON-parses the entire conversation transcript just to read the last message seq

*performance*


Every applied code change (including every model edit in autoAcceptEdits Work mode — potentially dozens per generation) calls messages.listByConversation(), which is SELECT * over all message rows followed by JSON.parse of attachments_json/tool_calls_json/moa_references_json/research_json per row, only to compute messages.at(-1)?.seq for the checkpoint. A long agentic Work conversation (hundreds of messages, tool-call records, MoA/research payloads) means several MB marshalled out of WASM and parsed synchronously on the main process per file write, stalling the active stream's event delivery. The repository already has an indexed aggregate for this: nextSeq() runs SELECT COALESCE(MAX(seq),0)+1 against idx_messages_conv.


**Fix:** Replace with the existing aggregate: messageSeq: this.db.messages.nextSeq(change.conversationId) - 1 (or add a lastSeq(conversationId) repo method doing SELECT MAX(seq)).


### `src/main/db/repositories/code.ts:147` — changesList returns full old/new file contents and diffs for every change in the project, unbounded

*performance*


changesList is 'SELECT * FROM code_changes WHERE project_id = ? ORDER BY created_at DESC' with no LIMIT, and each row carries diff, new_content and old_content (complete file bodies). The renderer reloads it after every settled generation (WorkView useOnGenerationSettled -> loadChanges) and it also backs codeChangesListAll. On a long-lived Work project the history grows without bound — a few hundred applied changes at tens of KB of content each means tens of MB read synchronously from SQLite in the main process and serialized over IPC per generation, while the Changes panel list only needs path/type/status/diff (contents are needed only in main at apply/revert time, which re-fetches via changeGet anyway).


**Fix:** Project only the columns the list UI needs (id, project_id, conversation_id, file_path, change_type, status, created_at, applied_at, diff — or even diff length with lazy diff fetch) and add a LIMIT (e.g. 200); applyChange/revertChange already re-read the full row by id.


### `src/main/db/repositories/agent-platform.ts:133` — checkpointsList ships up to 100 full pre-edit file snapshots to render a label list

*performance*


checkpointsList does SELECT * FROM checkpoints, so every row's files_json — the complete pre-edit file content captured at apply time — is fetched, JSON.parsed in main, and serialized over IPC. ChangesPanel refetches it in a useEffect keyed on [conversationId, changes], and `changes` gets a new array identity on every loadChanges (every settled generation) — so an agentic session re-marshals up to 100 checkpoints x full source-file bodies (easily several MB) through the synchronous driver and IPC each turn, while the UI renders only label/created_at. Restore goes through checkpointGet(id) separately, which is the only place files are needed.


**Fix:** Select metadata only (id, conversation_id, project_id, change_id, label, message_seq, created_at, optionally json_array_length(files_json) as file count) for the list; keep files_json to checkpointGet, which restoreCheckpoint already uses.


### `src/main/providers/openai-compatible.ts:356` — downloadGeneratedImage buffers the entire response before enforcing the 20 MB cap

*resource-leak*


The generated-image download does `new Uint8Array(await res.arrayBuffer())` and only afterwards checks GENERATED_IMAGE_MAX_BYTES. The URL comes from the provider's images response and is fetched without auth from an arbitrary https host; a misbehaving or compromised provider (or a URL pointing at a huge/endless stream with no Content-Length) makes the main process buffer gigabytes in memory before the cap check ever runs. The same file's error-body path (http.ts readCapped) already stream-caps reads precisely to avoid this.


**Fix:** Stream the body with res.body.getReader(), accumulate chunks with a running byte total, and abort (reader.cancel + throw the existing 'too large' ProviderError) as soon as the total exceeds GENERATED_IMAGE_MAX_BYTES, mirroring readCapped in http.ts.


### `src/main/tools/mcp/manager.ts:125` — MCP connect() attaches its transport to a stale state object under concurrent lifecycle calls, leaking a zombie stdio child

*resource-leak*


connect() captures `state` in a local, sets it in `this.states`, then awaits `this.connector()` which spawns the stdio child / opens the HTTP transport. If any other lifecycle call for the same server id runs during that await — remove() (disconnect + states.delete), setEnabled(false)/disconnect(), or a second connect() from update()/reconnect()/start() (which overwrites the map entry with a fresh state) — the awaited connection is assigned at line 125 to the now-orphaned `state` object that is no longer the map's current entry. That connection is never tracked by the map, so neither disconnect(id) nor stopAll() ever calls close() on it: the spawned stdio child process (or HTTP transport) leaks and survives app quit. Repeated enable/disable or rapid re-config cycles accumulate zombie processes. Concrete: user enables a stdio MCP server (connector begins spawning the child), then quickly removes or disables it; disconnect sees the still-connecting state (connection===null), marks it disconnected/deletes it, then the connector resolves and re-attaches the live child to the dead state — the child is never killed.


**Fix:** After the connector resolves, verify the state is still current before adopting the connection, e.g. `if (this.states.get(config.id) !== state) { await this.closeQuietly(connection); return }` before `state.connection = connection`; otherwise close the just-created connection. Serialize per-server connect/disconnect with a promise chain/mutex keyed by server id.


### `src/main/services/backup.ts:74` — buildBackup exports security-sensitive settings (webhook URL, Telegram pairing code) into the plaintext backup

*security*


buildBackup writes `settings: { ...db.settings.get() }` verbatim, including every SECURITY_SENSITIVE_SETTING_KEYS value. That exports outboundWebhookUrl (Slack/Discord-style webhook URLs are bearer capability secrets - anyone with the URL can post) and telegramBridgePairingCode, which shared/types.ts explicitly documents as 'Shown in the desktop UI only - never accepted from the renderer or a backup'. The module header promises 'API keys, OAuth tokens and other secrets are NEVER part of a backup', but only the IMPORT side filters these keys. Failure scenario: user enables the Telegram bridge (pairing code active, bot not yet paired), exports a backup and shares it (cloud sync, support ticket, machine migration); anyone reading the file learns the pairing code and, since bot usernames are discoverable, can win the trust-on-first-use race and capture the bridge conversation - or can post to the user's webhook endpoint.


**Fix:** In buildBackup, drop every key in SECURITY_SENSITIVE_SETTING_KEYS (at minimum telegramBridgePairingCode, telegramBridgeAllowedChatId and outboundWebhookUrl) from the exported settings object, mirroring the import-side filter.


### `src/main/tools/executor.ts:391` — SSRF guard misses IPv4-mapped IPv6 in hex form, which is the only form WHATWG URL ever produces

*security*


isBlockedHostname checks IPv4-mapped IPv6 with a dotted-quad regex (/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/), but Node's WHATWG URL parser canonicalizes IPv6 hostnames to compressed hex groups: verified `new URL('https://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]'`. The hex form matches none of the checks (not parseIpv4, not the mapped regex, not '::1'/'::'/fe8x/fcxx), so isBlockedHostname returns false and fetch_url connects. Failure scenario: model calls fetch_url with 'https://[::ffff:7f00:1]:8443/...' (= 127.0.0.1) or 'https://[::ffff:c0a8:101]/' (= 192.168.1.1) and reaches loopback/RFC1918 HTTPS services (NAS/router admin UIs, dev servers with locally-trusted certs), bypassing the documented internal-address block on every redirect hop as well. Impact is bounded by the https-only rule (TLS must succeed) but the guard's explicit IPv4-mapped branch is dead code against real URL input.


**Fix:** Also handle the canonical hex form: match /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/ (and bare /^::ffff:[0-9a-f]{1,4}$/), convert the two hex groups to four octets, and run isPrivateIpv4 on the result - or normalize the host with a proper IP parser (net.isIP + manual expansion) before classification.


### `src/renderer/src/stores/tools.ts:155` — Approval/question responses target the live queue head instead of the request the dialog rendered — a settle race can approve an unseen tool call

*security*


respond() reads `get().approvalQueue[0]` at click time and ToolApprovalDialog.tsx calls respond(true[, 'conversation']) without passing the requestId it displayed. Main can settle the head request on its own (timeout/abort/stopAll -> push:approvalSettled -> settleApproval dequeues it) at any moment. Failure scenario: requests X and Y are queued (concurrent conversations / background agents share this queue); the user reads X's arguments and clicks 'Allow once' (or 'Allow for this conversation') just as X's settle push dequeues it — the click executes against Y, approving a possibly dangerous tool call (shell command, file write) whose arguments the user never saw, before React repaints the dialog with Y's content. respondQuestion() (line 187) has the same defect, delivering the typed answer to the wrong ask_user_question.


**Fix:** Change respond/respondQuestion to take the requestId the dialog rendered (respond(requestId, approved, scope)) and no-op (or just dequeue without answering) when it no longer matches approvalQueue[0]; pass pending.requestId from ToolApprovalDialog/UserQuestionDialog.


## LOW severity


### `src/main/index.ts:543` — Corrupt database / failed migration at boot exits silently in packaged builds

*bug*


openDatabase() correctly closes the driver and rethrows on a corrupt DB or failed migration, but the whenReady().catch handler only console.error's and calls app.exit(1). In a packaged Windows build there is no attached console, so the user double-clicks the app and nothing happens — no window, no dialog, no hint that uld.sqlite3 is corrupt or that a .pre-vN.bak recovery snapshot exists (database.ts deliberately leaves that snapshot behind on failure, but nothing ever tells the user about it). Combined with findings 2/3 this turns a recoverable migration failure into an app that appears permanently broken.


**Fix:** Before app.exit(1), show a user-visible error (dialog.showErrorBox) with the redacted message, the DB path, and — when a .pre-vN.bak snapshot exists next to the DB — a note that it can be restored by renaming it over uld.sqlite3.


### `src/main/providers/errors.ts:234` — Retry-After is dropped for 5xx/408 responses, defeating server-instructed backoff

*bug*


checkedFetch parses the Retry-After header for every non-2xx response (http.ts:103) and passes it to normalizeHttpError, but only the 429 branch stores retryAfterSec on the ProviderError; the 408 and >=500 branches discard it. computeDelayMs (retry.ts:27) then falls back to 0-500 ms full jitter. Failure scenario: provider returns 503 + 'Retry-After: 10' (common during incidents); withRetry retries after ~250 ms, hits 503 again, and exhausts both retries within a second instead of honoring the instructed wait -- contradicting the documented 'retry with backoff honoring Retry-After' contract.


**Fix:** Include `retryAfterSec` in the ProviderError options for the 408 and >=500 branches (it is already a parameter of normalizeHttpError); computeDelayMs already prefers it and caps it at 30 s.


### `src/main/providers/openai-oauth.ts:284` — logout() racing an in-flight token refresh resurrects the ChatGPT OAuth tokens after sign-out

*bug*


getAccessToken starts a single-flight doRefresh when the access token is near expiry, but logout() only deletes the DB row - it neither cancels nor invalidates the in-flight refresh. When the refresh HTTP call completes, doRefresh unconditionally calls this.persist(providerId, tokens, row), and ProvidersRepository.setOAuthRow is an upsert, so freshly rotated access+refresh tokens are re-inserted for a provider the user just signed out of; status() reports connected again. Failure scenario: a chat generation (or background agent/scheduled task) triggers a token refresh at the same moment the user clicks "Sign out" in Settings -> after the ~1s token roundtrip the encrypted session is silently restored on disk, defeating the sign-out. Security-adjacent: the user believes the ChatGPT session was removed.


**Fix:** Track invalidation: in logout(), delete the row AND record the providerId (e.g. bump a per-provider generation counter or delete the refreshInFlight entry plus set a tombstone). In doRefresh, after the refresh resolves, re-check this.deps.repo.getOAuthRow(providerId) (or the generation) and skip persist - returning/throwing an auth error - when the row was deleted mid-flight.


### `src/main/providers/openai-oauth.ts:223` — openExternal rejection during ChatGPT sign-in becomes an unhandled promise rejection and the login hangs for 5 minutes

*bug*


startLogin fires the browser open with `void this.deps.openExternal(...)`. The dep is wired to shell.openExternal (src/main/index.ts:403), which returns a promise that rejects when the OS fails to open the URL (broken default-browser association, restricted environments). The `void` discards the rejection: main has no process-level unhandledRejection handler (verified by grep), so Node emits an unhandled-rejection warning, and because neither resolve nor reject is called, the login promise just sits until the 5-minute LOGIN_TIMEOUT_MS fires - the user sees a stuck "signing in" state with no explanation.


**Fix:** Attach a catch that fails fast: this.deps.openExternal(url).catch((e) => reject(new ProviderError('unknown', 'Could not open the system browser for ChatGPT sign-in.', { retryable: false, cause: e }))) - the existing .finally(cleanup) then tears down the servers and timer immediately.


### `src/main/providers/anthropic.ts:299` — Anthropic in-stream error events discard the provider's error type/message and hardcode retryable:false

*bug*


When the Messages API emits a mid-stream error event (payload shape {type:'error', error:{type:'overloaded_error'|'api_error'|..., message}}), chatStream throws a fixed 'Anthropic reported a stream error.' with retryable:false. The actual error.type and error.message are dropped, so the user cannot distinguish a transient overload (Anthropic's documented 'overloaded_error', equivalent to HTTP 529 and worth retrying) from a permanent failure, and headless consumers (workflows, scheduled tasks) that branch on retryable treat overloads as fatal. Every HTTP-level error path in this codebase surfaces the redacted provider detail (normalizeHttpError); only this in-stream path loses it. Failure scenario: Anthropic overload mid-generation -> user sees a generic 'stream error' with no hint that simply retrying would work.


**Fix:** Extract err = (json as any).error; include redactSecrets(String(err?.message ?? ''), [ctx.apiKey]) and err?.type in the ProviderError message, and set retryable: err?.type === 'overloaded_error' || err?.type === 'api_error' (map rate-limit/overload types to code 'rate_limit'/'server' accordingly).


### `src/main/services/chat-service.ts:2168` — runMoaStream has no top-level error containment — a throw wedges the conversation until restart

*bug*


runStream, runResearchStream and runCompareStream contain failures (try/catch/finally with finalize + releaseStream), but runMoaStream has none. runAdvisors can throw before its internal try: the references array is built via preset.referenceModels.map(... this.moaLabel(ref)) at lines 1964-1971, and moaLabel does a synchronous DB read (db.providers.getById). If that read throws (DB error / teardown-time close), active.done rejects with no handler (unhandled rejection in main), releaseStream never runs — the streams/activeByConversation entries leak so every future send in that conversation throws 'A response is already streaming', and the placeholder stays status 'streaming' with a perpetual spinner (only fixed at next boot). runCompareStream has the finally but no catch, so it releases the slot but still leaves the placeholder wedged and rejects active.done.


**Fix:** Wrap runMoaStream's body (and runCompareStream's try body with a catch) in the same containment pattern as runStream: on unexpected throw, persist the placeholder as 'error' via a finalize-style update, emit the error event, and release the stream in a finally. Alternatively move the references-array construction (moaLabel calls) inside runAdvisors' existing try.


### `src/main/services/chat-service.ts:1264` — Compaction token estimate ignores replayed tool rounds, so auto-compaction never triggers for agentic conversations

*bug*


compact()'s threshold estimate sums only messageEstimateText (message content + attachment text). But buildHistory replays every assistant turn's tool calls plus their results (each capped at 4000 chars via truncateToolResultForReplay) onto the wire. In a work-mode conversation the replayed tool payload dominates: e.g. 30 tool calls x 4000-char results ~ 120k chars (~30k tokens) that the estimate counts as zero. With a 32k-context model and compactionEnabled, the estimate stays far below threshold while the real request already exceeds the context window, so the user gets hard context_length provider errors from the exact situation compaction exists to prevent.


**Fix:** Include replayed tool content in the estimate, e.g. in messageEstimateText (or a sibling used only for estimation) add for each toolCall: call.arguments.length + Math.min(call.result?.length ?? 0, REPLAY_TOOL_RESULT_MAX_CHARS).


### `src/main/services/chat-service.ts:1352` — generateHeadless builds a system prompt claiming tools are available but offers none on the wire

*bug*


runHeadless calls planTools(resolved) and feeds toolPlan.promptOpts into buildHistory, so when tools are enabled and the model supports them the system prompt includes toolsUsageSection ('you can call these tools: web_search, read_file, ...' — prompts.ts:237-238). But the adapter.chat request (line 1357) omits the tools parameter entirely, so the model cannot actually call anything. Telegram-bridge replies therefore come from a model that has been told it has tools it does not have — it may announce 'I'll search the web for that' or emit tool-call-shaped text instead of answering, degrading every headless conversation reply.


**Fix:** Pass empty promptOpts ({}) in runHeadless so no tools section is injected (or, if headless tool use is intended, pass toolPlan.adapterTools to adapter.chat and run the same bounded tool loop generateForWorkflow uses).


### `src/main/services/backup.ts:160` — Workflow import bypasses the strict workflowGraphSchema enforced at every other boundary

*bug*


workflowItemSchema validates the graph as z.object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) }).passthrough() and then casts to WorkflowGraph, while the IPC save path validates with the strict workflowGraphSchema (node id/kind/position/config shapes, 500-node / 2000-edge caps). A malformed or crafted backup (e.g. workflows: [{name:'x', graph:{nodes:[{}], edges:[]}}], or a graph with millions of node entries) imports successfully; opening it crashes/breaks the React Flow editor (missing position/id) and runWorkflow/topoOrder operates on nodes with undefined id/kind, and the size caps are bypassed entirely.


**Fix:** Use the shared workflowGraphSchema for the graph field in workflowItemSchema (import it from @shared/schemas), so invalid workflow entries are skipped and counted like every other malformed backup item.


### `src/main/services/mode-artifacts.ts:46` — uld-change body is truncated at any nested bare ``` line, corrupting proposed file content

*bug*


blockRegex ends the block at the first line matching ^```[ \t]*$. A proposed file whose content itself contains a fenced code block (e.g. a README.md with a ```js example) has its nested CLOSING fence (a bare ``` line) matched as the uld-change terminator: the extracted newContent silently loses everything from that point on, and the remainder of the file plus the real closing fence become stray message text (potentially mis-parsed as further blocks). Since the prompt (prompts.ts) demands 'the COMPLETE new file content' and gives no nested-fence escape rule, applying such a proposal writes a truncated file to disk.


**Fix:** Support CommonMark-style fence-length matching: capture the opening fence's backtick count (allow ````uld-change) and require the closing fence to have at least that many backticks; instruct models in prompts.ts to use a 4-backtick fence when the file content contains triple-backtick lines.


### `src/main/services/knowledge.ts:115` — Knowledge search silently degrades to zero-score garbage when the embeddings provider returns no query vector

*bug*


search() destructures the first vector and falls back to an empty Float32Array: `Float32Array.from(queryVector ?? [])`. If the provider returns an empty/short batch (rate-limit stub, misbehaving endpoint), cosineSimilarity computes 0 for every chunk (n=0, denom 0) and the method returns the first topK chunks in storage order as if they were relevant hits - feeding arbitrary unrelated context to the model with no error. addDocument (line 90-92) explicitly throws on an incomplete batch for exactly this reason; search does not.


**Fix:** Mirror addDocument's guard: if (!queryVector || queryVector.length === 0) throw new Error('The embeddings provider returned no vector for the query.') before scoring.


### `src/main/services/dreaming.ts:216` — Dream operations validated against a stale snapshot clobber memory edits made during the LLM call

*bug*


dreamNow snapshots db.memories.list() (line 155), then awaits this.deps.generate() - a network LLM call that can take from seconds to minutes - and apply() validates op ids against that stale snapshot only. A memory the user edits (or the memory-hook upserts from another conversation) while the call is in flight is then overwritten by an 'update' op derived from the pre-edit content, or removed by a 'delete' op that judged the pre-edit content obsolete - silently losing the user's newer text. The wipe-refusal check also uses the stale count.


**Fix:** Inside apply()'s transaction, re-read each target row and skip update/delete ops whose current updatedAt is newer than the snapshot's updatedAt for that id (count them as dropped), so concurrent edits always win over the stale consolidation.


### `src/main/tools/mcp/naming.ts:38` — Two MCP tools whose names differ only in sanitized characters collapse to the same id with no disambiguation

*bug*


namespaceMcpToolId sanitizes tool names via `replace(/[^A-Za-z0-9_-]/g, '_')` and only appends a disambiguating hash when the full id exceeds 64 chars. Two distinct tools from one server whose names differ only in characters that both sanitize to '_' (e.g. 'get.item' and 'get-item'→'get-item' no; but 'get.item' and 'get/item' both → 'get_item', or 'a b' and 'a:b') produce identical ids under the 64-char cap. In manager.connect, `this.reverse.set(toolId, …)` then overwrites the first tool's entry with the second's original name, and listToolDefinitions emits two ToolDefinitions with the same id/name. The model sees a duplicate function name, and every call to it dispatches through the reverse map to whichever tool was registered last — the first tool becomes unreachable and its calls silently invoke the other tool, exactly the misdispatch/permission-conflation the >64-char hash branch was added to prevent. Requires an MCP server exposing two names that sanitize alike.


**Fix:** Detect id collisions within a server's discovered tool set (e.g. track produced ids during connect and append shortHash(originalName) on any duplicate, regardless of length), rather than only disambiguating on the length cap.


### `src/main/ipc/register.ts:1290` — Workflow name has no length cap — the only handler input that bypasses zod limits

*bug*


asWorkflowInput hand-rolls validation instead of using a zod schema and accepts any non-empty string as the workflow name (every comparable field elsewhere is capped: conversation title 200, workspace name 200, scheduled-task title 120). Failure scenario: a renderer bug or scripted call passes a multi-megabyte name; it is persisted to the workflows table and then rendered in the sidebar Scheduled section, Home overview and workflows list on every load, bloating the DB row, the workflows:list/workflows:overview IPC payloads, and the React render.


**Fix:** Replace the hand-rolled check with a zod schema mirroring the rest of the file, e.g. z.object({ name: z.string().trim().min(1).max(200), graph: workflowGraphSchema, schedule: ..., scheduleEnabled: z.boolean().optional() }), keeping the existing everyMinutes clamp.


### `src/main/ipc/register.ts:1509` — agentPackImport parses the picked file's JSON outside try/catch, surfacing a raw SyntaxError

*bug*


backupImport wraps JSON.parse and converts failures to invalid('The selected file is not valid JSON.'), but agentPackImport calls JSON.parse(await readFile(...)) bare. Failure scenario: the user picks a non-JSON file in the agent-pack import dialog; JSON.parse throws SyntaxError, which toNormalizedError maps to code 'unknown' with the raw parser message ('Unexpected token ... is not valid JSON') shown in the error toast, instead of the friendly invalid_request message the sibling handler produces.


**Fix:** Mirror backupImport: parse inside try/catch and throw invalid('The selected file is not valid JSON.') on failure before running agentPackSchema.


### `src/main/code/git-service.ts:158` — openInEditor never works on Windows: execFile cannot spawn .cmd shims (VS Code/Cursor)

*bug*


On Windows, `code` and `cursor` are .cmd batch shims (e.g. C:\...\Microsoft VS Code\bin\code.cmd). child_process.execFile without shell:true cannot spawn .cmd files — verified on this machine: with code.cmd on PATH, execFile('code', ['--version']) fails with ENOENT. So every candidate fails, the loop exhausts, and the user always gets 'No supported editor command was found (tried VS Code, Cursor and Zed)' even with VS Code installed. The codeOpenInIde IPC and the post-worktree open flow (register.ts:1015-1020) are therefore dead features on Windows, the app's primary platform.


**Fix:** On win32, resolve the shim explicitly and spawn it via cmd.exe with argv separation, e.g. execFile('cmd.exe', ['/d', '/s', '/c', command, ...argv], { windowsHide: true }) — the editor name is a fixed allowlisted string and root travels as its own argv element, so no shell string interpolation of user data is introduced. (Do NOT use shell:true, which joins args unescaped.)


### `src/main/browser/session.ts:270` — computer 'key' action sends modifier combos without the modifiers field, so shortcuts silently no-op

*bug*


The 'key' action splits e.g. 'ctrl+a' and sends independent keyDown/keyUp events for each token with no `modifiers` array. Electron's webContents.sendInputEvent does not track modifier state across synthetic events — a combo only registers when the non-modifier key event carries modifiers: ['control'] etc. Result: when a vision model driving the computer tool sends key 'ctrl+a' (select all), 'ctrl+c', 'shift+Tab', etc., nothing happens on the page; the tool still replies "Action 'key' done" with a screenshot, so the model loops retrying a working-looking but dead control.


**Fix:** Parse leading tokens that are modifiers (ctrl/control, shift, alt, cmd/meta/super) into a modifiers: string[] array and send only the final key's keyDown/keyUp (plus a 'char' event for printable keys) with that modifiers array attached.


### `src/main/code/git-service.ts:107` — parsePorcelainStatus mis-parses worktree renames (' R'/' C'): orig-path record consumed as a status record

*bug*


The -z porcelain format emits a second NUL-separated ORIG_PATH record for renames/copies in EITHER column, but the parser only consumes it when X is 'R'/'C' (staged rename). A worktree rename — Y === 'R', produced e.g. by `mv a.txt b.txt && git add -N b.txt` (git >= 2.18) — leaves the orig-path record in the stream, and the next loop iteration parses the bare path 'a.txt' as a status record: x='a', y='.', path='xt', pushing garbage entries into both staged and unstaged lists shown in the commit bar (and offered to git add via the checkbox UI, which then fails).


**Fix:** Consume the extra record for renames/copies in either column: if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1. Add a ' R new\0old\0' case to the parsePorcelainStatus unit test.


### `src/main/index.ts:520` — Hidden browser-tool window defeats window-all-closed quit and macOS activate restore

*bug*


BrowserSession's hidden window persists after any browser/computer tool use (only cleanup() closes it). Because it is a normal BrowserWindow, 'window-all-closed' never fires while it exists: on Windows/Linux, a user who used the browser tool and then closes the main window expects the app to quit (that is what the handler encodes), but the process silently keeps running with the model's last browsed page alive in memory. On macOS, the 'activate' handler checks `BrowserWindow.getAllWindows().length === 0`, which is 1 due to the hidden window, so clicking the dock icon after closing the main window does not recreate it — this despite the file's own comment (lines 53-57) warning that getAllWindows must not be used because of this exact window.


**Fix:** Track lifecycle off the real main window instead of window counts: in the mainWindow 'closed' handler quit on non-darwin (or close browserSession so window-all-closed can fire), and change the 'activate' handler to `if (!mainWindow || mainWindow.isDestroyed()) createWindow()`.


### `src/shared/presets.build.ts:101` — Missing cache_read price encoded as $0, so cached input tokens are estimated as free instead of billed at the input rate

*bug*


priceOr maps an absent cost field to 0 whenever the model has ANY cost block: encodeModel(t[9]) stores 0 for models.dev entries with cost {input, output} but no cache_read (very common — the generated file is full of tuples ending '…,5,15,0]'). decodePricing then emits cachedInputPerMTok: 0 because the guard is t[9] >= 0, which defeats estimateCost's intended fallback `pricing.cachedInputPerMTok ?? pricing.inputPerMTok` (pricing.ts:99). Failure scenario: a preset provider (e.g. Fireworks/xAI) reports prompt_tokens_details.cached_tokens = 50,000 on a long conversation; MessageItem's estimate bills those 50k prompt tokens at $0.00 instead of the input rate, understating cost. This contradicts the file's own 'unknown ≠ free' rule, applied one level up for the whole cost block.


**Fix:** Encode the cache slot independently of hasCost: `typeof m.cost?.cache_read === 'number' ? m.cost.cache_read : -1`, so decodePricing omits cachedInputPerMTok for unknown cache pricing and estimateCost falls back to the input rate. Regenerate presets.generated.ts afterwards.


### `src/main/services/chat-service.ts:98` — Auto-routing ignores presetPricing, so preset-backed providers are always treated as unpriced

*bug*


pickAutoRouteProvider computes cost via findPricing(provider.type, provider.defaultModelId). For any preset-backed provider the type is 'openai-compatible', whose MODEL_PRICING table is deliberately empty, so cost() returns null even though presetPricing(provider.presetId, provider.defaultModelId) knows the price — the exact lookup MessageItem.tsx:285-287 already performs for display. Failure scenario: user has a cheap Groq preset provider and an Anthropic provider with autoRoutingPolicy 'lowest_cost' — Groq sorts last (Infinity) and is never picked; with autoRoutingMaxCostUsd set, every preset provider is excluded from routing outright.


**Fix:** Mirror the renderer's lookup: `const pricing = provider.presetId ? presetPricing(provider.presetId, provider.defaultModelId) : findPricing(provider.type, provider.defaultModelId)` (import presetPricing from '@shared/presets').


### `src/shared/schemas.ts:79` — Type-vs-schema drift: ProviderConfigInput.presetId permits null but providerConfigInputSchema rejects it

*bug*


types.ts:119 declares `presetId?: string | null` on ProviderConfigInput (and UldApi.providers.create takes ProviderConfigInput), but the zod schema is `z.string().trim().max(100).optional()` — passing null fails validation with invalid_request at runtime despite type-checking cleanly. The sibling contract already got this right: previewModelsSchema in register.ts:193 uses `.nullable().optional()` for the same field shape (PreviewModelsRequest.presetId?: string | null). The current renderer only avoids the trap by coercing (`presetId: presetId ?? undefined` in ProviderAddForm.tsx:116); any new caller that passes the type-legal null (e.g. spreading a ProviderConfig row where presetId is `string | null`) breaks at runtime.


**Fix:** Align the schema with the type: `presetId: z.string().trim().min(1).max(100).nullable().optional()` and treat null as undefined in the providersCreate handler (its existing `if (parsed.presetId)` already handles null correctly).


### `src/shared/tasklist.ts:31` — encodeTaskList breaks its own round-trip contract for task content containing newlines

*bug*


The file's contract is that encode/parse 'must agree byte-for-byte', but encodeTaskList embeds task content verbatim into one checklist line. The only producer (executor.ts runUpdateTaskList:1412) trims model-provided content but does not strip embedded newlines. Failure scenario: the model calls update_task_list with content 'Fix parser\nsee notes' and status 'in_progress' → the persisted item becomes '- [ ] Fix parser\nsee notes ⟵ in progress'; parseTaskList (used by WorkControls.tsx:70) matches only the first line, so the task renders as plain pending (in-progress marker lost) and 'see notes ⟵ in progress' is silently dropped as a non-checklist line.


**Fix:** Sanitize in encodeTaskList (single point that upholds the format): collapse newlines before emitting, e.g. `const text = task.content.replace(/\s*\n+\s*/g, ' ')` — same approach citations.ts escapeLinkText uses to keep titles from breaking markdown syntax.


### `src/main/services/chat-service.ts:633` — Stop is a no-op while a generation is in the PENDING reservation phase (un-cancellable OAuth token refresh locks the conversation)

*bug*


reserve() parks activeByConversation at the PENDING_STREAM sentinel until start() registers the real stream. stopConversation() looks the sentinel up in `streams`, gets undefined, and silently does nothing — there is no AbortController yet to abort. The pre-registration phase includes resolveTarget's network work: OpenAiOAuthManager.getAccessToken → tokenRequest(), whose fetch has no signal and no timeout of its own. If the OpenAI token endpoint stalls (accepted connection, no response), the send hangs for up to undici's ~5-minute headers timeout during which the conversation is locked — every new send throws 'A response is already streaming — stop it first' while the Stop action itself does nothing.


**Fix:** Create the AbortController before resolveTarget and store it with the reservation (e.g. keep a Map<conversationId, AbortController> for PENDING sends that stopConversation can abort), and thread a bounded signal (AbortSignal.timeout) into OpenAiOAuthManager.tokenRequest's fetch.


### `src/main/workflows/engine.ts:127` — http_request node buffers the entire response body in memory before truncating to 256 KB

*performance*


runHttp does `(await res.text()).slice(0, HTTP_MAX_BYTES)` — the full body is downloaded and held as a string in the main process before the cap is applied, so HTTP_MAX_BYTES caps only what reaches the next node, not memory. Scenario: a workflow's http_request URL resolves to a large payload (a file download link, an unpaginated API dump, or a {{input}}-interpolated URL the model produced) — a multi-hundred-MB/GB body is buffered in main-process memory within the 15 s timeout window, causing severe memory pressure or an OOM crash of the main process (taking down all in-flight streams and unsaved run state).


**Fix:** Stream the body and stop at the cap: read `res.body` with a reader (or `for await` over the stream), accumulate until HTTP_MAX_BYTES bytes, then `controller.abort()`/cancel the stream and return the truncated text.


### `src/main/db/repositories/conversations.ts:162` — Sidebar list snippet subquery fetches the full content of the latest message per conversation, truncated to 100 chars in JS

*performance*


The list() snippet subquery selects m2.content whole; toSnippet() then slices it to 100 characters in JS. With the sidebar's limit of 300 conversations, a single list call (initial load, mode switch, every keystroke while searching) copies up to 300 complete message bodies across the WASM boundary — a conversation ending in a deep-research report or large pasted content is 50-500 KB each, so a load can marshal tens of MB to produce ~30 KB of snippets, synchronously on the main process.


**Fix:** Truncate in SQL: SELECT substr(m2.content, 1, 400) (over-fetch slightly so the JS whitespace-collapse still yields 100 visible chars). Same pattern the workflows repo already uses (substr(output, 1, ?)).


### `src/main/tools/registry.ts:68` — listDefinitions loads every enabled skill's full body just to test whether the count is zero, and runs on every tool call

*performance*


listDefinitions() calls this.db.skills.listEnabled() — SELECT * including the content column (up to 200 KB per skill; agent-pack import allows 500 skills) — solely for `.length === 0` to hide use_skill. listDefinitions also re-reads tool_settings, all settings rows, and custom_tools. It is invoked on the tool-loop hot path: executor.execute -> registry.resolveForCall for every tool call, plus getById/getPermission, plus 2-3 times per generation from planTools/buildHistory. In a 40-round agent run with several calls per round, that is 100+ full-skill-library reads per generation, all synchronous in the main process, when a COUNT(1) suffices.


**Fix:** Add a skills.countEnabled() repository method (SELECT COUNT(*) FROM skills WHERE enabled = 1) and use it here; optionally also give listEnabled a metadata-only variant for consumers that don't need content.


### `src/main/providers/redact.ts:63` — maskKey discloses 7 of 8 characters for short prefixed keys

*security*


The masked preview switches to 'first 3 + last 4' at k.length >= 8 whenever the key has a letters+dash prefix. For an 8-character key like 'sk-abcde' the preview is 'sk-…bcde' -- only one character is hidden, making the 'non-reversible preview' that crosses IPC to the renderer trivially brute-forceable. Short bearer tokens are realistic for local gateways/proxies configured via the openai-compatible preset. Keys of length 9-11 similarly reveal 7 of 9-11 characters.


**Fix:** Require a larger minimum before revealing prefix + last 4 (e.g. treat k.length < 12 as short and return only `…${k.slice(-2)}`), or scale revealed characters to at most ~1/3 of the key length.


### `src/main/keys/keystore.ts:79` — reencryptInsecureKeys only upgrades provider keys; MCP headers, IM bot tokens and custom-tool secrets stay plaintext-on-disk and encryptionAvailable() over-reports

*security*


The startup upgrade pass iterates db.providers.list() only, but keystore.encryptKey is also used for MCP server headers (src/main/tools/mcp/manager.ts:222), IM bridge tokens (src/main/im/manager.ts:138) and custom tool secret headers (register.ts:1083 / index.ts:401). If any of those were stored during a session where safeStorage was unavailable (the documented Linux fallback), they keep the 'insecure:' base64-plaintext form on disk indefinitely — reencryptInsecureKeys never sees them, and because no provider row is insecure it also does NOT set insecureFallbackUsed, so AppInfo.encryptionAvailable reports true (honest-reporting promise in this file's header broken) until the first decryptKey() of such a row flips the flag mid-session. Concrete scenario: Linux user without a secret service adds a Telegram bot token; later installs gnome-keyring — provider keys get upgraded, the bot token stays effectively plaintext in the DB while Settings claims OS encryption is active.


**Fix:** Extend reencryptInsecureKeys to enumerate every table that stores keystore ciphertexts (MCP server header ciphers, IM account tokens, custom tool secret headers) and upgrade or count them the same way, so both the re-encryption and the insecureFallbackUsed flag reflect all secrets, not just provider keys.


### `src/main/im/manager.ts:111` — Telegram pairing code is brute-forceable: 6 digits, no attempt limit, no expiry

*security*


While the bridge is enabled but unpaired, handleInbound compares any stranger's message against the 6-digit pairing code with no rate limiting, attempt counter, or expiry — the code stays valid indefinitely (e.g. a user enables the bridge, gets distracted, never pairs). An attacker who discovers the bot's username can flood it with candidate codes; at the bridge's sequential processing rate (~a few messages/sec) the ~500k expected attempts are feasible over a day or two, after which the attacker's chat id is pinned as the sole authorized chat, giving them full conversational access to the bound conversation (its history via 'summarize our conversation', memories, and the user's API credits) with the real owner locked out.


**Fix:** Add a failed-attempt counter that invalidates the code (regenerate and require the user to re-read it in the app) after a small number of wrong guesses (e.g. 5), and/or expire the pairing code after a short TTL. Optionally lengthen the code (it is machine-copied from the UI, so 8-10 alphanumerics costs nothing).
