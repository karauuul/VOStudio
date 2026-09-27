import { describe, expect, it } from 'vitest'
import {
  emptyEdits,
  safeRelPath,
  sanitizeAssets,
  sanitizeOrigins,
  sanitizeProposals,
  sanitizeTerms,
  ORIGINS_MAX,
  withOrigin,
  type Cue,
  type Project,
} from '../src/shared/domain'
import { cueSchema, projectCommandSchema, projectFileSchema } from '../src/main/schemas'
import { applyChangeSet, applyProjectCommand, type ProjectCommand } from '../src/shared/project-commands'
import { projectFile } from '../src/shared/project-file'
import { rebasePaths, relocatedPath } from '../src/shared/relocate'

const voice = { stability: 0.5, similarity: 0.5, style: 0, speed: 1, boost: true }
const character = (id: string, name: string): Project['characters'][number] => ({
  id,
  name,
  color: '#fff',
  provider: { providerId: 'elevenlabs', voiceId: 'v', ttsModel: 'm', stsModel: 's' },
  voiceSettings: { ...voice },
})

const line = (id: string, over: Partial<Cue> = {}): Cue => ({
  id,
  characterId: 'ada',
  key: id.toUpperCase(),
  fields: {},
  sourceText: 'src',
  text: 'text',
  status: 'translated',
  notes: '',
  takes: [],
  ...over,
})

const asset = {
  id: 'a1',
  name: 'subs/demo.srt',
  kind: 'subtitles' as const,
  file: { fileId: 'demo.srt', relPath: '/p/Demo.vostudio/assets/demo.srt' },
  size: 120,
  addedAt: '2026-09-27T00:00:00.000Z',
  rows: 5,
}

function project(): Project {
  const voiced = line('c3')
  voiced.takes = [{ id: 't1', kind: 'tts', createdAt: 'now', file: { fileId: 't1', relPath: '/p/t1.mp3', format: 'mp3' }, duration: 1, meta: {}, edits: emptyEdits() }]
  voiced.finalTakeId = 't1'
  voiced.output = { kind: 'take', takeId: 't1', revision: 0 }
  voiced.status = 'generated'
  return {
    id: 'p',
    schemaVersion: 1,
    name: 'Demo',
    createdAt: 'now',
    media: { referenceDir: '', referencePattern: '' },
    characters: [character('ada', 'Ada'), character('bob', 'Bob')],
    cues: [line('c1'), line('c2', { suggestedText: 'better' }), voiced],
    sessions: [],
    assets: [asset],
    pronunciationRules: '',
    exportTemplate: '{key}.{ext}',
    ui: { filter: '', search: '' },
  }
}

const run = (p: Project, command: unknown) => applyProjectCommand(p, projectCommandSchema.parse(command) as ProjectCommand)

describe('cue.propose', () => {
  it('sets and clears character and link proposals on many lines in one step', () => {
    const p = project()
    const changes = run(p, {
      type: 'cue.propose',
      items: [
        { cueId: 'c1', character: { characterId: 'bob', confidence: 0.8, reason: 'addresses Ada' } },
        { cueId: 'c2', link: { assetId: 'a1', row: 3, confidence: 0.93, reason: 'text similarity 0.93' } },
      ],
    })
    expect(changes.cues?.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(p.cues[0].proposals).toEqual({ character: { characterId: 'bob', confidence: 0.8, reason: 'addresses Ada' } })
    expect(p.cues[1].proposals).toEqual({ link: { assetId: 'a1', row: 3, confidence: 0.93, reason: 'text similarity 0.93' } })
    expect(p.cues[0].characterId).toBe('ada')
    run(p, { type: 'cue.propose', items: [{ cueId: 'c1', character: null }, { cueId: 'c2', link: null }] })
    expect(p.cues[0]).not.toHaveProperty('proposals')
    expect(p.cues[1]).not.toHaveProperty('proposals')
  })

  it('refuses unknown characters, assets and lines, and out-of-range values at the schema', () => {
    const p = project()
    expect(() => run(p, { type: 'cue.propose', items: [{ cueId: 'c1', character: { characterId: 'zed', confidence: 1, reason: '' } }] })).toThrow('Character not found')
    expect(() => run(p, { type: 'cue.propose', items: [{ cueId: 'c1', link: { assetId: 'nope', row: 0, confidence: 1, reason: '' } }] })).toThrow('Asset not found')
    expect(() => run(p, { type: 'cue.propose', items: [{ cueId: 'zz', character: null }] })).toThrow('Cue not found')
    expect(() => projectCommandSchema.parse({ type: 'cue.propose', items: [{ cueId: 'c1', character: { characterId: 'bob', confidence: 2, reason: '' } }] })).toThrow()
    expect(p.cues.some((c) => c.proposals)).toBe(false)
  })
})

describe('proposal.accept and proposal.reject', () => {
  const proposed = (): Project => {
    const p = project()
    run(p, {
      type: 'cue.propose',
      items: [
        { cueId: 'c1', link: { assetId: 'a1', row: 2, confidence: 0.9, reason: 'key' } },
        { cueId: 'c3', character: { characterId: 'bob', confidence: 0.7, reason: 'speaker in demo.srt' } },
      ],
    })
    return p
  }

  it('accepting sets the character, ties the line to its asset row and takes the suggested text', () => {
    const p = proposed()
    run(p, {
      type: 'proposal.accept',
      items: [
        { cueId: 'c1', kind: 'link' },
        { cueId: 'c3', kind: 'character' },
        { cueId: 'c2', kind: 'text' },
      ],
    })
    expect(p.cues[0].origins).toEqual([{ assetId: 'a1', row: 2 }])
    expect(p.cues[0]).not.toHaveProperty('proposals')
    expect(p.cues[2].characterId).toBe('bob')
    expect(p.cues[2]).not.toHaveProperty('proposals')
    expect(p.cues[2].output).not.toEqual({ kind: 'take', takeId: 't1', revision: 0 })
    expect(p.cues[1].text).toBe('better')
    expect(p.cues[1]).not.toHaveProperty('suggestedText')
  })

  it('rejecting only drops the proposal', () => {
    const p = proposed()
    run(p, { type: 'proposal.reject', items: [{ cueId: 'c1', kind: 'link' }, { cueId: 'c3', kind: 'character' }, { cueId: 'c2', kind: 'text' }] })
    expect(p.cues.map((c) => [c.characterId, c.text, c.origins, c.proposals, c.suggestedText])).toEqual([
      ['ada', 'text', undefined, undefined, undefined],
      ['ada', 'text', undefined, undefined, undefined],
      ['ada', 'text', undefined, undefined, undefined],
    ])
    expect(p.cues[2].output).toEqual({ kind: 'take', takeId: 't1', revision: 0 })
  })

  it('deleting a character drops proposals that point at it, and accepting a stale one is a no-op', () => {
    const p = proposed()
    const changes = run(p, { type: 'character.delete', characterId: 'bob', reassignTo: '' })
    expect(changes.cues?.map((c) => c.id)).toEqual(['c3'])
    expect(p.cues[2]).not.toHaveProperty('proposals')
    const stale = project()
    stale.cues[0].proposals = { character: { characterId: 'gone', confidence: 1, reason: '' } }
    run(stale, { type: 'proposal.accept', items: [{ cueId: 'c1', kind: 'character' }] })
    expect(stale.cues[0].characterId).toBe('ada')
    expect(stale.cues[0]).not.toHaveProperty('proposals')
  })
})

describe('rule 2: the new fields', () => {
  it('sanitizers keep usable values and drop the rest', () => {
    expect(sanitizeProposals({ character: { characterId: 'a', confidence: 3, reason: ' r ' }, link: { assetId: 'x', row: -1, confidence: 1 } })).toEqual({
      character: { characterId: 'a', confidence: 1, reason: 'r' },
    })
    expect(sanitizeProposals({ link: { assetId: '', row: 0, confidence: 1 } })).toBeUndefined()
    expect(sanitizeOrigins([{ assetId: 'x', row: 1.5 }, { row: 1 }, { assetId: 'y', row: 2 }, { assetId: 'x', row: 3 }])).toEqual([{ assetId: 'y', row: 2 }, { assetId: 'x', row: 3 }])
    expect(sanitizeOrigins([{ row: 1 }])).toBeUndefined()
    expect(sanitizeAssets([asset, { ...asset }, { id: 'b', kind: 'weird', file: { fileId: 'f', relPath: '/f' }, addedAt: 'now', size: -3, duration: 0 }, { id: 'c' }])).toEqual([
      asset,
      { id: 'b', name: 'b', kind: 'other', file: { fileId: 'f', relPath: '/f' }, size: 0, addedAt: 'now' },
    ])
    expect(sanitizeAssets([])).toBeUndefined()
    expect(sanitizeAssets([{ ...asset, name: '../../..' }, { ...asset, id: 'a2', name: '/etc/../passwd.csv' }])).toEqual([
      { ...asset, name: 'a1' },
      { ...asset, id: 'a2', name: 'etc/passwd.csv' },
    ])
    expect(sanitizeTerms([{ term: 'a', translation: 'б', proposed: true }, { term: 'c', translation: 'д', proposed: 'yes' }])).toEqual([
      { term: 'a', translation: 'б', proposed: true },
      { term: 'c', translation: 'д' },
    ])
  })

  it('a relative asset path keeps only segments that stay where they are', () => {
    expect(safeRelPath('drop/vo/ada_001.wav')).toBe('drop/vo/ada_001.wav')
    expect(safeRelPath('../../x.wav')).toBe('x.wav')
    expect(safeRelPath('/abs/./x.wav')).toBe('abs/x.wav')
    expect(safeRelPath('C:\\a\\...\\x.wav')).toBe('a/x.wav')
    expect(safeRelPath('a/.. /b\u0001c/x.wav')).toBe('a/x.wav')
    expect(safeRelPath('..')).toBe('')
    expect(safeRelPath('scene:1/take:2.wav')).toBe('scene:1/take:2.wav')
  })

  it('origins stay within the cap on write, keeping the newest and evicting the oldest', () => {
    let origins = Array.from({ length: ORIGINS_MAX }, (_, i) => ({ assetId: `a${i}` }))
    origins = withOrigin(origins, { assetId: 'new', row: 1 })
    expect(origins).toHaveLength(ORIGINS_MAX)
    expect(origins[0]).toEqual({ assetId: 'a1' })
    expect(origins.at(-1)).toEqual({ assetId: 'new', row: 1 })
    expect(withOrigin(origins, { assetId: 'a1' })).toHaveLength(ORIGINS_MAX)
    const c = { ...project().cues[0], origins }
    expect(cueSchema.parse(c).origins).toEqual(origins)
    expect(sanitizeOrigins(origins)).toEqual(origins)
    expect(sanitizeOrigins([{ assetId: 'old' }, ...origins])).toEqual(origins)
  })

  it('zod mirrors keep assets, proposals, origins and proposed terms', () => {
    const p = project()
    p.cues[0].proposals = { character: { characterId: 'bob', confidence: 0.5, reason: 'r' }, link: { assetId: 'a1', row: 0, confidence: 1, reason: 'k' } }
    p.cues[0].origins = [{ assetId: 'wav' }, { assetId: 'a1', row: 4 }]
    expect(cueSchema.parse(p.cues[0])).toEqual(p.cues[0])
    const stored = JSON.parse(projectFile(p).json) as Record<string, unknown>
    expect(projectFileSchema.parse(stored)).toEqual(stored)
    const terms = [{ term: 'node', translation: 'вузол', proposed: true as const }]
    expect((projectCommandSchema.parse({ type: 'terms.set', terms }) as { terms: unknown }).terms).toEqual(terms)
    run(p, { type: 'terms.set', terms })
    expect(p.terms).toEqual(terms)
  })

  it('a project without the new fields keeps its stored JSON through the new commands', () => {
    const p = project()
    delete p.assets
    const before = projectFile(p).json
    run(p, { type: 'proposal.reject', items: [{ cueId: 'c1', kind: 'character' }, { cueId: 'c1', kind: 'link' }] })
    run(p, { type: 'terms.set', terms: [] })
    expect(projectFile(p).json).toBe(before)
    expect(before).not.toMatch(/assets|proposals|origins|proposed/)
  })

  it('applyChangeSet carries assets to the renderer copy', () => {
    const p = project()
    delete p.assets
    const next = applyChangeSet(p, { assets: [asset] })
    expect(next.assets).toEqual([asset])
    expect(next.assets).not.toBe(p.assets)
  })

  it('moving the project rebases copied asset files', () => {
    const p = project()
    const moved = relocatedPath('/q/Demo.vostudio', asset.file.relPath)
    expect(moved).toBe('/q/Demo.vostudio/assets/demo.srt')
    expect(rebasePaths(p, new Map([[asset.file.relPath, moved as string]]))).toBe(true)
    expect(p.assets?.[0].file.relPath).toBe('/q/Demo.vostudio/assets/demo.srt')
  })
})
