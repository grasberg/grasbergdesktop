/**
 * The phone's view of the app: an explicit allowlist of IPC channels a paired
 * device may invoke, plus the push channels forwarded to it.
 *
 * Existing pairs retain the limited chat and approval surface. Full access is
 * a per-device desktop grant checked on every request; the additional channels
 * are reviewed in capabilities.ts. Private chats, stored secrets and granting
 * further devices remain desktop-only. No wildcard forwards arbitrary IPC.
 */

import { CHANNELS, type ChannelName } from '@shared/ipc'
import { callIpcHandler, type IpcHandlerMap } from '../ipc/handler-map'
import { withInvocationPolicy } from '../invocation-context'
import { FULL_REMOTE_CHANNELS, FULL_REMOTE_PUSH_CHANNELS, remoteSafeData } from './capabilities'
import type { RemoteCapabilities } from '@shared/remote-protocol'

export const REMOTE_REQUEST_CHANNELS: ReadonlySet<ChannelName> = new Set([
  // app
  CHANNELS.appGetInfo,
  CHANNELS.remoteCapabilities,
  // conversations (read + organize + run)
  CHANNELS.convList,
  CHANNELS.convCreate,
  CHANNELS.convGet,
  CHANNELS.convUpdate,
  CHANNELS.convDelete,
  CHANNELS.convMessages,
  CHANNELS.convFork,
  CHANNELS.projectsList,
  // chat generation (full streaming via the push channel)
  CHANNELS.chatSend,
  CHANNELS.chatStop,
  CHANNELS.chatRegenerate,
  CHANNELS.chatEditAndRerun,
  CHANNELS.chatPickCompareWinner,
  CHANNELS.chatCompact,
  // answering approvals/questions raised by runs
  CHANNELS.toolsApprovalRespond,
  CHANNELS.toolsPending,
  CHANNELS.toolsQuestionRespond,
  // workflows: list/run/watch
  CHANNELS.workflowsList,
  CHANNELS.workflowsGet,
  CHANNELS.workflowsRunById,
  CHANNELS.workflowsRuns,
  CHANNELS.workflowsOverview,
  // background results + cost
  CHANNELS.inboxList,
  CHANNELS.inboxMarkReviewed,
  CHANNELS.usageSummary,
  // bridge status (harmless, read-only)
  CHANNELS.imStatus,
])

/**
 * Push channels forwarded to online devices. Everything the phone can act on
 * needs its event; terminal output is excluded (chatty, and the phone has no
 * terminal surface in v1).
 */
export const REMOTE_PUSH_CHANNELS: ReadonlySet<string> = new Set([
  CHANNELS.streamEvent,
  CHANNELS.toolApprovalRequest,
  CHANNELS.toolApprovalSettled,
  CHANNELS.userQuestionRequest,
  CHANNELS.userQuestionSettled,
  CHANNELS.conversationsChanged,
  CHANNELS.workflowRunFinished,
  CHANNELS.scheduledTasksChanged,
  CHANNELS.toolRulesChanged,
  CHANNELS.mainNotice,
  CHANNELS.codeChangesChanged,
  CHANNELS.mcpServersChanged,
  CHANNELS.arenaChanged,
  CHANNELS.optimizerChanged,
  CHANNELS.remoteCapabilitiesChanged,
])

export type RemoteRequestInvoker = (
  channel: string,
  args: unknown[]
  , deviceId?: string
) => ReturnType<typeof callIpcHandler>

/**
 * Execution-posture params a remote device must NOT be able to set for itself.
 * The phone is confined to the channel allowlist above, but two of those
 * channels (convUpdate, chatSend) carry a full ChatParams object, and two of
 * its fields — autoAcceptEdits and sandboxLevel — decide whether file-mutating
 * tools run WITHOUT an approval dialog and how far the shell may reach. The
 * phone answers approvals interactively (toolsApprovalRespond is allowlisted),
 * so it never needs to raise these; letting it would turn a stolen device token
 * into un-prompted writes.
 */
const REMOTE_STRIPPED_PARAM_KEYS = ['autoAcceptEdits', 'sandboxLevel'] as const

function withSafeParams(container: Record<string, unknown>, key: string): Record<string, unknown> {
  const inner = container[key]
  if (!inner || typeof inner !== 'object') return container
  const params = inner as Record<string, unknown>
  if (!REMOTE_STRIPPED_PARAM_KEYS.some((k) => k in params)) return container
  const safe = { ...params }
  for (const k of REMOTE_STRIPPED_PARAM_KEYS) delete safe[k]
  return { ...container, [key]: safe }
}

/** Removes privilege-escalating ChatParams from convUpdate/chatSend requests. */
function sanitizeRemoteArgs(channel: ChannelName, args: unknown[]): unknown[] {
  const req = args[0]
  if (!req || typeof req !== 'object') return args
  if (channel === CHANNELS.convList || channel === CHANNELS.convCreate) {
    // The phone always operates in the default space: it can neither list a
    // private space nor create into one (private-space conversations are not
    // remotely addressable at all — see the extractor table below).
    const r = req as Record<string, unknown>
    if ('spaceId' in r) {
      const { spaceId: _stripped, ...safe } = r
      return [safe, ...args.slice(1)]
    }
  } else if (channel === CHANNELS.convUpdate) {
    const r = req as Record<string, unknown>
    const patch = r.patch
    if (patch && typeof patch === 'object') {
      // budgetUsd is stripped too (the remote-param-strip discipline): a
      // stolen device token must not be able to lift spend guardrails.
      const { budgetUsd: _stripped, ...safePatch } = patch as Record<string, unknown>
      return [{ ...r, patch: withSafeParams(safePatch, 'params') }, ...args.slice(1)]
    }
  } else if (channel === CHANNELS.chatSend) {
    const r = req as Record<string, unknown>
    const overrides =
      r.overrides && typeof r.overrides === 'object'
        ? (r.overrides as Record<string, unknown>)
        : {}
    const currentParams =
      overrides.params && typeof overrides.params === 'object'
        ? (overrides.params as Record<string, unknown>)
        : {}
    return [
      {
        ...r,
        overrides: {
          ...overrides,
          params: { ...currentParams, autoAcceptEdits: false, sandboxLevel: 'workspace-write' },
        },
      },
      ...args.slice(1),
    ]
  }
  return args
}

/**
 * Where each conversation-addressed remote channel carries its conversation
 * id. Every channel here is checked against `isConversationRemotable` before
 * invocation, so a private-space conversation is unreachable by id even when
 * the id leaked somehow. chatStop stays unlisted: an unguessable streamId
 * with no content.
 */
const REMOTE_CONVERSATION_REF: Partial<Record<ChannelName, (args: unknown[]) => unknown>> = {
  [CHANNELS.convExport]: args => (args[0] as { conversationId?: unknown } | undefined)?.conversationId,
  [CHANNELS.codeCheckpointsList]: args => args[0],
  [CHANNELS.imSetTelegram]: args => (args[0] as { conversationId?: unknown } | undefined)?.conversationId,
  [CHANNELS.convDraftGet]: args => args[0],
  [CHANNELS.convDraftSave]: args => (args[0] as { conversationId?: unknown } | undefined)?.conversationId,
  [CHANNELS.convForkLineage]: args => args[0],
  [CHANNELS.terminalCreate]: args => args[0],
  [CHANNELS.agentRunsList]: args => args[0],
  [CHANNELS.usageConversationCost]: args => args[0],
  [CHANNELS.arenaStart]: args => (args[0] as { conversationId?: unknown } | undefined)?.conversationId,
  [CHANNELS.arenaApply]: args => (args[0] as { conversationId?: unknown } | undefined)?.conversationId,
  [CHANNELS.arenaStatus]: args => args[0],
  [CHANNELS.arenaStop]: args => args[0],
  [CHANNELS.arenaDiscard]: args => args[0],
  [CHANNELS.codeTurnRevert]: args => (args[0] as { conversationId?: unknown } | undefined)?.conversationId,
  [CHANNELS.convGet]: (args) => args[0],
  [CHANNELS.convDelete]: (args) => args[0],
  [CHANNELS.convMessages]: (args) => args[0],
  [CHANNELS.chatCompact]: (args) => args[0],
  [CHANNELS.convUpdate]: (args) => (args[0] as { id?: unknown } | undefined)?.id,
  [CHANNELS.convFork]: (args) => (args[0] as { id?: unknown } | undefined)?.id,
  [CHANNELS.chatSend]: (args) =>
    (args[0] as { conversationId?: unknown } | undefined)?.conversationId,
  [CHANNELS.chatRegenerate]: (args) =>
    (args[0] as { conversationId?: unknown } | undefined)?.conversationId,
  [CHANNELS.chatEditAndRerun]: (args) =>
    (args[0] as { conversationId?: unknown } | undefined)?.conversationId,
  [CHANNELS.chatPickCompareWinner]: (args) =>
    (args[0] as { conversationId?: unknown } | undefined)?.conversationId,
}

export interface RemoteRouterOptions {
  accessForDevice?: (deviceId: string) => 'limited' | 'full'
  conversationForTerminal?: (sessionId: string) => string | undefined
  conversationForResource?: (channel: string, args: unknown[]) => string | null | undefined
  isAttachmentRemotable?: (storageKey: string) => boolean
  /** False = the conversation lives in a private space (never remotable). */
  isConversationRemotable?: (conversationId: string) => boolean
}

export function excludePrivateData(value: unknown, visible: (id: string) => boolean): unknown {
  if (Array.isArray(value)) return value.map(v => excludePrivateData(v, visible)).filter(v => v !== undefined)
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  if (typeof object.conversationId === 'string' && !visible(object.conversationId)) return undefined
  if (typeof object.id === 'string' && ('spaceId' in object || 'mode' in object) && !visible(object.id)) return undefined
  return Object.fromEntries(Object.entries(object).map(([key, v]) => [key, excludePrivateData(v, visible)]))
}

export function remoteCapabilities(access: 'limited' | 'full'): RemoteCapabilities {
  return { revision: 2, access, requestChannels: [...new Set([...REMOTE_REQUEST_CHANNELS, ...(access === 'full' ? FULL_REMOTE_CHANNELS : [])])], pushChannels: [...new Set([...REMOTE_PUSH_CHANNELS, ...(access === 'full' ? FULL_REMOTE_PUSH_CHANNELS : [])])], maxUploadBytes: 64 * 1024 * 1024, chunkBytes: 128 * 1024 }
}

/**
 * Whether one push may be forwarded to paired phones. Payloads that name a
 * private-space conversation are dropped before sealing; everything else (and
 * payloads with no conversation reference) passes.
 */
export function remotePushAllowed(
  channel: string,
  payload: unknown,
  isConversationRemotable: (conversationId: string) => boolean
): boolean {
  if (!payload || typeof payload !== 'object') return true
  const p = payload as Record<string, unknown>
  let conversationId: unknown = p.conversationId
  if (channel === CHANNELS.arenaChanged) {
    conversationId = (p.arena as { conversationId?: unknown } | undefined)?.conversationId
  }
  if (typeof conversationId !== 'string') return true
  return isConversationRemotable(conversationId)
}

/** Builds the phone-side invoker: allowlist first, then the shared handler. */
export function createRemoteRouter(
  handlers: IpcHandlerMap,
  opts?: RemoteRouterOptions
): RemoteRequestInvoker {
  return async (channel, args, deviceId) => {
    const access = deviceId ? opts?.accessForDevice?.(deviceId) ?? 'limited' : 'limited'
    const unavailable = { ok: false as const, error: { code: 'not_supported' as const, message: 'This operation is available only on your desktop.', retryable: false } }
    if (channel === CHANNELS.backupExport && (args[0] as { includePrivateSpaces?: unknown } | undefined)?.includePrivateSpaces === true) return unavailable
    if (channel === CHANNELS.settingsUpdate && args[0] && typeof args[0] === 'object' && ['remoteAccessEnabled', 'remoteRelayUrl', 'remoteClientUrl', 'remoteDesktopId', 'appLockHash', 'voiceWhisperBinaryPath', 'workflowWebhookToken', 'telegramBridgePairingCode'].some(key => key in (args[0] as object))) return unavailable
    if (channel === CHANNELS.terminalInput || channel === CHANNELS.terminalDispose) {
      const sessionId = channel === CHANNELS.terminalInput ? (args[0] as { sessionId?: string } | undefined)?.sessionId : args[0]
      const conversationId = typeof sessionId === 'string' ? opts?.conversationForTerminal?.(sessionId) : undefined
      if (!conversationId || opts?.isConversationRemotable?.(conversationId) === false) return unavailable
    }
    if (channel === CHANNELS.remoteCapabilities) return { ok: true, data: remoteCapabilities(access) }
    if (!REMOTE_REQUEST_CHANNELS.has(channel as ChannelName) && !(access === 'full' && FULL_REMOTE_CHANNELS.has(channel as ChannelName))) {
      return Promise.resolve({
        ok: false as const,
        error: {
          code: 'not_supported' as const,
          message: 'That channel is not available remotely.',
          retryable: false,
        },
      })
    }
    const ref = REMOTE_CONVERSATION_REF[channel as ChannelName]?.(args)
    const resourceRef = opts?.conversationForResource?.(channel, args)
    const attachmentKey = channel === CHANNELS.appReadAttachment ? args[0] : channel === CHANNELS.appExtractAttachmentText || channel === CHANNELS.appSaveAttachmentAs || channel === CHANNELS.voiceTranscribeAttachment ? (args[0] as { storageKey?: unknown } | undefined)?.storageKey : undefined
    if (typeof attachmentKey === 'string' && opts?.isAttachmentRemotable?.(attachmentKey) === false) return unavailable
    if ([ref, resourceRef].some(id => typeof id === 'string' && opts?.isConversationRemotable?.(id) === false)) {
      return Promise.resolve({
        ok: false as const,
        error: {
          code: 'not_supported' as const,
          message: 'That conversation is not available remotely.',
          retryable: false,
        },
      })
    }
    let transportArgs = args
    if (channel === CHANNELS.voiceSttChunk) {
      const input = args[0] as { chunkBase64?: unknown; sessionId?: unknown } | undefined
      const encoded = input?.chunkBase64
      if (typeof encoded !== 'string' || encoded.length > 512 * 1024 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        return { ok: false, error: { code: 'invalid_request', message: 'Invalid audio chunk. Record again.', retryable: false } }
      }
      transportArgs = [{ sessionId: input?.sessionId, chunk: new Uint8Array(Buffer.from(encoded, 'base64')) }]
    }
    const result = await withInvocationPolicy(
      { origin: 'remote', deviceId, autoAcceptEdits: false, sandboxLevel: 'workspace-write' },
      () =>
        callIpcHandler(
          handlers,
          channel as ChannelName,
          sanitizeRemoteArgs(channel as ChannelName, transportArgs)
        )
    )
    if (channel === CHANNELS.toolsPending && result.ok && opts?.isConversationRemotable) {
      const data = result.data as { approvals: Array<{ conversationId: string }>; questions: Array<{ conversationId: string }> }
      const visible = (r: { conversationId: string }): boolean => opts.isConversationRemotable!(r.conversationId)
      return { ok: true as const, data: { approvals: data.approvals.filter(visible), questions: data.questions.filter(visible) } }
    }
    if (result.ok && channel === CHANNELS.lockStatus) return { ok: true, data: { ...(result.data as object), locked: false } }
    return result.ok ? { ok: true, data: remoteSafeData(channel, opts?.isConversationRemotable ? excludePrivateData(result.data, opts.isConversationRemotable) : result.data) } : result
  }
}
