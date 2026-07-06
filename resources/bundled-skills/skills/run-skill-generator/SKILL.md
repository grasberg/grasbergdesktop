---
name: run-skill-generator
description: Teach /run and /verify how to build and launch your project by creating a per-project run skill with a driver script.
---

Your job is to produce a **skill** at `<unit>/.grasberg/skills/run-<unit-name>/`
that lets a future agent build, launch, and **drive** this project from
a clean machine.

The skill has two parts that live together:

```
<unit>/.grasberg/skills/run-<unit-name>/
  SKILL.md      ← agent-facing instructions — SHORT. Points at the driver.
  driver.mjs    ← (or driver.py, smoke.sh, … — or none: web apps use
                   chromium-cli off-the-shelf, and the heredoc in
                   SKILL.md is the script)
```

That almost always means **writing code**, not just prose. If the app
has any interactive surface (GUI, TUI, long-running server, REPL), the
future agent needs a programmatic way to poke it. A markdown file by
itself cannot click a button — but sometimes the button-clicker
already exists: for web apps it's `chromium-cli`, for servers it's
`curl`. You build (or script) that harness now, commit it alongside
the skill, and the `SKILL.md` documents how to use it.

## Definition of done

You are done when **all** of these are true:

1. **You launched the app in this container and interacted with it** —
   not its test suite, the actual running app. For anything with a GUI,
   that means you have a screenshot file on disk that you took.
2. **The interaction harness is committed** next to the skill. A driver
   script, a REPL wrapper, a smoke test, or the `chromium-cli` heredoc
   inline in `SKILL.md` — whatever you used to drive the app in step 1.
   (Graduated into `scripts/`/`e2e/`? — fine, point at it. Web app with
   `chromium-cli` off-the-shelf? — the inline script is the harness; no
   separate file.)
3. **The `SKILL.md` documents the harness** as the primary agent path —
   the section a future agent reads first is "run this driver / pipe
   these commands to `chromium-cli`," not "run `npm start` and a window
   opens."
4. **Every code block in `SKILL.md` is a command you ran that worked.**
   This session. This container. Not from the README, not inferred.

If you're about to write the skill and you don't have (1), **stop.** You
are about to paraphrase existing docs. That document already exists —
it's called the README, and the whole reason you're here is that it
wasn't enough.

## The deliverables are code AND docs

Typical output is a skill directory containing both:

```
<unit>/.grasberg/skills/run-<unit>/
  SKILL.md         ← SHORT. Points at the driver. Has the frontmatter
                     that lets the assistant auto-load it when someone asks
                     to "run <unit>" or "screenshot <unit>".
  driver.mjs       ← (or driver.py, smoke.sh, … — or none: web apps
                     use chromium-cli off-the-shelf, and the heredoc
                     in SKILL.md is the script)
```

The driver lives **inside the skill directory** by default. They are a
pair — the skill's instructions and the code that implements them. A
driver that lives here is allowed to be a bit messier than production
code; it's agent tooling, not product surface.

**Graduation:** if the driver grows into something the project's own
test suite wants to reuse — shared launch helpers, a real e2e harness —
move it to `scripts/` or `e2e/` and update `SKILL.md` to reference the
new path. The skill stays; the driver finds a better home.

The exact shape depends on the project, but the principle is constant:
**the driver is the deliverable.** The `SKILL.md` is its man page. For
a web app, the driver already exists — `chromium-cli`
([examples/playwright.md](examples/playwright.md)) — and the skill is
the script that runs it. For a desktop app
([examples/electron.md](examples/electron.md)), the driver is a custom
REPL under tmux that exposes `launch`/`ss`/`click`/`eval`. For a server,
the driver is `curl`. Whatever shape it takes, without something that
reaches into the running app, the skill is a description of a window
nobody can touch.

## Where the skill goes

The skill lives at `<unit>/.grasberg/skills/run-<unit-name>/`, where
`<unit>` is the directory for **one deployable thing** — an app, a
service, a library.

Grasberg **natively discovers** skills from nested `.grasberg/skills/`
directories: an agent working anywhere inside `<unit>` will see
`/run-<unit-name>` as an available skill, and it auto-loads when the
request matches its description (e.g. "run the desktop app," "take a
screenshot of billing").

- **Single-project repo:** `.grasberg/skills/run-<repo-name>/` at repo root.
- **Large repo with many apps:** one per app, colocated —
  `apps/billing/.grasberg/skills/run-billing/`,
  `apps/desktop/.grasberg/skills/run-desktop/`.
- **App with multiple binaries:** still **one** skill at the app's
  root with a section per binary. They share setup. Start from the
  closest single-binary example and add a `## Run: <name>` section
  per binary.

If you're not sure where the unit boundary is, **ask the user.**

Slugify the directory name: lowercase, dashes for spaces, no slashes
(`run-billing-api`, not `run-billing/api`). The directory name and
the frontmatter `name:` should match — that's the slash command.

## Process

### 0. Find any existing skill about running this app

List the project's skills with their descriptions (same probe `/run`
uses — users name these variously, so match on description, not name):

```bash
d=$PWD; while :; do
  grep -Hm1 '^description:' "$d"/.grasberg/skills/*/SKILL.md 2>/dev/null
  [ -e "$d/.git" ] || [ "$d" = / ] && break
  d=$(dirname "$d")
done
```

If one is about launching/driving this app — whatever it's named —
**refine, don't rewrite**: verify its claims, fix what's wrong, add
what's missing, preserve what works. Re-run the driver if there is
one. Keep its existing name.

(Also check for a legacy `.grasberg/run.md` — earlier versions of this
tool produced those. If you find one, migrate it: the body becomes
the skill's `SKILL.md` content, any referenced scripts move into the
skill dir, and delete the old file.)

If none exists, decide where to create it (see above) and continue.

### 1. Discover — and treat every claim as disprovable

Figure out what you're authoring for:

- Manifest right here (`package.json`, `go.mod`, `pyproject.toml`…) and
  it's one self-contained thing → this is the unit.
- Looks like a mega-repo root (`apps/`, `packages/`, `services/`) →
  **ask which one.** List candidates, let them pick, `cd` there.
- Genuinely ambiguous → ask.

Survey the usual places: `README.md`, `package.json` scripts,
`Dockerfile`, `Makefile`, `.github/workflows/`, `CONTRIBUTING.md`. CI
configs are often more accurate than READMEs.

**Every claim in existing docs is a hypothesis.** Especially the
negative ones:

| When docs say… | What you do |
|---|---|
| "Requires macOS/Windows" | Launch it on Linux anyway. Apps rarely refuse to start — they crash on a missing `.so`, which `apt-get` fixes. Native modules for *your host's* keychain/notifications may no-op; the core usually runs. |
| "Requires a GPU" | Try software rendering. Electron/Chrome fall back with `--disable-gpu`. |
| "Requires a paid account / feature flag" | The gate is code you can read. Find it (env var? build define? SSR-embedded JSON?) and patch it for your local run. Document the patch. |
| "Run `npm start`" | That's the human path (spawns a window, waits forever). Find or build the *programmatic* path — `electron-forge start` to build then launch via Playwright, or equivalent. |

"Not supported on Linux" in a README written by a macOS developer
means "I never tried." You're about to try. **If you give up here, the
skill you write is the README with extra steps.**

### 2. Execute — and BUILD the harness you need

You're in a headless Linux container. The app is going to fight you.
That fight is the content of the skill.

Keep a running `NOTES.md` as you go. Every error → every fix → every
command that finally worked. This scratchpad becomes the
Troubleshooting section.

**Work up to a real interaction:**

- **Install + build.** When something's missing, note the exact
  `apt-get` / `npm install` that fixed it.
- **Launch the app.** Not the test suite — the app. A desktop GUI
  (Electron, native) needs `xvfb-run` and a handful of `lib*`
  packages; a web app driven by `chromium-cli` runs headless and
  needs neither. Launch timeouts and cryptic crashes are normal at
  this stage. Read the stack trace, install the missing thing, try
  again.
- **Build a harness to drive it.** You need a handle on the running
  app that lets you send input and observe output programmatically.
  The shape depends on the project (see table below).

  **Cover the layer(s) PRs actually touch.** A tmux driver that pokes
  the CLI's user surface is the right handle for UI changes — and the
  wrong one for a PR that touches one internal function. For the
  latter an agent wants `NODE_ENV=test bun run script.ts` (or
  equivalent): import the function, call it, observe. If most PRs
  here touch internals, that direct-invocation path is the driver's
  main entry point, and the tmux launch is secondary. Look at recent
  merged PRs: what layer do they touch? Cover that.

  For a **web** app, `chromium-cli` is the driver — you script it,
  you don't write it (see [examples/playwright.md](examples/playwright.md)).
  For a **desktop** GUI (Electron), write a REPL driver (stdin
  commands → click/type/screenshot), run it inside tmux, and use
  `send-keys` / `capture-pane`. You will iterate on that driver — it
  starts minimal (`launch`, `ss`, `quit`) and grows whatever commands
  you need to reach the interesting part of the app.
- **Do one real user flow end-to-end.** Click the button. Fill the
  form. See the result in the DOM. Take a screenshot. **Actually look
  at the screenshot.** If it's blank or showing an error page, you're
  not done.
- **Then run the tests.** Unit tests are a sanity check, not the main
  event.
- **Stop cleanly.**

**Obstacles are content.** You will hit weird ones — coordinate systems
that don't line up, APIs that return empty on this Electron version,
feature gates that hide the thing you need to test. Each of these gets
a bullet in Gotchas and (often) a helper in your driver. The gold
standard is a Gotchas section full of things nobody could have guessed.

**The driver script gets committed alongside the skill.** It is not
scaffolding. It is the way future agents (and humans) will drive this
app. It defaults to living inside the skill directory (for a web app
using `chromium-cli`, that means inline in `SKILL.md` — the heredoc
is the script). If it outgrows that — if the project's real test
suite wants to import from it — move it to `scripts/` or `e2e/` and
update `SKILL.md` to point there.

### 3. Write SKILL.md

Short. Point at the driver. Use [template.md](template.md) as the
starting structure — it has the frontmatter shape.

**The frontmatter matters.** The `name:` becomes the slash command
(`/run-billing`). The `description:` is what the assistant scans to decide
whether to auto-load this skill — put the **verbs an agent would
actually type** in it: "run," "start," "build," "test," "screenshot."
Generic descriptions ("helpful utilities for billing") won't match.

Body structure:

1. One-paragraph intro: what this app is, how it's driven —
   `<driver-path>` under xvfb/tmux for desktop, `chromium-cli` for
   web, `curl` for a server.
2. **Prerequisites** — the exact `apt-get install` line you ran.
3. **Build** — the exact commands, in order. Include any patches you
   had to apply (feature gates, config overrides) with the exact `sed`
   or edit.
4. **Run (agent path)** — FIRST. How to launch the driver, what
   commands it accepts, where screenshots land. If it's a REPL, show
   the tmux wrapping. This is the section the next agent will actually
   use.
5. **Run (human path)** — SECOND, if different. `npm start` → window
   opens → Ctrl-C. Brief. Note that it's useless headless.
6. **Gotchas** — the battle scars. The things that look like they
   should work but don't, and the workaround. If this section is
   generic, you didn't fight hard enough.
7. **Troubleshooting** — symptom → fix. Only errors you actually hit.

Keep it **verified** (you ran it), **prescriptive** (one path, not
options), **honest** (flaky? slow? say so).

**Paths in SKILL.md are relative to `<unit>/`,** not to the skill
directory. State this at the top if there's any ambiguity. When the
driver lives inside the skill, its path from `<unit>` is
`.grasberg/skills/run-<unit-name>/driver.mjs` — it's long, but explicit.

### 4. Verify

Fresh shell, `cd` into the unit, follow the skill's `SKILL.md`
line-by-line without deviating. Any improvisation = a gap. Fix it.

## Project-type patterns

Pick a starting shape for your driver. These examples are shared with
the `/run` skill (same per-project-type patterns are used as the
fallback when no project-specific run skill exists) — if you're
authoring a new one, the example is your starting template.

| Project type | Driver shape | Example |
|---|---|---|
| Web server / API | Background-launch + `curl`-based smoke script | [examples/server.md](examples/server.md) |
| CLI tool | Representative-args smoke script, check exit codes + output | [examples/cli.md](examples/cli.md) |
| TUI / interactive terminal | tmux wrapper: `send-keys` / `capture-pane` | [examples/tui.md](examples/tui.md) |
| Electron / desktop GUI | Playwright `_electron` REPL driver under xvfb, screenshots, tmux-wrapped | [examples/electron.md](examples/electron.md) |
| Browser-driven | dev server + `chromium-cli` script | [examples/playwright.md](examples/playwright.md) |
| Library / SDK | Import-and-call smoke script | [examples/library.md](examples/library.md) |

For a web app, start from [examples/playwright.md](examples/playwright.md)
— drive it with `chromium-cli`, no custom driver needed. For a
desktop app, start from [examples/electron.md](examples/electron.md)
— it has the full `_electron` REPL driver skeleton, the tmux wrapping,
and the catalog of obstacles you'll hit.

## What to include

- **Prerequisites** — OS packages, runtimes, tools. Ubuntu `apt-get`
  lines. The exact ones.
- **Setup** — install deps, configure, any patches.
- **Build** — compile/bundle.
- **Run (agent path)** — the driver. Commands. Screenshot location.
- **Direct invocation** — if callable: how to import and run internal
  code without the full app. The env var / flag that bypasses init
  guards. Many PRs need only this.
- **Run (human path)** — if meaningfully different.
- **Test** — the test suite command.
- **Gotchas** — non-obvious traps you hit.
- **Troubleshooting** — error → fix.
- **The driver itself** — committed in the skill dir (or graduated
  to `scripts/`/`e2e/`), or inline in `SKILL.md` for `chromium-cli`
  web apps; referenced from `SKILL.md` either way.

## What to leave out

- **Anything you didn't run.** If the README says `yarn start:prod` and
  you never ran it, it's not in the skill. Full stop.
- **Documented happy paths for platforms you're not on.** You're in a
  Linux container. A macOS-only section you can't verify is
  speculation. Mention it exists; don't elaborate.
- **Exhaustive options.** One working path.
- **Architecture prose.** That's other docs.
- **Generic troubleshooting.** "If the build fails, check your Node
  version" — useless. Only include errors you actually hit and fixed.

## Red flags — you are about to ship the wrong thing

Stop and reconsider if:

- **You haven't taken a screenshot** of a GUI app. You didn't run it.
- **Your skill has no driver/smoke script** to point at, and the app
  is interactive. The next agent has no way to drive it. (Web app
  using `chromium-cli`? — the heredoc in `SKILL.md` is the driver;
  no separate file needed.)
- **Your skill reads like the README.** Same structure, same
  commands, same caveats. You paraphrased.
- **Your Troubleshooting section is generic.** Real execution produces
  specific, weird errors. Generic errors = you didn't execute.
- **You wrote "not supported on this platform"** without trying to
  launch it. The README author was on a Mac. You are not. Try.
- **Everything worked first try.** Either this project is trivially
  simple, or you ran the test suite and called it done.


---

# Appendices

The reference files mentioned in this skill are included below.


---

## Appendix: template.md

---
name: run-<unit-name>
description: Build, run, and drive <unit-name>. Use when asked to start <unit-name>, run its tests, build it, take a screenshot of its UI, or interact with the running app.
---

<One-sentence description: what this is and how an agent drives it.
Name the handle here — "drive it via
`.grasberg/skills/run-<unit-name>/driver.mjs` under xvfb" for a desktop
app, or "start the dev server then drive it via `chromium-cli`" for a
web app — so an agent knows where to look first.>

<If the unit isn't at repo root:>
All paths below are relative to `<unit-dir>/`.

## Prerequisites

<System-level requirements. The exact `apt-get install` line you ran —
not a generic list, the one that actually worked. Target Ubuntu.>

```bash
sudo apt-get update
sudo apt-get install -y <packages-you-actually-installed>
```

<Runtime versions if they matter:>

```bash
# Example: Node 20 via nvm, Python 3.12 via uv, etc.
```

## Setup

<One-time setup after clone: install deps, configure, apply any
patches (feature-gate overrides, config stubs) with the exact command.>

```bash
<commands>
```

<Env vars — required vs optional, with sensible defaults:>

```bash
export FOO_API_KEY=...   # required — get from <where>
export BAR_MODE=dev      # optional — default is prod
```

## Build

<Skip if no separate build step. Otherwise the exact command:>

```bash
<command>
```

## Run (agent path)

<This is the section a future agent actually uses. If you built a
driver/REPL/smoke script, this documents how to launch it and what it
does. If the app is simple enough that `curl` or a one-liner suffices,
that one-liner goes here.>

```bash
<launch-the-driver-or-smoke-script>
```

<For REPL-style drivers, show the tmux wrapping. Poll for a ready marker
between send-keys and capture-pane — faster than a fixed sleep and fails
loudly instead of capturing a half-rendered screen:>

```bash
tmux new-session -d -s app -x 200 -y 50
tmux send-keys -t app '<launch command>' Enter
timeout 30 bash -c 'until tmux capture-pane -t app -p | grep -q "<ready-marker>"; do sleep 0.2; done'
tmux send-keys -t app '<first driver command>' Enter
tmux capture-pane -t app -p
```

<Where artifacts land (screenshots, logs) — absolute paths:>

Screenshots → `/tmp/shots/`. Logs → `/tmp/<app>.log`.

<If the driver has commands, a table:>

| command | what it does |
|---|---|
| `<cmd>` | <description> |

## Run (human path)

<If meaningfully different from the agent path. Brief — agents won't
use this, humans can figure it out.>

```bash
<command>   # → <what happens>. <how to stop>.
```

## Test

```bash
<command>
```

<Expected result — "N suites pass", or specific known-flaky tests.>

---

<Optional sections below — include only if relevant and only with
content you actually hit, not generic advice.>

## Gotchas

<Non-obvious traps. The things that look like they should work but
don't, with the workaround. If this section is generic, delete it.>

- **<specific thing>** — <why it breaks> → <what to do instead>

## Troubleshooting

<Symptom → fix. Only errors you actually encountered.>

- **<exact error message or symptom>**: <cause>. <fix>.

<!---

NOTE ON THE FRONTMATTER ABOVE:
- Replace <unit-name> in both `name:` and `description:`. The `name:`
  becomes the slash command (/run-<unit-name>) and must match the
  directory name.
- The `description:` is what the assistant scans to decide whether to load this
  skill automatically. Keep the verbs — "start," "run," "build," "test,"
  "screenshot" — they're what an asking agent will actually type.

NOTE ON THE DRIVER:
- If you wrote a driver script, it lives in this same directory (next
  to this file) by default. Reference it from the Run section.
- For a web app there's usually no driver file — the `chromium-cli`
  heredoc in the Run section is the harness.
- If the driver grows into something the project's test suite wants —
  shared launch helpers, a real e2e harness — move it to scripts/ or
  e2e/ in the unit, and update the paths here. The skill stays put.

Delete everything from `---` above onwards before committing. --->

---

## Appendix: examples/cli.md

# Example: CLI tool

CLIs are the simplest case — there's usually no background process to
manage, no ports, no lifecycle. The skill focuses on **installation**,
**representative invocations**, and **testing**.

## What matters

- **How to get the binary on `PATH`.** Installed globally? Run via
  `npx`/`uv run`? Built to `./target/release/foo`? Be explicit.
- **Two or three example invocations** that cover the main use cases.
  Include expected output so a reader can tell it worked.
- **Exit codes** if they're meaningful (e.g. linter returns 1 on findings).
- **Stdin behavior** if the tool reads from stdin.

## Example snippet

> ---
> name: run-mytool
> description: Build, install, and run mytool. Use when asked to run mytool, test it, or verify it's installed correctly.
> ---
>
> ## Setup
>
> ```bash
> pip install -e .
> ```
>
> This puts `mytool` on PATH. Verify:
>
> ```bash
> mytool --version
> # → mytool 0.3.1
> ```
>
> ## Run
>
> Process a single file:
>
> ```bash
> mytool process input.json
> # → Processed 42 records, wrote output.json
> ```
>
> Read from stdin, write to stdout:
>
> ```bash
> cat input.json | mytool process -
> ```
>
> Lint a directory (exits non-zero on problems):
>
> ```bash
> mytool lint ./src
> echo $?  # 0 if clean, 1 if issues found
> ```
>
> ## Test
>
> ```bash
> pytest
> ```

## Keep it short

A CLI's run skill can be very compact. Don't pad it with every flag —
the `--help` output covers that. Just show enough that an agent can
(a) build it, (b) confirm it works, (c) run the tests.

---

## Appendix: examples/server.md

# Example: Web server / API

The distinguishing concern for servers is **lifecycle**: an agent needs to
start the server in the background, verify it's up, interact with it, then
cleanly shut it down. A foreground `npm start` that blocks the shell is
useless to an agent.

## Structure to follow

A good server run skill has:

1. **Prerequisites & setup** — same as any project.
2. **Run** — the background-launch pattern (below), not a blocking command.
3. **Verify** — a `curl` or similar that confirms the server is actually up.
4. **Stop** — how to cleanly terminate the background process.

If the background-launch + readiness-poll + smoke-curl sequence is more
than a couple of lines, put it in a `smoke.sh` inside the skill directory
and have `SKILL.md` say "run the smoke script." One command, exit code
tells you if the server is healthy.

## Background-launch pattern

Don't write:

> ```bash
> npm start
> ```

That blocks. Instead, show how to launch in the background, wait for
readiness, and find the PID later:

> ```bash
> npm start &> /tmp/server.log &
> SERVER_PID=$!
>
> # Wait for the server to come up (adjust timeout/port as needed)
> for i in {1..30}; do
>   curl -sf http://localhost:3000/health > /dev/null && break
>   sleep 1
> done
> ```

Then the verification step:

> ```bash
> curl http://localhost:3000/health
> # → {"status":"ok"}
> ```

And stopping:

> ```bash
> kill $SERVER_PID
> # or, if you've lost the PID:
> pkill -f "node.*server.js"
> ```

## Details worth documenting

- **Which port.** Make it explicit and say how to override it (`PORT=4000 npm start`).
- **What "ready" looks like.** A specific log line or a health endpoint to hit.
- **Required env vars.** Database URL, API keys, etc. — with a template `.env`
  if the list is long.
- **Hot reload vs production mode.** If they differ meaningfully, say which
  to use and when.
- **Dependent services.** If the server needs Redis/Postgres/etc., either
  point at a docker-compose that brings them up, or include the `docker run`
  command directly.

## Example snippet

Here's what a Run section for a typical Node API might look like:

> ## Run
>
> Start the dev server in the background:
>
> ```bash
> npm run dev &> /tmp/api.log &
> ```
>
> The server listens on port 3000. Wait for it to be ready, then verify:
>
> ```bash
> for i in {1..20}; do
>   curl -sf http://localhost:3000/health && break
>   sleep 0.5
> done
> curl http://localhost:3000/health
> # → {"status":"ok","version":"1.2.3"}
> ```
>
> Logs are at `/tmp/api.log`. Stop with:
>
> ```bash
> pkill -f "tsx watch src/index.ts"
> ```
>
> ### Environment
>
> | Variable | Required | Default | Notes |
> |---|---|---|---|
> | `DATABASE_URL` | Yes | — | Postgres connection string |
> | `PORT` | No | `3000` | |
> | `LOG_LEVEL` | No | `info` | `debug` / `info` / `warn` / `error` |

---

## Appendix: examples/tui.md

# Example: TUI / interactive terminal app

Interactive terminal apps (text editors, REPLs, curses-based UIs) can't
be driven directly by an agent's bash tool — they take over the terminal.
The skill must show how to wrap them in `tmux` so the agent can send
input, capture output, and take screenshots.

## The tmux pattern

This is the standard approach:

1. Start the TUI inside a detached tmux session
2. Send keystrokes with `tmux send-keys`
3. Read screen contents with `tmux capture-pane`
4. Clean up with `tmux kill-session`

The skill's `SKILL.md` should present this as the primary way to drive
the app. A small `driver.sh` that wraps the launch+attach sequence can
live in the skill directory, but for most TUIs the raw tmux commands in
the skill body are enough.

## Example snippet

> ## Run (interactive, for agents)
>
> Start the TUI inside tmux:
>
> ```bash
> tmux new-session -d -s app -x 120 -y 40 './myapp'
> ```
>
> Poll until the ready marker appears (faster + more reliable than a fixed sleep —
> returns the instant the app is up, fails loudly if it isn't):
>
> ```bash
> timeout 10 bash -c 'until tmux capture-pane -t app -p | grep -q "Ready"; do sleep 0.2; done'
> tmux capture-pane -t app -p
> ```
>
> Send input (this example navigates to the Settings screen and toggles
> an option):
>
> ```bash
> tmux send-keys -t app 's'
> timeout 5 bash -c 'until tmux capture-pane -t app -p | grep -q "Settings"; do sleep 0.2; done'
> tmux send-keys -t app 'Down' 'Down' 'Space'  # navigate + toggle
> timeout 5 bash -c 'until tmux capture-pane -t app -p | grep -qF "[x]"; do sleep 0.2; done'
> tmux capture-pane -t app -p
> ```
>
> If you find yourself writing more than a couple of these poll lines, pull
> them into a `wait_for()` helper in a `driver.sh` next to the skill.
>
> Quit:
>
> ```bash
> tmux send-keys -t app 'q'
> tmux kill-session -t app 2>/dev/null || true
> ```
>
> ### Key reference
>
> | Key | Action |
> |---|---|
> | `j` / `k` or `Down` / `Up` | Navigate list |
> | `Enter` | Select |
> | `s` | Settings |
> | `q` | Quit |

## Details worth documenting

- **Terminal size.** Some TUIs break or hide content at small widths.
  Specify a known-good size in the `tmux new-session -x -y` args.
- **Startup time.** Poll for a ready marker (`until tmux capture-pane | grep -q X`)
  rather than a fixed `sleep N` — returns the instant the app is up, and fails
  usefully when it never does. Say what string means ready.
- **Keybinding reference.** A table of the main keys. This is the "API"
  of a TUI — an agent needs it to drive the app.
- **Exit cleanly.** Show the quit keystroke *and* `tmux kill-session` as
  a fallback.
- **Color/unicode quirks.** If `capture-pane` output is hard to read,
  note flags that help (`-e` for escape sequences, `-J` to join wrapped
  lines).

## Also document the direct invocation

For a human running the app interactively, tmux is overkill. Include
the one-liner too:

> ## Run (direct, for humans)
>
> ```bash
> ./myapp
> ```
>
> Press `q` to quit.

---

## Appendix: examples/electron.md

# Example: Electron / desktop GUI app

Electron apps have a window. A future agent in a headless container
can't see a window. So your deliverable here is not a markdown file
that says "`npm start` opens a window" — it's a **driver script** that
launches the app under xvfb, exposes a REPL of commands (click, type,
screenshot), and lets an agent poke the UI by sending lines of text.

The skill's `SKILL.md` then becomes a short manual for that driver.

## What you're building

```
apps/desktop/
  .grasberg/skills/run-desktop/
    SKILL.md               ← short. "run the driver, here are the commands"
    driver.mjs             ← REPL: stdin commands → Playwright actions
```

The driver IS the product. Without it, the skill describes a GUI an
agent can never touch.

**Graduation path:** if the driver grows launch helpers the project's
real e2e suite wants to share, move it to `e2e-playwright/driver.mjs`
(or `scripts/drive.mjs`) and update the skill's paths. The skill stays
at `.grasberg/skills/run-desktop/`; the driver finds a better home.

## Step 1 — get the app to launch AT ALL under xvfb

This is usually the hardest part and produces most of the Gotchas. The
README will say "macOS/Windows only." Ignore that. Install xvfb + the
Chromium shared libs, find the Electron binary, and launch it:

```bash
apt-get install -y xvfb libnss3 libgbm1 libasound2t64 libgtk-3-0 \
  libxss1 libxkbcommon0 libatk-bridge2.0-0 libcups2 libdrm2

# Build the app first. Often the "dev" script is electron-forge which
# does a Vite/webpack build THEN launches. You want just the build:
npm install
npx electron-forge start &   # builds .vite/build/ or dist/
sleep 20 && kill %1          # kill it once built — you'll launch yourself

# Now try the raw launch
xvfb-run -a node -e "
  const { _electron } = require('playwright-core');
  _electron.launch({
    executablePath: './node_modules/electron/dist/electron',
    args: ['--no-sandbox', '.'],
    timeout: 30000,
  }).then(app => {
    console.log('launched, windows:', app.windows().map(w => w.url()));
    return app.close();
  });
"
```

Iterate until it launches. Each missing `.so` → one more `apt-get`
package → one more line in Prerequisites. Each launch timeout → check
the `nodeCliInspect` fuse isn't disabled, check the build output exists.

**`--no-sandbox` is almost always needed in containers.** Electron's
sandbox needs CAP_SYS_ADMIN or user namespaces. Neither by default.

## Step 2 — build the REPL driver

Once you can launch it, turn that throwaway script into a REPL. Start
minimal — you will add commands as you need them. **The REPL is the
right shape** because an agent can run it inside tmux and iterate
without relaunching the (slow) app on every interaction.

```javascript
// .grasberg/skills/run-<unit>/driver.mjs
// REPL driver for <app>. Run under xvfb on headless Linux.
// Designed for agents: wrap in tmux, send-keys commands, capture-pane output.
import { _electron as electron } from 'playwright-core';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let app = null;
let page = null;   // the window/page you actually interact with

const electronBin = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched');
    app = await electron.launch({
      executablePath: electronBin,
      args: ['--no-sandbox', APP_DIR],
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
      timeout: 30_000,
    });
    // Electron has no clean "loaded" signal — this sleep is a blind guess.
    // Replace with a poll once you know what ready looks like for this app:
    // wait until windows() includes the expected URL, or waitForSelector on firstWindow().
    await new Promise(r => setTimeout(r, 8_000));
    // Find the real UI page. Often NOT firstWindow() — may be a
    // splash screen, or the real content is in a BrowserView overlay.
    page = app.windows().find(w => !w.url().startsWith('devtools://'))
        ?? await app.firstWindow();
    console.log('launched.', app.windows().length, 'windows:');
    for (const w of app.windows()) console.log(' ', w.url());
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first');
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: f });
    console.log('screenshot:', f);
  },

  // Click via evaluate(), NOT locator.click(). If the content lives in a
  // BrowserView layered over the main window, Playwright's coordinate
  // math hits the wrong layer. DOM .click() always works.
  async click(sel) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate(s => {
      const el = document.querySelector(s);
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK';
    }, sel);
    console.log('click', sel, '→', r);
  },

  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate(t => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')];
      const el = els.find(e => e.textContent?.trim() === t)
              ?? els.find(e => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK: ' + el.tagName;
    }, text);
    console.log('click-text', JSON.stringify(text), '→', r);
  },

  async type(text)  { if (page) await page.keyboard.type(text, { delay: 30 }); },
  async press(key)  { if (page) await page.keyboard.press(key); },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first');
    try { await page.waitForSelector(sel, { timeout: 10_000 }); console.log('found:', sel); }
    catch { console.log('TIMEOUT:', sel); }
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first');
    try { console.log(JSON.stringify(await page.evaluate(expr))); }
    catch (e) { console.log('ERROR:', e.message); }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first');
    console.log(await page.evaluate(
      s => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)',
      sel || null));
  },

  // Introspection: essential for figuring out which window/webContents
  // actually has the UI. Electron apps often spawn several.
  async windows() {
    if (!app) return console.log('ERROR: launch first');
    for (const w of app.windows()) console.log(' ', w.url());
    const wcs = await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map(w => ({ id: w.id, type: w.getType(), url: w.getURL() })));
    console.log('webContents:');
    for (const w of wcs) console.log(` [${w.id}] ${w.type}: ${w.url}`);
  },

  async quit() { if (app) await app.close().catch(()=>{}); app = null; page = null; },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')); },
};

// Stop Electron from stealing stdin — use the raw fd.
const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' });

rl.on('line', async line => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return rl.prompt();
  const fn = COMMANDS[cmd];
  if (!fn) { console.log('unknown:', cmd, '— try: help'); return rl.prompt(); }
  try { await fn(rest.join(' ')); } catch (e) { console.log('ERROR:', e.message); }
  if (cmd === 'quit') { rl.close(); process.exit(0); }
  rl.prompt();
});
rl.on('close', async () => { await COMMANDS.quit(); process.exit(0); });

console.log('<app> driver — "help" for commands, "launch" to start');
rl.prompt();
```

**This is a starting skeleton.** As you try to reach interesting parts
of the app you'll add app-specific commands: navigate to a particular
view, focus a weird input type, bypass an auth gate, whatever. Those
commands encode hard-won knowledge — keep them.

## Step 3 — use it yourself, via tmux

Run the driver the same way the next agent will:

```bash
tmux new-session -d -s app -x 200 -y 50
tmux send-keys -t app 'cd /workspace/apps/desktop && xvfb-run -a node .grasberg/skills/run-desktop/driver.mjs' Enter
timeout 20 bash -c 'until tmux capture-pane -t app -p | grep -q "driver>"; do sleep 0.2; done'
tmux send-keys -t app 'launch' Enter
timeout 60 bash -c 'until tmux capture-pane -t app -p | grep -q "launched"; do sleep 0.2; done'
tmux send-keys -t app 'ss 01-landing' Enter
timeout 10 bash -c 'until tmux capture-pane -t app -p | grep -q "screenshot:"; do sleep 0.2; done'
tmux send-keys -t app 'windows' Enter    # which page has the real UI?
tmux capture-pane -t app -p
```

Then actually open `/tmp/shots/01-landing.png`. Is it the app? Is it
blank? Is it a login screen? Each of these tells you what to do next.

Keep going — click into the main feature, fill a form, see the result
show up, screenshot it. The driver grows whatever commands you need
(`focus-input`, `goto-settings`, `login-as-test-user`…). When one real
flow works end-to-end, you're done building and ready to write.

## Step 4 — write SKILL.md

Keep it short. The driver is the meat; `SKILL.md` is the manual.
Structure that works:

> ---
> name: run-desktop
> description: Build, run, and drive the <app> Electron desktop app. Use when asked to start the desktop app, take a screenshot of it, build it, or interact with its UI.
> ---
>
> <App> is an Electron desktop app. For agent/automated use, drive it
> via the Playwright REPL at `.grasberg/skills/run-desktop/driver.mjs`
> under xvfb. Launch is slow (~10s) and the interesting UI lives in a
> BrowserView, not the main window — the driver handles both.
>
> All paths are relative to `apps/desktop/`.
>
> ## Prerequisites
>
> ```bash
> apt-get install -y xvfb libnss3 libgbm1 libasound2t64 libgtk-3-0 \
>   libxss1 libxkbcommon0 libatk-bridge2.0-0 libcups2 libdrm2
> ```
>
> ## Build
>
> ```bash
> npm install
> npx electron-forge start   # builds .vite/build/ — Ctrl-C once built
> # <any patch you had to apply: sed a feature gate, etc.>
> ```
>
> ## Run (agent path)
>
> ```bash
> cd apps/desktop
> xvfb-run -a node .grasberg/skills/run-desktop/driver.mjs
> ```
>
> Wrap in tmux for interactive use:
>
> ```bash
> tmux new-session -d -s app -x 200 -y 50
> tmux send-keys -t app 'cd apps/desktop && xvfb-run -a node .grasberg/skills/run-desktop/driver.mjs' Enter
> timeout 20 bash -c 'until tmux capture-pane -t app -p | grep -q "driver>"; do sleep 0.2; done'
> tmux send-keys -t app 'launch' Enter
> timeout 60 bash -c 'until tmux capture-pane -t app -p | grep -q "launched"; do sleep 0.2; done'
> tmux send-keys -t app 'ss landing' Enter
> tmux capture-pane -t app -p
> ```
>
> Screenshots land in `/tmp/shots/` (override: `SCREENSHOT_DIR`).
>
> ### Commands
>
> | command | what it does |
> |---|---|
> | `launch` | launch the app, wait for windows |
> | `ss [name]` | screenshot → `/tmp/shots/<name>.png` |
> | `click <css-sel>` | click element (via DOM, not coords — see Gotchas) |
> | `click-text <text>` | click button/link containing text |
> | `type <text>` / `press <key>` | keyboard input |
> | `wait <css-sel>` | wait for element, 10s timeout |
> | `eval <js>` | evaluate in the page, print JSON |
> | `text [css-sel]` | print innerText |
> | `windows` | list all windows + webContents (find the real UI) |
> | `quit` | close app, exit |
>
> Plus any app-specific commands you built: `<your-command>` — <what it does>.
>
> ## Run (human path)
>
> ```bash
> npm start   # opens a window; useless headless. Ctrl-C to quit.
> ```
>
> ## Gotchas
>
> - **<the specific weird thing you hit>** — <why> → <fix/workaround>
> - <etc. — only things you actually hit, not generic advice>
>
> ## Troubleshooting
>
> - **Launch timeout (30s):** build output missing? → re-run the build
>   step. `nodeCliInspect` fuse disabled? → Playwright can't attach;
>   don't disable that fuse in dev builds.
> - **"Missing X server":** forgot `xvfb-run`. Headless Linux needs it.
> - **Stale Xvfb locks:** `rm -f /tmp/.X*-lock; pkill Xvfb`
> - <anything else you actually hit>

## Obstacles you will hit (and they go in Gotchas)

These are real patterns from real Electron apps. You'll hit some subset:

- **`firstWindow()` gives you a splash/loading screen,** not the app.
  Wait longer, or find the right page by URL, or wait for a specific
  selector that only appears when the app is actually ready.

- **The real UI is in a BrowserView, not a BrowserWindow.** Playwright
  sees it as a separate "window" with a different URL. The `windows`
  command exists exactly for figuring this out. `getBrowserViews()`
  may also return empty on newer Electron — use
  `webContents.getAllWebContents()` instead.

- **`locator.click()` clicks the wrong thing.** Playwright computes
  click coordinates relative to the main window. If your content is in
  a BrowserView overlay, those coordinates hit the window behind it.
  The driver skeleton uses `page.evaluate(el => el.click())` for this
  reason — DOM click bypasses coordinates entirely.

- **Feature gates block the thing you need to test.** The app checks a
  plan tier, or an env flag, or a feature flag baked into SSR HTML.
  Find where the check happens (grep the built output for the gate
  name) and patch it for your local run — a `sed` on the build output,
  an env var override, or (for SSR-embedded flags) intercept the
  response via CDP `Fetch.enable` and rewrite it in-flight. Document
  exactly what you patched and why.

- **contentEditable inputs** (ProseMirror, Tiptap, Slate) aren't
  `<textarea>`. `fill()` won't work. Focus the element, then use
  `keyboard.type()`. Add a `focus <sel>` command if the app has these.

- **Electron steals stdin.** The `fs.openSync('/dev/stdin', 'r')` +
  `createReadStream` trick in the skeleton protects your REPL's input.

- **Native modules fail to load** (keychain, notifications, etc.).
  Usually non-fatal — the core app runs, those features no-op. Note it
  and move on.

---

## Appendix: examples/playwright.md

# Example: Browser-driven web app

You have a dev server that serves HTML to a browser. An agent in a
headless container can't open a browser window — so "run the app" means
launching the dev server, driving a headless Chromium against it, and
producing a screenshot that proves the page rendered.

Don't write a browser driver. Use `chromium-cli`.

## Dev server

Find the dev command (`package.json` `scripts.dev`, `Makefile`,
README), start it in the background, and wait for it to actually serve:

```bash
npm run dev &   # or yarn dev, pnpm dev, make serve, ./dev.sh
echo $! > /tmp/dev.pid
timeout 30 bash -c 'until curl -sf http://localhost:3000 >/dev/null; do sleep 1; done'
```

Don't `sleep 5` — poll the port. Stop with
`kill $(cat /tmp/dev.pid)` (or `pkill -f 'npm run dev'`) before
relaunching, or the next run hits `EADDRINUSE`.

## Drive

`chromium-cli` is a headless-Chromium REPL. Pipe a script to stdin:

```bash
chromium-cli --session app <<'EOF'
nav http://localhost:3000
wait-for text=Dashboard
screenshot
click button:has-text("New item")
fill input[name="title"] Smoke test
press Enter
wait-for text=Smoke test
screenshot
console --errors
EOF
```

Screenshots land in `chromium_cli/sessions/app/screenshots/` (latest
symlinked as `screenshot.png`). That's the whole loop: `nav` →
`wait-for` the element you need → act (`click` / `fill` / `type` /
`press`) → `screenshot` → `console --errors` to check nothing threw.
Full command reference: `chromium-cli` skill, or `help` at the prompt.

For iterative debugging, run it under tmux and `send-keys` one command
at a time — same commands, same session.

**If `chromium-cli` isn't available:** adapt
[electron.md](electron.md)'s REPL driver — the structure and commands
transfer, but it's `_electron`-specific:
import `{ chromium }` instead, launch with
`chromium.launch({ args: ['--no-sandbox'] })`, acquire the page via
`(await app.newContext()).newPage()` then `goto()` your dev URL, and
drop the Electron-only window introspection
(`.windows()`/`.firstWindow()`/the `windows` command).

## What to put in the skill

The project-specific bits only. `chromium-cli` handles the mechanics.

- **Dev command + port + stop.** The exact start line, any env vars it
  needs, and the `kill`/`pkill` to stop it.
- **Auth.** Whatever gets a logged-in session — a `set-cookie` line, a
  `fill`/`click` login sequence, or a helper script that does the API
  dance and emits the cookie.
- **One representative interaction.** Not the whole app — one path that
  proves it's running, ending in a screenshot.
- **App-specific gotchas.** Only the ones you actually hit.

## Gotchas that recur

- **React controlled inputs.** `eval el.value = '…'` doesn't fire
  React's onChange. Use `fill` / `type` — they go through Playwright's
  input pipeline.
- **Websockets / long-poll.** `wait-idle` never settles. `wait-for` the
  element you actually need.
- **Slow first paint.** Vite/Next compile routes on demand; the first
  `nav` can take 10s+. `wait-for` handles it; raw `sleep` doesn't.
- **`screenshot-element <sel>`** crops to one element — use it when the
  diff is in a specific component, not the whole page.
- **Check `console --errors` before declaring success.** A page can
  render its shell while every data fetch 500s.

---

## Appendix: examples/library.md

# Example: Library / SDK

Libraries don't have a "run" step in the process sense — there's no
server to start, no CLI to invoke. For libraries, the run skill is about:

1. **Building** the library from source
2. **Running the test suite**
3. **A minimal working example** that exercises the library and proves
   it's installed correctly

Keep it brief. The template's Build and Test sections do most of the work.

## The smoke-test example

The main library-specific addition is a tiny program (or REPL snippet)
that imports the library and does one real thing. This is how an agent
confirms "yes, the library is usable":

> ## Verify
>
> ```bash
> python -c '
> from mylib import Client
> c = Client()
> print(c.ping())
> '
> # → pong
> ```

Or for a compiled language:

> ```bash
> cat > /tmp/smoke.go <<GO
> package main
> import "example.com/mylib"
> func main() { println(mylib.Version()) }
> GO
> go run /tmp/smoke.go
> # → v1.2.3
> ```

## Example snippet

> ---
> name: run-mylib
> description: Build, install, and test mylib from source. Use when asked to verify mylib works, run its tests, or build a distribution.
> ---
>
> `mylib` is a Python library — "running" it means building from source
> and executing the test suite.
>
> ## Setup
>
> ```bash
> pip install -e '.[dev]'
> ```
>
> ## Verify
>
> ```bash
> python -c 'import mylib; print(mylib.__version__)'
> # → 2.1.0
> ```
>
> ## Test
>
> ```bash
> pytest
> ```
>
> Subset of tests: `pytest tests/unit/`. With coverage: `pytest --cov=mylib`.
>
> ## Build (distribution)
>
> ```bash
> pip install build
> python -m build
> # → dist/mylib-2.1.0-py3-none-any.whl
> ```

## Things to consider documenting

- **Development mode vs installed mode.** `pip install -e .` vs
  `pip install .` — if behavior differs, say which to use for what.
- **Optional dependencies.** `[dev]`, `[test]`, `[docs]` extras and when
  each is needed.
- **Generated code.** If there's a codegen step (protobuf, OpenAPI clients),
  document it — it's almost always missing from READMEs.