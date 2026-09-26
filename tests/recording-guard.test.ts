import { describe, expect, it } from 'vitest'
import {
  MIC_HIDDEN_MS,
  MIC_IDLE_MS,
  micHoldMs,
  recordingGuard,
  type RecordingPhase,
} from '../src/shared/recording-guard'

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

describe('micHoldMs', () => {
  it('closes the microphone at once outside the Work room', () => {
    expect(micHoldMs(false, false)).toBe(0)
    expect(micHoldMs(false, true)).toBe(0)
  })

  it('keeps it open for the idle window while Work is shown', () => {
    expect(micHoldMs(true, false)).toBe(MIC_IDLE_MS)
  })

  it('keeps it open only briefly while the window is hidden', () => {
    expect(micHoldMs(true, true)).toBe(MIC_HIDDEN_MS)
    expect(MIC_HIDDEN_MS).toBeLessThan(MIC_IDLE_MS)
  })
})
