export type RecordingPhase = 'idle' | 'arming' | 'countin' | 'recording' | 'preview'

export type RecordingGuard = 'allow' | 'cancel' | 'block' | 'decide'

export function recordingGuard(phase: RecordingPhase, hasClip: boolean): RecordingGuard {
  switch (phase) {
    case 'arming':
    case 'countin':
      return 'cancel'
    case 'recording':
      return 'block'
    case 'preview':
      return hasClip ? 'decide' : 'allow'
    default:
      return 'allow'
  }
}

export const MIC_IDLE_MS = 300_000
export const MIC_HIDDEN_MS = 30_000

export function micHoldMs(workVisible: boolean, windowHidden: boolean): number {
  if (!workVisible) return 0
  return windowHidden ? MIC_HIDDEN_MS : MIC_IDLE_MS
}
