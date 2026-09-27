import { BrowserWindow, type WebContents } from 'electron'
import type { EventChannel, IpcEvents } from '@shared/ipc'

export function emit<C extends EventChannel>(channel: C, payload: IpcEvents[C], except?: WebContents): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.id === except?.id) continue
    try {
      win.webContents.send(channel, payload)
    } catch (e) {
      console.warn(`emit ${channel}:`, e)
    }
  }
}
