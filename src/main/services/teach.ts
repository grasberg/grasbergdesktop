/**
 * Teach-a-task (v53, Grok Bot's signature feature): the user demonstrates a
 * workflow once in the agent's browser and Grasberg turns the recording into
 * a reusable skill — steps, decision rules, inputs, output and approval
 * boundaries — that any agent can follow with use_skill.
 *
 * This module is the pure half (Electron-free, unit-tested): the page-side
 * recorder source, step normalization, the prompt that generalizes a
 * demonstration, and a deterministic fallback skill. The browser session
 * injects the recorder and collects steps; TeachService (below) orchestrates.
 *
 * Secrets never enter a recording: a value typed into a password / one-time
 * code / card field is stored as `secret: true` with no value, and the skill
 * is told to use the vault's 'login' action or hand the step to the user.
 */

import type { Skill, TeachStatus, TeachStep } from '@shared/types'
import { IS_SENSITIVE_FIELD_JS } from '../browser/sensitive'

/** Console marker the recorder uses to hand events to main. */
export const TEACH_MARKER = '__GRASBERG_TEACH__'
/** A demonstration longer than this is truncated (the skill would be unwieldy anyway). */
export const MAX_TEACH_STEPS = 200

/** Page-side recorder: clicks, field changes and submits, posted via console.debug. */
export const TEACH_RECORDER_JS = `(() => {
  if (window.__grasbergTeach) return true;
  window.__grasbergTeach = true;
  const isSensitive = ${IS_SENSITIVE_FIELD_JS};
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const labelFor = (el) => {
    if (!el) return '';
    if (el.labels && el.labels[0]) return clean(el.labels[0].innerText);
    return clean(el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('name')) || el.innerText || el.value || el.alt || el.id);
  };
  const selectorFor = (el) => {
    if (!el || !el.tagName) return '';
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '#' + el.id;
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute('data-testid');
    if (testId) return tag + '[data-testid="' + testId + '"]';
    const name = el.getAttribute('name');
    if (name) return tag + '[name="' + name + '"]';
    const parent = el.parentElement;
    if (!parent) return tag;
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    return same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(el) + 1) + ')' : tag;
  };
  const send = (ev) => { try { console.debug('${TEACH_MARKER}' + JSON.stringify(ev)); } catch (e) {} };
  document.addEventListener('click', (e) => {
    const el = (e.target && e.target.closest && e.target.closest('a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem]')) || e.target;
    if (!el || (el.tagName === 'INPUT' && /^(text|email|password|search|tel|number|)$/i.test(el.type || ''))) return;
    send({ kind: 'click', selector: selectorFor(el), label: labelFor(el), tag: el.tagName ? el.tagName.toLowerCase() : '' });
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !('value' in el)) return;
    const secret = isSensitive(el);
    send({ kind: 'input', selector: selectorFor(el), label: labelFor(el), tag: el.tagName.toLowerCase(),
      value: secret ? null : String(el.type === 'checkbox' ? el.checked : el.value).slice(0, 200), secret });
  }, true);
  document.addEventListener('submit', (e) => {
    send({ kind: 'submit', selector: selectorFor(e.target), label: labelFor(e.target), tag: 'form' });
  }, true);
  return true;
})()`

/** Parses one recorder console line into a step, or null. */
export function parseTeachEvent(message: string, url: string, at: number): TeachStep | null {
  if (!message.startsWith(TEACH_MARKER)) return null
  try {
    const raw = JSON.parse(message.slice(TEACH_MARKER.length)) as Record<string, unknown>
    const kind = raw.kind
    if (kind !== 'click' && kind !== 'input' && kind !== 'submit') return null
    const str = (value: unknown, max: number): string =>
      typeof value === 'string' ? value.slice(0, max) : ''
    const secret = raw.secret === true
    return {
      kind,
      url,
      selector: str(raw.selector, 200),
      label: str(raw.label, 80),
      tag: str(raw.tag, 20),
      value: secret ? null : typeof raw.value === 'string' ? raw.value.slice(0, 200) : null,
      secret,
      at,
    }
  } catch {
    return null
  }
}

/**
 * Cleans a raw recording: merges repeated edits of one field into the last
 * value, drops a navigation that merely follows the click causing it, and
 * caps the length.
 */
export function normalizeSteps(steps: readonly TeachStep[]): TeachStep[] {
  const out: TeachStep[] = []
  for (const step of steps) {
    const last = out[out.length - 1]
    if (step.kind === 'input' && last?.kind === 'input' && last.selector === step.selector) {
      out[out.length - 1] = step
      continue
    }
    if (step.kind === 'navigate' && last?.kind === 'navigate' && last.url === step.url) continue
    if (step.kind === 'navigate' && last && (last.kind === 'click' || last.kind === 'submit') && step.at - last.at < 4000) {
      out.push({ ...step, followsAction: true })
      continue
    }
    out.push(step)
  }
  return out.slice(0, MAX_TEACH_STEPS)
}

/** One human-readable line per step (the prompt and the fallback skill share it). */
export function describeStep(step: TeachStep): string {
  const target = step.label ? `"${step.label}"` : step.selector || step.tag || 'element'
  const where = step.selector ? ` (selector \`${step.selector}\`)` : ''
  switch (step.kind) {
    case 'navigate':
      return step.followsAction ? `Page loads: ${step.url}` : `Open ${step.url}`
    case 'click':
      return `Click ${target}${where}`
    case 'input':
      return step.secret
        ? `Fill ${target}${where} with a SECRET (password/code/card) — use the browser 'login' action or hand_off, never type it`
        : `Fill ${target}${where} with "${step.value ?? ''}"`
    case 'submit':
      return `Submit the form ${target}`
  }
}

export function buildTeachPrompt(input: {
  name: string
  description: string
  steps: readonly TeachStep[]
}): string {
  const lines = input.steps.map((step, index) => `${index + 1}. ${describeStep(step)}`)
  return [
    'The user demonstrated a task once in a web browser. Turn the demonstration into a reusable',
    'skill an AI agent can follow with its browser tool (actions: navigate, read, click, type,',
    'back, login, logins) and hand_off.',
    '',
    `Skill name: ${input.name}`,
    input.description ? `What the user said it is for: ${input.description}` : '',
    '',
    'Recorded steps:',
    ...lines,
    '',
    'Write the skill as Markdown with these sections:',
    '## Purpose — one or two sentences.',
    '## Inputs — values that change between runs (generalize typed values that are clearly',
    '   per-run, like dates, names, amounts or search terms; keep constants as constants).',
    '## Steps — numbered, generalized, robust: prefer visible text over brittle selectors, but keep',
    '   a selector as a fallback hint; say what to check on each page before continuing.',
    '## Decision rules — what to do when the page differs (logged out, empty results, errors).',
    '## Output — what to report back to the user when done.',
    '## Approval boundaries — passwords and codes use the login action or hand_off; payments,',
    '   purchases, sending messages and anything irreversible are handed to the user or need',
    '   their approval.',
    'Return ONLY the Markdown, no preamble.',
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n')
}

/** Deterministic skill when no model is available (or it failed). */
export function fallbackSkill(input: {
  name: string
  description: string
  steps: readonly TeachStep[]
}): string {
  return [
    `## Purpose`,
    input.description || `Repeat the "${input.name}" task the user demonstrated.`,
    '',
    '## Steps (as demonstrated)',
    ...input.steps.map((step, index) => `${index + 1}. ${describeStep(step)}`),
    '',
    '## Approval boundaries',
    "- Passwords and codes: use the browser 'login' action or hand_off — never type them.",
    '- Payments, purchases, sending or publishing: hand the step to the user.',
  ].join('\n')
}

/**
 * "Save this conversation as a skill" (v53, Grok's successful-run → skill):
 * the transcript (user turns, replies, tool calls) becomes the material.
 */
export function buildConversationSkillPrompt(input: {
  name: string
  description: string
  transcript: string
}): string {
  return [
    'Below is a conversation in which an AI agent completed a task for the user, including the',
    'tools it called. Turn the PROCESS into a reusable skill another run can follow.',
    '',
    `Skill name: ${input.name}`,
    input.description ? `What the user said it is for: ${input.description}` : '',
    '',
    'Conversation:',
    '"""',
    input.transcript,
    '"""',
    '',
    'Write Markdown with sections: ## Purpose, ## Inputs (what changes between runs), ## Steps',
    '(numbered; name the tools to use), ## Decision rules, ## Output, ## Approval boundaries',
    '(payments, passwords, sending or publishing are handed to the user or need approval).',
    'Leave out one-off details of this particular run. Return ONLY the Markdown.',
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n')
}

/** Compact transcript of a conversation for buildConversationSkillPrompt. */
export function conversationTranscript(
  messages: ReadonlyArray<{
    role: string
    content: string
    toolCalls?: ReadonlyArray<{ name: string; arguments: string }>
  }>,
  maxChars = 14_000
): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = message.content.replace(/\s+/g, ' ').trim().slice(0, 1200)
    if (text) parts.push(`${message.role === 'user' ? 'User' : 'Agent'}: ${text}`)
    for (const call of message.toolCalls ?? []) {
      parts.push(`  [tool ${call.name}] ${call.arguments.replace(/\s+/g, ' ').slice(0, 240)}`)
    }
  }
  let transcript = parts.join('\n')
  if (transcript.length > maxChars) transcript = `…${transcript.slice(transcript.length - maxChars)}`
  return transcript
}

/** Strips a ```markdown fence a model may wrap the skill in. */
export function cleanSkillMarkdown(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return (fenced ? fenced[1] : trimmed).trim()
}

// ---------------------------------------------------------------------------
// TeachService: one demonstration at a time
// ---------------------------------------------------------------------------

/** The slice of a browser session teaching needs (BrowserSession satisfies it). */
export interface TeachableSession {
  takeOver(): void
  returnControl(): void
  startRecording(): void
  stopRecording(): TeachStep[]
  navigate(url: string): Promise<string>
}

export interface TeachServiceDeps {
  sessionFor(agentId: string | null): TeachableSession
  /** Economy-model generation; may reject (the fallback skill is used then). */
  generate(prompt: string): Promise<string>
  saveSkill(input: { name: string; description: string; content: string }): Skill
  onChanged?(status: TeachStatus | null): void
}

export class TeachService {
  private active: { agentId: string | null; startedAt: number; session: TeachableSession } | null =
    null

  constructor(private readonly deps: TeachServiceDeps) {}

  status(): TeachStatus | null {
    return this.active ? { agentId: this.active.agentId, startedAt: this.active.startedAt } : null
  }

  /** Opens the agent's browser for the user and starts recording. */
  async start(agentId: string | null, startUrl?: string | null): Promise<TeachStatus> {
    if (this.active) throw new Error('A demonstration is already being recorded — finish it first.')
    const session = this.deps.sessionFor(agentId)
    session.takeOver()
    session.startRecording()
    this.active = { agentId, startedAt: Date.now(), session }
    if (startUrl && /^https?:\/\//i.test(startUrl.trim())) {
      // Navigating also records the first step via the session's listener.
      void session.navigate(startUrl.trim())
    }
    const status = this.status() as TeachStatus
    this.deps.onChanged?.(status)
    return status
  }

  /** Stops recording; saves the skill unless `cancel`. Returns the saved skill. */
  async stop(input: { name?: string; description?: string; cancel?: boolean }): Promise<Skill | null> {
    const active = this.active
    if (!active) throw new Error('No demonstration is being recorded.')
    this.active = null
    const steps = normalizeSteps(active.session.stopRecording())
    active.session.returnControl()
    this.deps.onChanged?.(null)
    if (input.cancel) return null
    const name = (input.name ?? '').trim()
    if (!name) throw new Error('Give the skill a name.')
    if (steps.length === 0) throw new Error('Nothing was recorded — click through the task in the agent browser first.')
    const description = (input.description ?? '').trim()
    let content: string
    try {
      content = cleanSkillMarkdown(await this.deps.generate(buildTeachPrompt({ name, description, steps })))
      if (content.length < 40) throw new Error('too short')
    } catch {
      content = fallbackSkill({ name, description, steps })
    }
    return this.deps.saveSkill({
      name,
      description: description || `Taught by demonstration (${steps.length} steps).`,
      content,
    })
  }
}
