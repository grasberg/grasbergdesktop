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

/** Builds the phone-side invoker: allowlist first, then the shared handler. */
export function createRemoteRouter(handlers: IpcHandlerMap): RemoteRequestInvoker {
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
    return callIpcHandler(handlers, channel as ChannelName, args)
  }
}
