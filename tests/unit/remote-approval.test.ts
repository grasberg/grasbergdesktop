/**
 * Remote tool approvals over the Telegram bridge: a background run can ask
 * instead of failing while the user is away.
 *
 * The security properties are the point of this file. Only the PAIRED chat may
 * answer; the token in callback_data is a lookup key and nothing else; every
 * outcome that is not an explicit "allow" (no channel, a cancel, teardown)
 * resolves to null, which every caller treats as a decline.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { ImBridgeManager } from '../../src/main/im/manager'

let dir: string
let db: AppDatabase
let manager: ImBridgeManager
/** Every request the bridge made, in order. */
let calls: Array<{ method: string; body: Record<string, unknown> }>
/** Releases the pending long-poll with a batch of updates. */
let releaseUpdates: (updates: unknown[]) => void

const OWNER_CHAT = 555
const STRANGER_CHAT = 999

const fakeKeystore = {
  encryptKey: (plain: string) => ({
    encryptedBase64: Buffer.from(plain).toString('base64'),
    preview: 'xx…xx',
  }),
  decryptKey: (stored: string) => Buffer.from(stored, 'base64').toString(),
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-remote-approval-'))
  db = openDatabase(join(dir, 'app.db'))
  calls = []

  let pendingUpdates = new Promise<unknown[]>((resolve) => {
    releaseUpdates = resolve
  })

  const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input)
    const method = url.slice(url.lastIndexOf('/') + 1).split('?')[0]
    if (method === 'getUpdates') {
      // Mimic a real long poll: it only resolves when the test says so.
      const updates = await pendingUpdates
      pendingUpdates = new Promise<unknown[]>((resolve) => {
        releaseUpdates = resolve
      })
      return jsonResponse({ ok: true, result: updates })
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ method, body })
    if (method === 'sendMessage') {
      return jsonResponse({ ok: true, result: { message_id: 77 } })
    }
    return jsonResponse({ ok: true, result: true })
  }) as unknown as typeof fetch

  manager = new ImBridgeManager({
    db,
    keystore: fakeKeystore,
    generateReply: async () => 'unused',
    fetchImpl,
  })
  manager.setTelegram({ token: 'bot-token', conversationId: 'conv-1', enabled: true })
  // Pair the owner chat (normally done by echoing the one-time code).
  db.settings.update({ telegramBridgeAllowedChatId: OWNER_CHAT, telegramBridgePairingCode: null })
})

afterEach(() => {
  manager.stopAll()
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

/** The token the bridge put in the Allow button of the last sendMessage. */
function lastToken(): string {
  const sent = [...calls].reverse().find((c) => c.method === 'sendMessage')
  const markup = sent?.body.reply_markup as
    | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
    | undefined
  const allow = markup?.inline_keyboard[0].find((b) => b.text === 'Allow once')
  return allow?.callback_data.slice(2) ?? ''
}

function tap(data: string, chatId = OWNER_CHAT): void {
  releaseUpdates([
    {
      update_id: calls.length + 1,
      callback_query: { id: 'cb-1', data, message: { message_id: 77, chat: { id: chatId } } },
    },
  ])
}

describe('remote approvals — availability', () => {
  it('is off until the user opts in, even with the bridge paired', () => {
    expect(manager.remoteApprovalsAvailable()).toBe(false)
  })

  it('is available once enabled, connected and paired', () => {
    db.settings.update({ remoteApprovalsEnabled: true })
    expect(manager.remoteApprovalsAvailable()).toBe(true)
  })

  it('is unavailable while no chat has paired', () => {
    db.settings.update({ remoteApprovalsEnabled: true, telegramBridgeAllowedChatId: null })
    expect(manager.remoteApprovalsAvailable()).toBe(false)
  })

  it('resolves to null (a decline) without sending anything when unavailable', async () => {
    const answer = await manager.requestApproval('req-1', { title: 'x', detail: 'y' })
    expect(answer).toBeNull()
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
  })
})

describe('remote approvals — answering', () => {
  beforeEach(() => {
    db.settings.update({ remoteApprovalsEnabled: true })
  })

  it('sends Allow/Deny buttons to the paired chat and resolves on the tap', async () => {
    const pending = manager.requestApproval('req-1', {
      title: 'run_shell_command',
      detail: 'npm test',
    })
    // Give the send a turn to land before reading the token.
    await new Promise((r) => setTimeout(r, 0))
    const sent = calls.find((c) => c.method === 'sendMessage')
    expect(sent?.body.chat_id).toBe(OWNER_CHAT)
    expect(String(sent?.body.text)).toContain('run_shell_command')

    tap(`a:${lastToken()}`)
    await expect(pending).resolves.toBe(true)
    // The buttons are rewritten so a second tap cannot land on a spent token.
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(true)
    expect(calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true)
  })

  it('resolves false on Deny', async () => {
    const pending = manager.requestApproval('req-1', { title: 't', detail: 'd' })
    await new Promise((r) => setTimeout(r, 0))
    tap(`d:${lastToken()}`)
    await expect(pending).resolves.toBe(false)
  })

  it('ignores a tap from any chat but the paired one', async () => {
    const pending = manager.requestApproval('req-1', { title: 't', detail: 'd' })
    await new Promise((r) => setTimeout(r, 0))
    const token = lastToken()

    tap(`a:${token}`, STRANGER_CHAT)
    await new Promise((r) => setTimeout(r, 10))
    // Still pending: a stranger's tap decided nothing…
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)

    // …and the owner's tap on the same token still works.
    tap(`a:${token}`)
    await expect(pending).resolves.toBe(true)
  })

  it('a spent token cannot be tapped a second time', async () => {
    const pending = manager.requestApproval('req-1', { title: 't', detail: 'd' })
    await new Promise((r) => setTimeout(r, 0))
    const token = lastToken()
    tap(`a:${token}`)
    await pending
    // The ack + rewrite for the FIRST tap land after the promise resolves;
    // let them settle before the log is cleared for the second tap.
    await new Promise((r) => setTimeout(r, 20))

    calls.length = 0
    tap(`a:${token}`)
    await new Promise((r) => setTimeout(r, 10))
    const toast = calls.find((c) => c.method === 'answerCallbackQuery')?.body.text
    expect(String(toast)).toMatch(/no longer waiting/i)
    // Nothing was rewritten — there is no live request to conclude.
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false)
  })

  it('redacts secret-looking detail before it leaves the machine', async () => {
    void manager.requestApproval('req-1', {
      title: 'fetch_url',
      detail: '{"key":"sk-abcdefghijklmnopqrstuvwxyz012345"}',
    })
    await new Promise((r) => setTimeout(r, 0))
    const text = String(calls.find((c) => c.method === 'sendMessage')?.body.text)
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })

  it('answering in the app cancels the Telegram twin', async () => {
    const pending = manager.requestApproval('req-1', { title: 't', detail: 'd' })
    await new Promise((r) => setTimeout(r, 0))
    manager.cancelApproval('req-1')
    await expect(pending).resolves.toBeNull()
    const edit = calls.find((c) => c.method === 'editMessageText')
    expect(String(edit?.body.text)).toMatch(/handled in the app/i)
  })

  it('never asks twice about the same request', async () => {
    void manager.requestApproval('req-1', { title: 't', detail: 'd' })
    await new Promise((r) => setTimeout(r, 0))
    const second = await manager.requestApproval('req-1', { title: 't', detail: 'd' })
    expect(second).toBeNull()
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1)
  })

  it('teardown resolves everything still waiting to null', async () => {
    const pending = manager.requestApproval('req-1', { title: 't', detail: 'd' })
    await new Promise((r) => setTimeout(r, 0))
    manager.stopAll()
    await expect(pending).resolves.toBeNull()
  })
})
