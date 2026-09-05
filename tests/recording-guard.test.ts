import { describe, expect, it } from 'vitest'
import { recordingGuard, type RecordingPhase } from '../src/shared/recording-guard'

describe('recordingGuard', () => {
  it('idle never blocks', () => {
    expect(recordingGuard('idle', false)).toBe('allow')
    expect(recordingGuard('idle', true)).toBe('allow')
  })

  it('arming and count-in are cancelled immediately', () => {
    expect(recordingGuard('arming', false)).toBe('cancel')
    expect(recordingGuard('countin', false)).toBe('cancel')
  })

  it('an active capture blocks the transition', () => {
    expect(recordingGuard('recording', false)).toBe('block')
    expect(recordingGuard('recording', true)).toBe('block')
  })

  it('an unsaved preview asks for a decision', () => {
    expect(recordingGuard('preview', true)).toBe('decide')
  })

  it('a preview without a clip has nothing to lose', () => {
    expect(recordingGuard('preview', false)).toBe('allow')
  })

  it('every phase is covered', () => {
    const phases: RecordingPhase[] = ['idle', 'arming', 'countin', 'recording', 'preview']
    for (const p of phases) expect(recordingGuard(p, true)).toBeTruthy()
  })
})
