export function restoreBlock(state: {
  exporting: boolean
  recording: boolean
  busy: boolean
  syncing?: boolean
}): string | null {
  if (state.exporting) return 'Export in progress'
  if (state.syncing) return 'CSV sync in progress'
  if (state.recording) return 'Stop the recording first'
  if (state.busy) return 'Generation is still running'
  return null
}

export const GUARD_VERSION_MS = 10 * 60 * 1000

export function needsGuardVersion(versions: readonly { createdAt: string }[], now: number): boolean {
  const last = Date.parse(versions[versions.length - 1]?.createdAt ?? '')
  return !(Number.isFinite(last) && now - last < GUARD_VERSION_MS)
}
