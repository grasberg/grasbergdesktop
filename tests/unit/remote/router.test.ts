import { describe, expect, it } from 'vitest'
import { CHANNELS } from '@shared/ipc'
import type { IpcHandlerMap } from '../../../src/main/ipc/handler-map'
import { createRemoteRouter } from '../../../src/main/remote/router'
import { currentInvocationPolicy } from '../../../src/main/invocation-context'

describe('remote router allowlist', () => {
  it('rejects private exports, indirect private resources and private attachments before dispatch', async () => {
    let calls = 0
    const channels = [CHANNELS.backupExport, CHANNELS.convExport, CHANNELS.botGroupSend, CHANNELS.codeCheckpointsList, CHANNELS.appSaveAttachmentAs]
    const handlers: IpcHandlerMap = new Map(channels.map(channel => [channel, () => { calls++; return 'private content' }]))
    const route = createRemoteRouter(handlers, {
      accessForDevice: () => 'full', isConversationRemotable: id => id !== 'private',
      conversationForResource: channel => channel === CHANNELS.botGroupSend ? 'private' : undefined,
      isAttachmentRemotable: key => key !== 'private-attachment',
    })
    for (const [channel, args] of [
      [CHANNELS.backupExport, [{ includePrivateSpaces: true }]],
      [CHANNELS.convExport, [{ conversationId: 'private', format: 'markdown' }]],
      [CHANNELS.botGroupSend, ['group', 'hello']],
      [CHANNELS.codeCheckpointsList, ['private']],
      [CHANNELS.appSaveAttachmentAs, [{ storageKey: 'private-attachment' }]],
    ] as Array<[string, unknown[]]>) expect((await route(channel, args, 'phone')).ok).toBe(false)
    expect(calls).toBe(0)
  })
  it('decodes bounded valid audio chunks and rejects malformed base64 before dispatch', async () => {
    const chunks: unknown[] = []
    const handlers: IpcHandlerMap = new Map([[CHANNELS.voiceSttChunk, input => { chunks.push(input); return true }]])
    const route = createRemoteRouter(handlers, { accessForDevice: () => 'full' })
    expect((await route(CHANNELS.voiceSttChunk, [{ sessionId: 'voice', chunkBase64: 'AQID' }], 'phone')).ok).toBe(true)
    expect(chunks).toEqual([{ sessionId: 'voice', chunk: new Uint8Array([1, 2, 3]) }])
    for (const chunkBase64 of ['@@@=', 'A', 'AQ==noise', 'A'.repeat(512 * 1024 + 4)]) expect((await route(CHANNELS.voiceSttChunk, [{ sessionId: 'voice', chunkBase64 }], 'phone')).ok).toBe(false)
    expect(chunks).toHaveLength(1)
  })
  it('grants full access per device, never grants itself and removes access immediately', async () => {
    let access: 'full' | 'limited' = 'full'
    const handlers: IpcHandlerMap = new Map<Parameters<IpcHandlerMap["set"]>[0], Parameters<IpcHandlerMap["set"]>[1]>([
      [CHANNELS.settingsGet, () => ({ theme: 'dark', appLockHash: 'private-hash', workflowWebhookToken: 'private-token', telegramBridgePairingCode: 'secret-code', outboundWebhookUrl: 'secret-url' })],
      [CHANNELS.remoteDeviceAccess, () => { throw new Error('Must never run remotely') }],
    ])
    const route = createRemoteRouter(handlers, { accessForDevice: id => id === 'trusted' ? access : 'limited' })
    expect((await route(CHANNELS.settingsGet, [], 'another')).ok).toBe(false)
    expect((await route(CHANNELS.settingsGet, [], 'trusted'))).toEqual({ ok: true, data: { theme: 'dark', appLockHash: null, workflowWebhookToken: null, telegramBridgePairingCode: null, outboundWebhookUrl: null } })
    expect((await route(CHANNELS.remoteDeviceAccess, [{ deviceId: 'trusted', access: 'full' }], 'trusted')).ok).toBe(false)
    expect((await route(CHANNELS.settingsUpdate, [{ remoteRelayUrl: 'https://example.com' }], 'trusted')).ok).toBe(false)
    access = 'limited'
    expect((await route(CHANNELS.settingsGet, [], 'trusted')).ok).toBe(false)
  })
  it('keeps private conversations and terminals excluded for fully granted devices', async () => {
    const handlers: IpcHandlerMap = new Map<Parameters<IpcHandlerMap["set"]>[0], Parameters<IpcHandlerMap["set"]>[1]>([
      [CHANNELS.agentRunsList, () => [{ id: 'run-a', conversationId: 'private', result: 'secret' }, { id: 'run-b', conversationId: 'public', result: 'visible' }]],
      [CHANNELS.terminalInput, () => true],
      [CHANNELS.arenaStatus, () => 'secret'],
    ])
    const route = createRemoteRouter(handlers, { accessForDevice: () => 'full', isConversationRemotable: id => id !== 'private', conversationForTerminal: id => id === 's-private' ? 'private' : 'public' })
    expect(await route(CHANNELS.agentRunsList, [], 'phone')).toEqual({ ok: true, data: [{ id: 'run-b', conversationId: 'public', result: 'visible' }] })
    expect((await route(CHANNELS.arenaStatus, ['private'], 'phone')).ok).toBe(false)
    expect((await route(CHANNELS.terminalInput, [{ sessionId: 's-private', data: 'dir' }], 'phone')).ok).toBe(false)
    expect((await route(CHANNELS.terminalInput, [{ sessionId: 's-public', data: 'dir' }], 'phone')).ok).toBe(true)
  })
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
      data: {
        echoed: {
          conversationId: 'c1',
          overrides: {
            params: { autoAcceptEdits: false, sandboxLevel: 'workspace-write' },
          },
        },
      },
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

  it('strips privilege-escalating ChatParams from remote convUpdate/chatSend', async () => {
    // A paired phone must not be able to turn on auto-accept or raise the
    // sandbox for itself; those keys are removed before the handler sees them,
    // while harmless params (temperature) pass through.
    const captured: unknown[] = []
    const map: IpcHandlerMap = new Map()
    map.set(CHANNELS.convUpdate, async (req) => {
      captured.push(req)
      return { ok: true }
    })
    map.set(CHANNELS.chatSend, async (req) => {
      captured.push(req)
      return { ok: true }
    })
    const run = createRemoteRouter(map)

    await run(CHANNELS.convUpdate, [
      { id: 'c1', patch: { params: { temperature: 0.5, autoAcceptEdits: true, sandboxLevel: 'full' } } },
    ])
    const patch = (captured[0] as { patch: { params: Record<string, unknown> } }).patch
    expect(patch.params).toEqual({ temperature: 0.5 })
    expect('autoAcceptEdits' in patch.params).toBe(false)
    expect('sandboxLevel' in patch.params).toBe(false)

    await run(CHANNELS.chatSend, [
      { conversationId: 'c1', content: 'hi', overrides: { params: { autoAcceptEdits: true, sandboxLevel: 'full' } } },
    ])
    const overrides = (captured[1] as { overrides: { params: Record<string, unknown> } }).overrides
    expect(overrides.params).toEqual({ autoAcceptEdits: false, sandboxLevel: 'workspace-write' })
  })

  it('strips budgetUsd from a remote convUpdate patch', async () => {
    // A stolen device token must not be able to lift spend guardrails (v44);
    // harmless patch fields still pass through.
    const captured: unknown[] = []
    const map: IpcHandlerMap = new Map()
    map.set(CHANNELS.convUpdate, async (req) => {
      captured.push(req)
      return { ok: true }
    })
    const run = createRemoteRouter(map)

    await run(CHANNELS.convUpdate, [
      { id: 'c1', patch: { title: 'renamed', budgetUsd: 999_999 } },
    ])
    const patch = (captured[0] as { patch: Record<string, unknown> }).patch
    expect(patch).toEqual({ title: 'renamed' })
    expect('budgetUsd' in patch).toBe(false)
  })

  it('keeps the trusted remote posture across async handler work', async () => {
    const map: IpcHandlerMap = new Map()
    map.set(CHANNELS.chatSend, async () => {
      await Promise.resolve()
      return currentInvocationPolicy()
    })
    const result = await createRemoteRouter(map)(CHANNELS.chatSend, [
      { conversationId: 'c1', content: 'hi' },
    ])
    expect(result).toEqual({
      ok: true,
      data: { origin: 'remote', autoAcceptEdits: false, sandboxLevel: 'workspace-write' },
    })
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
