import { app } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateEvent, UpdateStatus } from '@shared/updater'
import {
  AUTO_INSTALL_ON_APP_QUIT,
  initialUpdateStatus,
  reduceUpdateStatus,
  shouldCheckForUpdates,
} from '@shared/updater'

let status = initialUpdateStatus(app.getVersion())
let enabled = false
let publishStatus: (status: UpdateStatus) => void = () => undefined

function transition(event: UpdateEvent): void {
  status = reduceUpdateStatus(status, event)
  publishStatus(status)
}

export function initializeUpdater(onStatus: (status: UpdateStatus) => void): void {
  publishStatus = onStatus
  enabled = shouldCheckForUpdates(app.isPackaged, process.platform)
  if (!enabled) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = AUTO_INSTALL_ON_APP_QUIT
  autoUpdater.on('checking-for-update', () => transition({ type: 'check' }))
  autoUpdater.on('update-available', (info: UpdateInfo) =>
    transition({ type: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', () => transition({ type: 'not-available' }))
  autoUpdater.on('download-progress', (info: ProgressInfo) =>
    transition({ type: 'progress', percent: info.percent })
  )
  autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
    transition({ type: 'downloaded', version: info.version })
  )
  autoUpdater.on('error', (error: Error) => transition({ type: 'error', message: error.message }))

  void checkForUpdates()
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!enabled || status.phase === 'ready') return status
  transition({ type: 'check' })
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    transition({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
  return status
}

export function restartToUpdate(): void {
  if (enabled && status.phase === 'ready') autoUpdater.quitAndInstall()
}
