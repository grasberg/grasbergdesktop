/**
 * Starter prompts for an empty conversation: each one is picked to show off
 * a real capability (mermaid diagrams, KaTeX, work mode's file writing + the
 * Preview tab, the Changes pipeline) so the blank first-five-minutes doubles
 * as feature discovery. Pure data — the ChatView renders them as cards that
 * seed the composer (editable before sending).
 */

import type { ConversationMode } from '@shared/types'

export interface StarterPrompt {
  id: string
  /** Short card title. */
  title: string
  /** The editable text dropped into the composer. */
  prompt: string
}

export const STARTER_PROMPTS: Record<ConversationMode, readonly StarterPrompt[]> = {
  chat: [
    {
      id: 'chat-diagram',
      title: 'Explain with a diagram',
      prompt:
        'Explain how HTTPS works, and include a Mermaid sequence diagram of the TLS handshake.',
    },
    {
      id: 'chat-email',
      title: 'Draft & translate an email',
      prompt:
        'Draft a short, friendly email to a colleague about moving tomorrow’s meeting to Friday — then translate it to Swedish.',
    },
    {
      id: 'chat-summarize',
      title: 'Summarize a text',
      prompt:
        'Summarize the following into 5 bullet points and one key takeaway:\n\n<paste your text here>',
    },
    {
      id: 'chat-decide',
      title: 'Help me decide',
      prompt:
        'Help me choose between two options. Ask me three clarifying questions first, then compare them in a table and recommend one.',
    },
    {
      id: 'chat-math',
      title: 'Step-by-step math',
      prompt:
        'Show, step by step with formulas, how compound interest works — 10 000 kr at 5% yearly for 10 years.',
    },
  ],
  work: [
    {
      id: 'work-landing',
      title: 'Build a page I can preview',
      prompt:
        'Create a small landing page for a fictional coffee shop — a single index.html with embedded CSS — so I can open it in the Preview tab.',
    },
    {
      id: 'work-script',
      title: 'Script with tests',
      prompt:
        'Write a Python script that renames every file in a folder to kebab-case, plus pytest tests covering the edge cases.',
    },
    {
      id: 'work-plan',
      title: 'Plan a project',
      prompt:
        'Help me plan a small project: break “build a personal website” into a step-by-step task list, then start on the first step.',
    },
    {
      id: 'work-refactor',
      title: 'Refactor my code',
      prompt:
        'Refactor this function for readability and explain each change as a reviewable diff:\n\n<paste your code here>',
    },
  ],
}
