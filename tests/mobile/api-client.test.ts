import { expect, it, vi } from 'vitest'
import { remoteApi, type RemoteHost } from '../../src/mobile/full/remote-api'
import { CHANNELS, type IpcResult } from '../../src/shared/ipc'

it('omits optional arguments before the remote JSON round trip but preserves explicit nulls', async () => {
  const request = vi.fn(async (_channel: string, _args: unknown[] = []): Promise<IpcResult<unknown>> => ({ ok: true, data: [] }))
  const host: RemoteHost = { request: <T>(channel: string, args?: unknown[]) => request(channel, args) as Promise<IpcResult<T>>, subscribe: () => () => {}, draftKey: 'test', capabilities: () => ({ revision: 2, access: 'full', requestChannels: [CHANNELS.projectsList, CHANNELS.backupExport, CHANNELS.convUpdate], pushChannels: [], maxUploadBytes: 1024, chunkBytes: 128 }) }
  const api = remoteApi(host)
  await api.projects.list()
  expect(request).toHaveBeenLastCalledWith(CHANNELS.projectsList, [])
  await api.backup.export()
  expect(request).toHaveBeenLastCalledWith(CHANNELS.backupExport, [])
  await api.conversations.update({ id: 'chat', patch: { providerId: null } })
  expect(request).toHaveBeenLastCalledWith(CHANNELS.convUpdate, [{ id: 'chat', patch: { providerId: null } }])
})
