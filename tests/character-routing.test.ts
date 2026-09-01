import { describe, expect, it } from 'vitest'
import { ADA, ALIEN, characterForEvent } from '../src/main/satisfactory-preset'

describe('characterForEvent', () => {
  it('ADA in the name → ada', () => {
    expect(characterForEvent('ADA_Intro_01')).toBe(ADA.id)
    expect(characterForEvent('Play_ADA_Warning')).toBe(ADA.id)
  })

  it('Alien / SamOre / Whisper → alien', () => {
    expect(characterForEvent('Alien_Greeting')).toBe(ALIEN.id)
    expect(characterForEvent('SamOre_Discovery')).toBe(ALIEN.id)
    expect(characterForEvent('whisper_loop_02')).toBe(ALIEN.id)
  })

  it('ADA takes priority over the alien pattern', () => {
    expect(characterForEvent('ADA_Alien_Artifact')).toBe(ADA.id)
  })

  it('nothing matched or empty → ada', () => {
    expect(characterForEvent('Ficsit_Announcement')).toBe(ADA.id)
    expect(characterForEvent('')).toBe(ADA.id)
  })

  it('ADA matches case-sensitively, alien does not', () => {
    expect(characterForEvent('ada_lowercase')).toBe(ADA.id)
    expect(characterForEvent('ALIEN_SHOUT')).toBe(ALIEN.id)
  })
})

describe('character preset', () => {
  it('the Alien has no voice configured — generation must be blocked', () => {
    expect(ALIEN.provider.voiceId).toBe('')
    expect(ADA.provider.voiceId).not.toBe('')
  })
})
