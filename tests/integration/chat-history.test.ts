/**
 * End-to-end chat turn over the real db + adapter (no Electron): persist a
 * user message, stream an assistant reply from a mocked SSE endpoint,
 * persist it, then exercise edit-and-rerun semantics at the repo level.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message, TokenUsage } from '@shared/types'
import { openDatabase, type AppDatabase } from '../../src/main/db/database'
import { OpenAICompatibleAdapter } from '../../src/main/providers/openai-compatible'
import type { AdapterChatRequest, AdapterMessage } from '../../src/main/providers/adapter'
import { makeFetchSequence, makeSSEResponse, type FetchMock } from '../helpers/mock-fetch'

let dir: string
let db: AppDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uld-int-test-'))
  db = openDatabase(join(dir, 'app.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function assistantStream(parts: string[], usage?: TokenUsage): FetchMock {
  const chunks = parts.map((text) => sse({ choices: [{ delta: { content: text } }] }))
  if (usage) {
    chunks.push(
      sse({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        },
      })
    )
  } else {
    chunks.push(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
  }
  chunks.push('data: [DONE]\n\n')
  return makeFetchSequence(makeSSEResponse(chunks))
}

/** Runs one streamed turn against the adapter and persists the assistant message. */
async function runAssistantTurn(
  conversationId: string,
  history: AdapterMessage[],
  fetchImpl: FetchMock
): Promise<Message> {
  const adapter = new OpenAICompatibleAdapter()
  const req: AdapterChatRequest = {
    modelId: 'test-model',
    messages: history,
    params: {},
    stream: true,
  }
  let content = ''
  let usage: TokenUsage | undefined
  for await (const ev of adapter.chatStream(req, {
    apiKey: 'sk-test-integration-key',
    baseUrl: 'https://api.example.com/v1',
    fetchImpl,
  })) {
    if (ev.type === 'text') content += ev.text
    if (ev.type === 'usage') usage = ev.usage
  }

  const message: Message = {
    id: randomUUID(),
    conversationId,
    role: 'assistant',
    content,
    status: 'complete',
    modelId: 'test-model',
    usage,
    seq: db.messages.nextSeq(conversationId),
    createdAt: Date.now(),
  }
  db.messages.insert(message)
  return message
}

describe('chat turn end-to-end (db + adapter)', () => {
  it('persists a full user/assistant exchange with streamed content', async () => {
    const conv = db.conversations.create({ mode: 'chat', title: 'Integration' })

    const userMessage: Message = {
      id: randomUUID(),
      conversationId: conv.id,
      role: 'user',
      content: 'What is the answer?',
      status: 'complete',
      seq: db.messages.nextSeq(conv.id),
      createdAt: Date.now(),
    }
    db.messages.insert(userMessage)
    expect(userMessage.seq).toBe(1)

    const fetchImpl = assistantStream(['The answer', ' is ', '42.'], {
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    })
    const assistant = await runAssistantTurn(
      conv.id,
      [{ role: 'user', content: userMessage.content }],
      fetchImpl
    )

    // The mocked endpoint received the persisted history.
    const sentBody = fetchImpl.requests[0].body as { messages: unknown; stream: boolean }
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'What is the answer?' }])
    expect(sentBody.stream).toBe(true)

    const listed = db.messages.listByConversation(conv.id)
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({
      role: 'user',
      content: 'What is the answer?',
      status: 'complete',
      seq: 1,
    })
    expect(listed[1]).toMatchObject({
      id: assistant.id,
      role: 'assistant',
      content: 'The answer is 42.',
      status: 'complete',
      seq: 2,
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    })
  })

  it('supports edit-and-rerun: update user message, deleteAfterSeq, new assistant reply', async () => {
    const conv = db.conversations.create({ mode: 'chat', title: 'Edit-rerun' })
    const userMessage: Message = {
      id: randomUUID(),
      conversationId: conv.id,
      role: 'user',
      content: 'Tell me about cats',
      status: 'complete',
      seq: db.messages.nextSeq(conv.id),
      createdAt: Date.now(),
    }
    db.messages.insert(userMessage)
    await runAssistantTurn(
      conv.id,
      [{ role: 'user', content: userMessage.content }],
      assistantStream(['Cats are mammals.'])
    )
    expect(db.messages.listByConversation(conv.id)).toHaveLength(2)

    // --- user edits their message and reruns ---
    const edited = db.messages.update(userMessage.id, { content: 'Tell me about dogs' })
    expect(edited).toMatchObject({ id: userMessage.id, content: 'Tell me about dogs', seq: 1 })

    const removed = db.messages.deleteAfterSeq(conv.id, userMessage.seq)
    expect(removed).toBe(1) // the old assistant reply

    const rerun = await runAssistantTurn(
      conv.id,
      [{ role: 'user', content: edited!.content }],
      assistantStream(['Dogs are ', 'loyal.'])
    )
    expect(rerun.seq).toBe(2) // seq space reused after the delete

    const listed = db.messages.listByConversation(conv.id)
    expect(listed.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Tell me about dogs'],
      ['assistant', 'Dogs are loyal.'],
    ])
    expect(listed[1].id).not.toBe(userMessage.id)
  })
})
