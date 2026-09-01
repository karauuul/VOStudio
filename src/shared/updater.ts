export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error'

export const AUTO_INSTALL_ON_APP_QUIT = false

export interface UpdateStatus {
  currentVersion: string
  phase: UpdatePhase
  availableVersion?: string
  percent?: number
  error?: string
}

export type UpdateEvent =
  | { type: 'check' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }

export function initialUpdateStatus(currentVersion: string): UpdateStatus {
  return { currentVersion, phase: 'idle' }
}

export function reduceUpdateStatus(state: UpdateStatus, event: UpdateEvent): UpdateStatus {
  switch (event.type) {
    case 'check':
      return { currentVersion: state.currentVersion, phase: 'checking' }
    case 'available':
      return { ...state, phase: 'available', availableVersion: event.version, percent: 0 }
    case 'not-available':
      return { currentVersion: state.currentVersion, phase: 'up-to-date' }
    case 'progress':
      return {
        ...state,
        phase: 'downloading',
        percent: Math.max(0, Math.min(100, event.percent)),
      }
    case 'downloaded':
      return { ...state, phase: 'ready', availableVersion: event.version, percent: 100 }
    case 'error':
      return { currentVersion: state.currentVersion, phase: 'error', error: event.message }
  }
}

export function shouldCheckForUpdates(isPackaged: boolean, platform: NodeJS.Platform): boolean {
  return isPackaged && platform === 'win32'
}
