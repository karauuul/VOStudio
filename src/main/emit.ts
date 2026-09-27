import type { WebContents } from 'electron'
import type { EventChannel, IpcEvents } from '@shared/ipc'
import { uiWindows } from './windows'

export function emit<C extends EventChannel>(channel: C, payload: IpcEvents[C], except?: WebContents): void {
  for (const win of uiWindows()) {
    if (win.webContents.id === except?.id) continue
    try {
      win.webContents.send(channel, payload)
    } catch (e) {
      console.warn(`emit ${channel}:`, e)
    }
  }
}
