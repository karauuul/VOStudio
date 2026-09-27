import { ipcMain, type WebContents } from 'electron'
import type { IpcApi, IpcChannel } from '@shared/ipc'

export function typedHandle<C extends IpcChannel>(
  channel: C,
  handler: (...args: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]>
): void {
  ipcMain.handle(channel, (_event, ...args) => (handler as (...a: unknown[]) => unknown)(...args))
}

export function typedHandleFrom<C extends IpcChannel>(
  channel: C,
  handler: (sender: WebContents, ...args: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]>
): void {
  ipcMain.handle(channel, (event, ...args) =>
    (handler as (sender: WebContents, ...a: unknown[]) => unknown)(event.sender, ...args)
  )
}
