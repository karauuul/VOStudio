import type { EventChannel, IpcApi, IpcEvents } from '@shared/ipc'

type WindowApi = { [C in keyof IpcApi]: IpcApi[C] } & {
  on<C extends EventChannel>(channel: C, cb: (payload: IpcEvents[C]) => void): () => void
}

export const api = (window as unknown as { api: WindowApi }).api

export function audioUrl(absPath: string): string {
  return 'vostudio://audio/' + encodeURIComponent(btoa(unescape(encodeURIComponent(absPath))))
}
