/**
 * Scheduled-task delivery target (v47, OpenClaw-style): POSTs a finished
 * run's result to the task's webhook URL. Best-effort — a webhook failure
 * never fails the run it describes. URLs are validated at the IPC boundary
 * (https, or plain http on localhost only); re-checked here as depth.
 */

import { redactSecrets } from '../providers/redact'

const WEBHOOK_TIMEOUT_MS = 10_000
const OUTPUT_MAX_CHARS = 20_000

export function isAllowedWebhookUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.username || url.password) return false
    if (url.protocol === 'https:') return true
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
    )
  } catch {
    return false
  }
}

export async function postRunWebhook(
  url: string,
  payload: {
    taskId: string
    title: string
    status: 'ok' | 'error'
    output: string
    error: string | null
    finishedAt: number
  },
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (!isAllowedWebhookUrl(url)) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'grasberg-scheduled-task',
        ...payload,
        output: redactSecrets(payload.output).slice(0, OUTPUT_MAX_CHARS),
        error: payload.error ? redactSecrets(payload.error).slice(0, 2000) : null,
      }),
      signal: controller.signal,
    })
  } catch (e) {
    console.error(
      '[scheduled-tasks] webhook delivery failed:',
      e instanceof Error ? e.message : 'Unknown error'
    )
  } finally {
    clearTimeout(timer)
  }
}
