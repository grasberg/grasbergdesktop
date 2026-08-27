import { describe, expect, it } from 'vitest'
import { CHANNELS } from '@shared/ipc'
import type { IpcHandlerMap } from '../../../src/main/ipc/handler-map'
import { createRemoteRouter } from '../../../src/main/remote/router'

describe('remote router allowlist', () => {
  const handlers: IpcHandlerMap = new Map()
  handlers.set(CHANNELS.chatSend, async (req) => ({ echoed: req }))
  handlers.set(CHANNELS.convDelete, () => {
    throw new Error('boom')
  })
  handlers.set(CHANNELS.settingsGet, () => ({ dangerous: true }))
  const invoke = createRemoteRouter(handlers)

  it('runs an allowed channel through the shared handler', async () => {
    const result = await invoke(CHANNELS.chatSend, [{ conversationId: 'c1' }])
    expect(result).toEqual({
      ok: true,
      data: { echoed: { conversationId: 'c1' } },
    })
  })

  it('normalizes a throwing handler into an IpcResult error', async () => {
    const result = await invoke(CHANNELS.convDelete, ['c1'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toBe('boom')
      expect(result.error.retryable).toBe(false)
    }
  })

  it('blocks channels outside the allowlist, even registered ones', async () => {
    // settings:get IS a registered handler — the allowlist must still refuse.
    const result = await invoke(CHANNELS.settingsGet, [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('not available remotely')
  })

  it('blocks key management, terminal, git and destructive bulk channels', async () => {
    for (const channel of [
      CHANNELS.providersSetKey,
      CHANNELS.terminalCreate,
      CHANNELS.codeGitPush,
      CHANNELS.dataDeleteAllContent,
      CHANNELS.settingsUpdate,
      CHANNELS.backupImport,
    ]) {
      const result = await invoke(channel, [])
      expect(result.ok, channel).toBe(false)
    }
  })

  it('blocks unknown channels with the same error shape', async () => {
    const result = await invoke('made:up:channel', [])
    expect(result.ok).toBe(false)
  })

  it('allows the chat/approval/workflow surface', async () => {
    const allowed = [
      CHANNELS.chatSend,
      CHANNELS.convList,
      CHANNELS.convMessages,
      CHANNELS.chatStop,
      CHANNELS.chatRegenerate,
      CHANNELS.toolsApprovalRespond,
      CHANNELS.toolsQuestionRespond,
      CHANNELS.workflowsRunById,
      CHANNELS.inboxList,
    ]
    for (const channel of allowed) {
      // Either the handler runs (chat:send is registered above) or it is
      // reported unknown — never "not available remotely", which is the
      // allowlist's refusal and the one forbidden answer here.
      const result = await invoke(channel, [])
      if (result.ok) continue
      expect(result.error.message, channel).not.toContain('not available remotely')
    }
  })
})
