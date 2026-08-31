/**
 * Quick assistant — pure selection/prompt helpers shared by main and the quick
 * window's renderer. No runtime deps (type-only imports), like workflow-status.
 */

import type { QuickContext } from './types'

/** Cap on the clipboard capture sent through a quick action. */
export const QUICK_SELECTION_MAX_CHARS = 20_000

/** Captures a clipboard read as a QuickContext, truncating at the cap. */
export function captureSelection(
  raw: string,
  maxChars: number = QUICK_SELECTION_MAX_CHARS
): QuickContext {
  return { selectionText: raw.slice(0, maxChars), truncated: raw.length > maxChars }
}

/**
 * Substitutes the copied text into an action's prompt template: every
 * `{selection}` occurrence is replaced; a template without the placeholder
 * gets the selection appended after a blank line, so an edited action can
 * never silently drop the copied text.
 */
export function buildQuickPrompt(template: string, selection: string): string {
  if (template.includes('{selection}')) {
    return template.split('{selection}').join(selection)
  }
  return `${template}\n\n${selection}`
}
