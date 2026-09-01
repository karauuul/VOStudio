import { describe, expect, it } from 'vitest'
import { ADA_ID, ALIEN, applyAlienMigration, characterForEvent, needsAlienMigration } from '../src/main/satisfactory-preset'
import { DEFAULT_VOICE_SETTINGS, type Project } from '../src/shared/domain'
import { projectFileSchema } from '../src/main/schemas'

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

const ada = {
  id: ADA_ID,
  name: 'ADA',
  color: '#4fc3f7',
  provider: { providerId: 'elevenlabs' as const, voiceId: 'v', ttsModel: 'm', stsModel: 's' },
  voiceSettings: { ...DEFAULT_VOICE_SETTINGS },
}

const legacyProject = (over: Partial<Project> = {}): Project => ({
  id: 'p',
  schemaVersion: 1,
  createdAt: 'now',
  name: 'P',
  media: { referenceDir: '', referencePattern: '' },
  pronunciationRules: '',
  exportTemplate: '{EventName}.{ext}',
  csvBinding: { csvPath: 'x.csv', encoding: 'utf-8-sig', columnOrder: [], mapping: { key: 'WemId' } },
  characters: [structuredClone(ada)],
  cues: [
    { id: 'c1', characterId: ADA_ID, key: '1', fields: { EventName: 'VO_ADA_01' }, sourceText: '', text: '', status: 'empty', notes: '', takes: [] },
    { id: 'c2', characterId: ADA_ID, key: '2', fields: { EventName: 'VO_Alien_01' }, sourceText: '', text: '', status: 'empty', notes: '', takes: [] },
  ],
  sessions: [],
  ui: { filter: '', search: '' },
  ...over,
})

describe('applyAlienMigration', () => {
  it('routes a legacy project once and stamps it as migrated', () => {
    const p = legacyProject()
    expect(applyAlienMigration(p)).toBe(true)
    expect(p.characters.map((c) => c.id)).toEqual([ADA_ID, ALIEN.id])
    expect(p.cues.map((c) => c.characterId)).toEqual([ADA_ID, ALIEN.id])
    expect(p.alienMigrated).toBe(true)
  })

  it('never runs twice on the same project', () => {
    const p = legacyProject()
    applyAlienMigration(p)
    p.cues[1].characterId = ADA_ID
    expect(applyAlienMigration(p)).toBe(false)
    expect(p.cues[1].characterId).toBe(ADA_ID)
  })

  it('is not re-armed by deleting the alien character', () => {
    const p = legacyProject()
    applyAlienMigration(p)
    p.characters = p.characters.filter((c) => c.id !== ALIEN.id)
    p.cues[1].characterId = ''
    expect(needsAlienMigration(p)).toBe(true)
    expect(applyAlienMigration(p)).toBe(false)
    expect(p.cues.map((c) => c.characterId)).toEqual([ADA_ID, ''])
    expect(p.characters.map((c) => c.id)).toEqual([ADA_ID])
  })

  it('stamps an already-migrated legacy project without rewriting cues', () => {
    const p = legacyProject({ characters: [structuredClone(ada), structuredClone(ALIEN)] })
    p.cues[0].characterId = ALIEN.id
    p.cues[1].characterId = ADA_ID
    expect(applyAlienMigration(p)).toBe(true)
    expect(p.cues.map((c) => c.characterId)).toEqual([ALIEN.id, ADA_ID])
    expect(p.alienMigrated).toBe(true)
  })

  it('leaves a project without a csv binding byte-identical', () => {
    const p = legacyProject({ csvBinding: undefined })
    const before = JSON.stringify(p)
    expect(applyAlienMigration(p)).toBe(false)
    expect(JSON.stringify(p)).toBe(before)
    expect(p.alienMigrated).toBeUndefined()
  })
})

describe('alienMigrated serialization', () => {
  it('survives a project file roundtrip', () => {
    const p = legacyProject()
    applyAlienMigration(p)
    const { ui: _ui, ...persisted } = p
    const reloaded = JSON.parse(JSON.stringify(persisted)) as Project
    expect(projectFileSchema.parse(reloaded)).toMatchObject({ alienMigrated: true })
    expect(reloaded.alienMigrated).toBe(true)
  })

  it('leaves old project files without the field untouched', () => {
    const { ui: _ui, ...persisted } = legacyProject()
    const raw = JSON.stringify(persisted)
    const reloaded = JSON.parse(raw) as Project
    expect(() => projectFileSchema.parse(reloaded)).not.toThrow()
    expect('alienMigrated' in reloaded).toBe(false)
    expect(JSON.stringify(reloaded)).toBe(raw)
  })

  it('rejects a forged alienMigrated value', () => {
    const { ui: _ui, ...persisted } = legacyProject()
    expect(() => projectFileSchema.parse({ ...persisted, alienMigrated: false })).toThrow()
  })
})
