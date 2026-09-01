import { describe, expect, it } from 'vitest'
import { ADA_ID, ALIEN, characterForEvent, needsAlienMigration } from '../src/main/satisfactory-preset'

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

const legacy = (over: Partial<Parameters<typeof needsAlienMigration>[0]> = {}) => ({
  csvBinding: { csvPath: 'x.csv', encoding: 'utf-8-sig', columnOrder: [], mapping: { key: 'WemId' } },
  characters: [{ id: ADA_ID }],
  cues: [{ fields: { EventName: 'VO_ADA_01' } }],
  ...over,
}) as Parameters<typeof needsAlienMigration>[0]

describe('needsAlienMigration', () => {
  it('migrates a legacy project with a csv binding, ada and EventName rows', () => {
    expect(needsAlienMigration(legacy())).toBe(true)
  })

  it('never touches a project without a csv binding', () => {
    expect(needsAlienMigration(legacy({ csvBinding: undefined }))).toBe(false)
  })

  it('never touches a project without the ada character', () => {
    expect(needsAlienMigration(legacy({ characters: [{ id: 'ADA' }] as never }))).toBe(false)
  })

  it('is idempotent once alien is present', () => {
    expect(needsAlienMigration(legacy({ characters: [{ id: ADA_ID }, { id: ALIEN.id }] as never }))).toBe(false)
  })

  it('skips projects whose cues carry no EventName', () => {
    expect(needsAlienMigration(legacy({ cues: [{ fields: {} }] as never }))).toBe(false)
  })
})
