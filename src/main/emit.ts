import { BrowserWindow } from 'electron'
import type { EventChannel, IpcEvents } from '@shared/ipc'

export function emit<C extends EventChannel>(channel: C, payload: IpcEvents[C]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch (e) {
      console.warn(`emit ${channel}:`, e)
    }
  }
}
