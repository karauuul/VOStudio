import { describe, expect, it } from 'vitest'
import { autoSelectsOutput, stsSchema, ttsSchema } from '../src/main/schemas'
import { DEFAULT_VOICE_SETTINGS } from '../src/shared/domain'
import type { StsRequest, TtsRequest } from '../src/shared/ipc'

const tts: TtsRequest = { cueId: 'c1', text: 'Hello', voiceSettings: DEFAULT_VOICE_SETTINGS }
const sts: StsRequest = { cueId: 'c1', sourceTakeId: 'r1', voiceSettings: DEFAULT_VOICE_SETTINGS }

describe('provider request schemas', () => {
  it('keeps the request valid without the flag', () => {
    expect(ttsSchema.parse(tts).selectOutput).toBeUndefined()
    expect(stsSchema.parse(sts).selectOutput).toBeUndefined()
  })

  it('carries selectOutput through both request shapes', () => {
    expect(ttsSchema.parse({ ...tts, selectOutput: false }).selectOutput).toBe(false)
    expect(stsSchema.parse({ ...sts, selectOutput: false }).selectOutput).toBe(false)
    expect(ttsSchema.parse({ ...tts, selectOutput: true }).selectOutput).toBe(true)
    expect(stsSchema.parse({ ...sts, selectOutput: true }).selectOutput).toBe(true)
  })

  it('rejects a non-boolean flag', () => {
    expect(() => ttsSchema.parse({ ...tts, selectOutput: 'no' })).toThrow()
    expect(() => stsSchema.parse({ ...sts, selectOutput: 1 })).toThrow()
  })

  it('keeps fragment requests unchanged', () => {
    expect(ttsSchema.parse({ ...tts, fragment: true }).fragment).toBe(true)
    expect(stsSchema.parse({ ...sts, fragment: true }).fragment).toBe(true)
  })
})

describe('autoSelectsOutput', () => {
  it('preserves the current behaviour when the flag is omitted', () => {
    expect(autoSelectsOutput({}, false)).toBe(true)
    expect(autoSelectsOutput({}, true)).toBe(false)
  })

  it('never selects the output for a candidate', () => {
    expect(autoSelectsOutput({ selectOutput: false }, false)).toBe(false)
    expect(autoSelectsOutput({ selectOutput: false }, true)).toBe(false)
  })

  it('never selects the output for a fragment', () => {
    expect(autoSelectsOutput({ fragment: true }, false)).toBe(false)
    expect(autoSelectsOutput({ fragment: true, selectOutput: true }, false)).toBe(false)
  })

  it('selects the output when asked explicitly outside the approved exception', () => {
    expect(autoSelectsOutput({ selectOutput: true }, false)).toBe(true)
    expect(autoSelectsOutput({ selectOutput: true }, true)).toBe(false)
  })
})
