import { BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import type { BridgeKind, BridgeReply, IpcEvents } from '@shared/ipc'

const REPLY_TIMEOUT_MS = 3000
const pending = new Map<string, (reply: BridgeReply) => void>()

export const uiWindow = (): BrowserWindow | undefined => BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())

function requestWindow(win: BrowserWindow, kind: BridgeKind): Promise<void> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve()
    }, REPLY_TIMEOUT_MS)
    pending.set(id, (reply) => {
      clearTimeout(timer)
      pending.delete(id)
      if (reply.ok) resolve()
      else reject(new Error(`The app could not save the user's pending edits (${reply.error ?? 'unknown error'}); ask the user to check the app, then retry.`))
    })
    const request: IpcEvents['bridge:request'] = { id, kind }
    win.webContents.send('bridge:request', request)
  })
}

export async function requestUi(kind: BridgeKind, except?: WebContents): Promise<void> {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && win.webContents.id !== except?.id)
  await Promise.all(windows.map((win) => requestWindow(win, kind)))
}

export function settleUi(reply: BridgeReply): void {
  pending.get(reply.id)?.(reply)
}
