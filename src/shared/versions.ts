export function restoreBlock(state: { exporting: boolean; recording: boolean; busy: boolean }): string | null {
  if (state.exporting) return 'Export in progress'
  if (state.recording) return 'Stop the recording first'
  if (state.busy) return 'Generation is still running'
  return null
}
