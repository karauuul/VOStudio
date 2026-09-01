import { describe, expect, it } from 'vitest'
import { ADA_ID, ALIEN, characterForEvent } from '../src/main/satisfactory-preset'

describe('characterForEvent', () => {
  it('routes ADA in the event name to ada', () => {
    expect(characterForEvent('ADA_Intro_01')).toBe(ADA_ID)
    expect(characterForEvent('Play_ADA_Warning')).toBe(ADA_ID)
  })

  it('routes Alien / SamOre / Whisper to alien', () => {
    expect(characterForEvent('Alien_Greeting')).toBe(ALIEN.id)
    expect(characterForEvent('SamOre_Discovery')).toBe(ALIEN.id)
    expect(characterForEvent('whisper_loop_02')).toBe(ALIEN.id)
  })

  it('gives ADA priority over the alien pattern', () => {
    expect(characterForEvent('ADA_Alien_Artifact')).toBe(ADA_ID)
  })

  it('falls back to ada on no match or an empty name', () => {
    expect(characterForEvent('Ficsit_Announcement')).toBe(ADA_ID)
    expect(characterForEvent('')).toBe(ADA_ID)
  })

  it('matches ADA case-sensitively and alien case-insensitively', () => {
    expect(characterForEvent('ada_lowercase')).toBe(ADA_ID)
    expect(characterForEvent('ALIEN_SHOUT')).toBe(ALIEN.id)
  })
})

describe('legacy character preset', () => {
  it('leaves the alien voice unconfigured so generation stays blocked', () => {
    expect(ALIEN.provider.voiceId).toBe('')
  })
})
