import { BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import type { BridgeAsk, BridgeReply, BridgeRequest } from '@shared/ipc'

const REPLY_TIMEOUT_MS = 3000
const pending = new Map<string, (reply: BridgeReply) => void>()

export const uiWindow = (): BrowserWindow | undefined => BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())

const failure = (ask: BridgeAsk, reason: string): Error =>
  new Error(
    ask.kind === 'flush'
      ? `The app could not save the user's pending edits (${reason}); ask the user to check the app, then retry.`
      : `${reason}; ask the user to finish it in the app, then retry.`
  )

function requestWindow(win: BrowserWindow, ask: BridgeAsk): Promise<void> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(failure(ask, 'the app did not answer within 3 s'))
    }, REPLY_TIMEOUT_MS)
    pending.set(id, (reply) => {
      clearTimeout(timer)
      pending.delete(id)
      if (reply.ok) resolve()
      else reject(failure(ask, reply.error ?? 'unknown error'))
    })
    const request: BridgeRequest = { ...ask, id }
    win.webContents.send('bridge:request', request)
  })
}

export async function requestUi(ask: BridgeAsk, except?: WebContents): Promise<void> {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && win.webContents.id !== except?.id)
  await Promise.all(windows.map((win) => requestWindow(win, ask)))
}

export function settleUi(reply: BridgeReply): void {
  pending.get(reply.id)?.(reply)
}
