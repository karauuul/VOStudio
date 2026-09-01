import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_SETTINGS,
  normalizeOverride,
  resolveVoiceSettings,
  type Character,
  type Cue,
  type VoiceSettings,
} from '../src/shared/domain'

const vs = (p: Partial<VoiceSettings> = {}): VoiceSettings => ({
  stability: 0.45,
  similarity: 0.51,
  style: 0,
  speed: 1,
  boost: true,
  ...p,
})

const character = (id: string, settings: VoiceSettings): Character => ({
  id,
  name: id,
  color: '#fff',
  provider: { providerId: 'elevenlabs', voiceId: 'v', ttsModel: 'm', stsModel: 's' },
  voiceSettings: settings,
})

const cue = (override?: Partial<VoiceSettings>): Cue => ({
  id: 'c1',
  characterId: 'ada',
  key: 'K1',
  fields: {},
  sourceText: '',
  text: '',
  status: 'empty',
  notes: '',
  takes: [],
  ...(override ? { voiceSettingsOverride: override } : {}),
})

const ADA = character('ada', vs({ stability: 0.45, style: 0 }))
const ALIEN = character('alien', vs({ stability: 0.9, style: 0.7, speed: 0.85 }))

describe('resolveVoiceSettings', () => {
  it('without an override returns the character defaults', () => {
    expect(resolveVoiceSettings(ADA, cue())).toEqual(ADA.voiceSettings)
  })

  it('EVERY character shows ITS OWN settings (the same cue template)', () => {
    const a = resolveVoiceSettings(ADA, cue())
    const b = resolveVoiceSettings(ALIEN, cue())
    expect(a.stability).toBe(0.45)
    expect(b.stability).toBe(0.9)
    expect(b.speed).toBe(0.85)
    expect(a).not.toEqual(b)
  })

  it('a cue override overrides ONLY its own fields', () => {
    const r = resolveVoiceSettings(ALIEN, cue({ stability: 0.2 }))
    expect(r.stability).toBe(0.2)
    expect(r.style).toBe(0.7)
    expect(r.speed).toBe(0.85)
  })

  it('boost false in an override is not lost (falsy, but set)', () => {
    expect(resolveVoiceSettings(ADA, cue({ boost: false })).boost).toBe(false)
  })

  it('style 0 in an override is not lost', () => {
    expect(resolveVoiceSettings(ALIEN, cue({ style: 0 })).style).toBe(0)
  })

  it('undefined fields in an override are ignored, not overwriting the default', () => {
    const r = resolveVoiceSettings(ALIEN, cue({ stability: undefined, style: 0.1 }))
    expect(r.stability).toBe(0.9)
    expect(r.style).toBe(0.1)
  })

  it('no character → the global default, not a crash', () => {
    expect(resolveVoiceSettings(undefined, cue())).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(resolveVoiceSettings(undefined, cue({ speed: 1.1 })).speed).toBe(1.1)
  })

  it('does not mutate the character or the cue', () => {
    const c = cue({ stability: 0.1 })
    const before = JSON.stringify([ADA, c])
    resolveVoiceSettings(ADA, c)
    expect(JSON.stringify([ADA, c])).toBe(before)
  })

  it('returns a NEW object (so the caller does not hand out a shared reference)', () => {
    expect(resolveVoiceSettings(ADA, cue())).not.toBe(ADA.voiceSettings)
  })
})

describe('normalizeOverride', () => {
  const base = ADA.voiceSettings

  it('fields matching the default are dropped', () => {
    expect(normalizeOverride(base, { stability: 0.45, style: 0.3 })).toEqual({ style: 0.3 })
  })

  it('everything matches the default → null (the modified marker must go out)', () => {
    expect(normalizeOverride(base, { ...base })).toBeNull()
    expect(normalizeOverride(base, {})).toBeNull()
  })

  it('boost false differs from the true default and is kept', () => {
    expect(normalizeOverride(base, { boost: false })).toEqual({ boost: false })
  })

  it('a normalized override + resolve = what was asked for', () => {
    const next = { ...base, speed: 1.15 }
    const over = normalizeOverride(base, next)
    expect(over).toEqual({ speed: 1.15 })
    expect(resolveVoiceSettings(ADA, cue(over ?? undefined))).toEqual(next)
  })
})
