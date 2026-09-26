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
