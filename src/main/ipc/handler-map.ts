/**
 * The handler map: every request/response IPC channel as a plain function.
 *
 * register.ts collects them while wiring IPC; ipcMain gets one wrapper per
 * entry that normalizes results to IpcResult. The remote service (the phone
 * tunnel) invokes the SAME functions with its own allowlist, so a remote
 * request and a renderer request run identical code — no second validation
 * layer to drift out of sync.
 *
 * This module must stay free of Electron imports: the remote service and its
 * unit tests run in plain Node, and importing register.ts here would pull
 * `electron` in with it.
 */

import { err, ok, type ChannelName, type IpcResult } from '@shared/ipc'
import type { NormalizedError } from '@shared/types'
import { toNormalizedError } from '../providers/errors'

/** One registered request handler: raw args in, result or throw out. */
export type IpcHandler = (...args: unknown[]) => unknown

export type IpcHandlerMap = Map<ChannelName, IpcHandler>

/**
 * Invokes one handler with the same normalization ipcMain applies: a throw
 * becomes an IpcResult error, never an exception crossing the boundary.
 */
export async function callIpcHandler(
  handlers: IpcHandlerMap,
  channel: ChannelName,
  args: unknown[]
): Promise<IpcResult<unknown>> {
  const fn = handlers.get(channel)
  if (!fn) {
    return err({
      code: 'not_supported',
      message: 'Unknown channel.',
      retryable: false,
    } satisfies NormalizedError)
  }
  try {
    return ok(await fn(...args))
  } catch (e) {
    return err(toNormalizedError(e))
  }
}
