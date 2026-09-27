import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import path from 'path'

const workers = new Set<number>()

export const markWorker = (win: BrowserWindow): void => {
  const id = win.webContents.id
  workers.add(id)
  win.once('closed', () => workers.delete(id))
}

export const isWorker = (contentsId: number): boolean => workers.has(contentsId)

export const uiWindows = (): BrowserWindow[] =>
  BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && !workers.has(win.webContents.id))

export function hardenedWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...options,
    webPreferences: {
      ...options.webPreferences,
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  return win
}

export function loadRenderer(win: BrowserWindow, hash?: string): Promise<void> {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) return win.loadURL(hash ? `${dev}#${hash}` : dev)
  return win.loadFile(path.join(__dirname, '../renderer/index.html'), hash ? { hash } : {})
}
