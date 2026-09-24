import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { createUldApi } from '@shared/api-client'

contextBridge.exposeInMainWorld('uld', createUldApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  subscribe: (channel, callback) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload as never)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
}))
