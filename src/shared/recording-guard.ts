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
