/**
 * The phone's view of the app: an explicit allowlist of IPC channels a paired
 * device may invoke, plus the push channels forwarded to it.
 *
 * The phone IS the owner's trusted device — but it is a browser on a network
 * the desktop does not control, so the surface stays minimal on principle:
 * conversations and chat (read/run), approvals (answer), workflows (run), and
 * read-only status. Deliberately OUT: settings (they carry pairing codes and
 * endpoint tokens), provider/key management, the filesystem and git surfaces,
 * the terminal, and every destructive bulk operation. Adding a channel is a
 * one-line, reviewable decision — never a wildcard.
 */

import { CHANNELS, type ChannelName } from '@shared/ipc'
import { callIpcHandler, type IpcHandlerMap } from '../ipc/handler-map'
import { withInvocationPolicy } from '../invocation-context'

export const REMOTE_REQUEST_CHANNELS: ReadonlySet<ChannelName> = new Set([
  // app
  CHANNELS.appGetInfo,
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
])

export type RemoteRequestInvoker = (
  channel: string,
  args: unknown[]
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
  /** False = the conversation lives in a private space (never remotable). */
  isConversationRemotable?: (conversationId: string) => boolean
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
  return (channel, args) => {
    if (!REMOTE_REQUEST_CHANNELS.has(channel as ChannelName)) {
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
    if (typeof ref === 'string' && opts?.isConversationRemotable?.(ref) === false) {
      return Promise.resolve({
        ok: false as const,
        error: {
          code: 'not_supported' as const,
          message: 'That conversation is not available remotely.',
          retryable: false,
        },
      })
    }
    return withInvocationPolicy(
      { origin: 'remote', autoAcceptEdits: false, sandboxLevel: 'workspace-write' },
      () =>
        callIpcHandler(
          handlers,
          channel as ChannelName,
          sanitizeRemoteArgs(channel as ChannelName, args)
        )
    )
  }
}
