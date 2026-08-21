/**
 * Starter workflow templates for the builder's "new workflow" gallery.
 * Templates are DATA, not code (same philosophy as presets.generated.ts):
 * pre-wired graphs with placeholder-style config the user edits after
 * picking one. Node ids only need to be unique within one graph.
 */

import type { WorkflowGraph } from './types'

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  graph: WorkflowGraph
}

const X = 40
const STEP = 230
const Y = 120

function pos(col: number, row = 0): { x: number; y: number } {
  return { x: X + col * STEP, y: Y + row * 130 }
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: 'morning-brief',
    name: 'Morning brief → Notify',
    description:
      'An AI-written daily brief delivered via your Telegram bridge or webhook. Enable "Run on a schedule" to get it every morning.',
    graph: {
      nodes: [
        {
          id: 'brief-input',
          kind: 'manual',
          label: 'Brief request',
          position: pos(0),
          config: {
            text: 'Write my morning brief: a short summary of what matters in tech today, one productivity tip, and a one-line motivation.',
          },
        },
        {
          id: 'brief-ai',
          kind: 'ai_agent',
          label: 'Write the brief',
          position: pos(1),
          config: { prompt: '{{input}}', useTools: true },
        },
        { id: 'brief-notify', kind: 'notify', label: 'Deliver', position: pos(2), config: {} },
        { id: 'brief-output', kind: 'output', label: 'Result', position: pos(3), config: {} },
      ],
      edges: [
        { id: 'brief-e1', source: 'brief-input', target: 'brief-ai' },
        { id: 'brief-e2', source: 'brief-ai', target: 'brief-notify' },
        { id: 'brief-e3', source: 'brief-notify', target: 'brief-output' },
      ],
    },
  },
  {
    id: 'watch-url',
    name: 'Watch a URL, summarize it',
    description:
      'Fetches a page and has the AI summarize what matters. Point the HTTP node at any page or API; schedule it to keep watch.',
    graph: {
      nodes: [
        {
          id: 'watch-fetch',
          kind: 'http_request',
          label: 'Fetch the page',
          position: pos(0),
          config: { method: 'GET', url: 'https://example.com/' },
        },
        {
          id: 'watch-ai',
          kind: 'ai_agent',
          label: 'Summarize',
          position: pos(1),
          config: {
            prompt:
              'Summarize the important content, headlines or changes in this page:\n\n{{input}}',
          },
        },
        { id: 'watch-output', kind: 'output', label: 'Summary', position: pos(2), config: {} },
      ],
      edges: [
        { id: 'watch-e1', source: 'watch-fetch', target: 'watch-ai' },
        { id: 'watch-e2', source: 'watch-ai', target: 'watch-output' },
      ],
    },
  },
  {
    id: 'conditional-alert',
    name: 'Prompt → AI → conditional alert',
    description:
      'The AI analyzes something and only notifies you when its answer contains a keyword — the condition node gates the alert.',
    graph: {
      nodes: [
        {
          id: 'alert-input',
          kind: 'manual',
          label: 'What to check',
          position: pos(0),
          config: {
            text: 'Describe the thing to check here (paste text, a report, numbers…).',
          },
        },
        {
          id: 'alert-ai',
          kind: 'ai_agent',
          label: 'Analyze',
          position: pos(1),
          config: {
            prompt:
              'Analyze the following and decide if it needs my attention. Start your reply with the single word URGENT if it does, then explain briefly:\n\n{{input}}',
          },
        },
        {
          id: 'alert-cond',
          kind: 'condition',
          label: 'Urgent?',
          position: pos(2),
          config: { needle: 'URGENT' },
        },
        { id: 'alert-notify', kind: 'notify', label: 'Alert me', position: pos(3, -0.5), config: {} },
        { id: 'alert-output', kind: 'output', label: 'Result', position: pos(4), config: {} },
      ],
      edges: [
        { id: 'alert-e1', source: 'alert-input', target: 'alert-ai' },
        { id: 'alert-e2', source: 'alert-ai', target: 'alert-cond' },
        { id: 'alert-e3', source: 'alert-cond', target: 'alert-notify', sourceHandle: 'true' },
        { id: 'alert-e4', source: 'alert-notify', target: 'alert-output' },
        { id: 'alert-e5', source: 'alert-cond', target: 'alert-output', sourceHandle: 'false' },
      ],
    },
  },
  {
    id: 'daily-digest',
    name: 'Daily scheduled digest',
    description:
      'A minimal schedule-ready pipeline: prompt → AI → deliver. Save it, then switch on "Run on a schedule" and set the interval.',
    graph: {
      nodes: [
        {
          id: 'digest-input',
          kind: 'manual',
          label: 'Digest request',
          position: pos(0),
          config: {
            text: 'Give me a short daily digest: one thing worth reading about AI, and one practical tip I can use today.',
          },
        },
        {
          id: 'digest-ai',
          kind: 'ai_agent',
          label: 'Write the digest',
          position: pos(1),
          config: { prompt: '{{input}}' },
        },
        { id: 'digest-notify', kind: 'notify', label: 'Deliver', position: pos(2), config: {} },
        { id: 'digest-output', kind: 'output', label: 'Result', position: pos(3), config: {} },
      ],
      edges: [
        { id: 'digest-e1', source: 'digest-input', target: 'digest-ai' },
        { id: 'digest-e2', source: 'digest-ai', target: 'digest-notify' },
        { id: 'digest-e3', source: 'digest-notify', target: 'digest-output' },
      ],
    },
  },
]
