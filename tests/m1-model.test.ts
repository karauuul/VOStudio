import { describe, expect, it } from 'vitest'
import {
  emptyEdits,
  sanitizeCompTracks,
  sanitizeCueRegion,
  sanitizeOriginal,
  sanitizePinned,
  sanitizeProjectSources,
  sanitizeTargetTrack,
  sanitizeTimelineViews,
  sanitizeVersions,
  sanitizeWords,
  type Cue,
  type Project,
  type Take,
} from '../src/shared/domain'
import {
  compSchema,
  cueRegionSchema,
  originalLaneSchema,
  projectCommandSchema,
  projectFileSchema,
} from '../src/main/schemas'
import { applyProjectCommand } from '../src/shared/project-commands'
import { hasValidVoicedOutput } from '../src/shared/approval'

const legacyProject = (): Project =>
  ({
    id: 'p',
    schemaVersion: 1,
    name: 'Legacy',
    createdAt: '2026-01-01T00:00:00.000Z',
    media: { referenceDir: 'ref', referencePattern: '{key}.wav' },
    characters: [
      {
        id: 'ch',
        name: 'Ada',
        color: '#4fc3f7',
        provider: { providerId: 'elevenlabs', voiceId: 'v', ttsModel: 'm', stsModel: 's' },
        voiceSettings: { stability: 0.45, similarity: 0.51, style: 0, speed: 1, boost: true },
      },
    ],
    cues: [
      {
        id: 'c',
        characterId: 'ch',
        key: 'K1',
        fields: { EventName: 'Hello' },
        sourceText: 'Hello',
        text: 'Привіт',
        status: 'generated',
        notes: '',
        takes: [
          {
            id: 't1',
            kind: 'tts',
            createdAt: '2026-01-01T00:00:01.000Z',
            file: { fileId: 'c/t1.mp3', relPath: 'c/t1.mp3', format: 'mp3' },
            duration: 2,
            meta: { text: 'Привіт', provider: 'elevenlabs' },
            edits: emptyEdits(),
          },
        ],
        finalTakeId: 't1',
        comp: {
          clips: [
            {
              id: 'cc1',
              sourceTakeId: 't1',
              srcIn: 0,
              srcOut: 2,
              start: 0,
              edits: emptyEdits(),
            },
          ],
          region: { in: 0, out: 2 },
        },
        output: { kind: 'comp', revision: 3 },
        textRevision: 1,
      },
    ],
    sessions: [],
    pronunciationRules: '',
    exportTemplate: '{EventName}.{ext}',
    terms: [{ term: 'a', translation: 'б' }],
    ui: { filter: '', search: '' },
  }) as Project

const persisted = (p: Project): string => {
  const { ui: _ui, ...rest } = p
  return JSON.stringify(rest, null, 2)
}

describe('a project without any new field survives the schemas and the command path byte for byte', () => {
  it('projectFileSchema neither strips nor changes a value', () => {
    const data = JSON.parse(persisted(legacyProject())) as Record<string, unknown>
    const parsed = projectFileSchema.parse(data) as Record<string, unknown>
    expect(parsed).toEqual(data)
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(data).sort())
  })

  it('validation plus a command round trip leaves the stored JSON identical', () => {
    const p = legacyProject()
    const before = persisted(p)
    projectFileSchema.parse(JSON.parse(before))
    applyProjectCommand(p, projectCommandSchema.parse({
      type: 'cue.saveText',
      cueId: 'c',
      text: 'Привіт',
    }) as never)
    expect(persisted(p)).toBe(before)
  })

  it('cue.setComp through zod returns the same composition, with only the output revision moving', () => {
    const p = legacyProject()
    const comp = structuredClone(p.cues[0].comp)!
    const command = projectCommandSchema.parse({ type: 'cue.setComp', cueId: 'c', comp })
    expect(JSON.stringify((command as { comp: unknown }).comp)).toBe(JSON.stringify(comp))
    applyProjectCommand(p, command as never)
    expect(JSON.stringify(p.cues[0].comp)).toBe(JSON.stringify(comp))
    expect(p.cues[0].output).toEqual({ kind: 'comp', revision: 4 })
    expect(hasValidVoicedOutput(p.cues[0], p)).toBe(true)
  })
})

describe('sanitizers for the new fields', () => {
  it('words are sorted, non-negative and never end before they start', () => {
    expect(
      sanitizeWords([
        { text: 'b', start: 2, end: 1 },
        { text: 'a', start: -1, end: 0.5 },
        { text: 'skip', start: 'x', end: 1 },
        'nonsense',
      ])
    ).toEqual([
      { text: 'a', start: 0, end: 0.5 },
      { text: 'b', start: 2, end: 2 },
    ])
    expect(sanitizeWords([])).toBeUndefined()
    expect(sanitizeWords('no')).toBeUndefined()
  })

  it('pinned is only the literal true', () => {
    expect(sanitizePinned(true)).toBe(true)
    expect(sanitizePinned('true')).toBeUndefined()
    expect(sanitizePinned(false)).toBeUndefined()
  })

  it('track gain is clamped to [-96, 24]', () => {
    const gains = sanitizeCompTracks([
      { id: 'a', name: 'A', gainDb: -400, muted: false, solo: false },
      { id: 'b', name: 'B', gainDb: 400, muted: false, solo: false },
      { id: 'c', name: 'C', gainDb: Number.NaN, muted: false, solo: false },
    ])?.map((t) => t.gainDb)
    expect(gains).toEqual([-96, 24, 0])
  })

  it('a track keeps its character and sanitized effects', () => {
    expect(
      sanitizeCompTracks([
        {
          id: 'a',
          name: 'A',
          characterId: 'ch',
          gainDb: 0,
          muted: true,
          solo: true,
          effects: { reverb: { mix: 5, size: 0.5, decay: 1 } },
        },
      ])
    ).toEqual([
      {
        id: 'a',
        name: 'A',
        characterId: 'ch',
        gainDb: 0,
        muted: true,
        solo: true,
        effects: { reverb: { mix: 1, size: 0.5, decay: 1 } },
      },
    ])
  })

  it('duckDb is clamped to [-60, 0] and the default lane is off', () => {
    expect(sanitizeOriginal({ exportMode: 'on', duckDb: -400 })).toEqual({
      exportMode: 'on',
      duckDb: -60,
    })
    expect(sanitizeOriginal({ exportMode: 'on', duckDb: 12 })).toEqual({
      exportMode: 'on',
      duckDb: 0,
    })
    expect(sanitizeOriginal({ exportMode: 'nonsense', previewMuted: true })).toEqual({
      exportMode: 'off',
      previewMuted: true,
    })
    expect(sanitizeOriginal(null)).toBeUndefined()
  })

  it('a cue region needs a source and in < out', () => {
    expect(sanitizeCueRegion({ sourceId: 's', in: -1, out: 2 })).toEqual({
      sourceId: 's',
      in: 0,
      out: 2,
    })
    expect(sanitizeCueRegion({ sourceId: 's', in: 2, out: 2 })).toBeUndefined()
    expect(sanitizeCueRegion({ sourceId: '', in: 0, out: 1 })).toBeUndefined()
  })

  it('project sources need a usable file reference', () => {
    expect(
      sanitizeProjectSources([
        { id: 's1', name: 'Scene', kind: 'video', duration: -3, file: { fileId: 'f', relPath: 'p.wav', format: 'wav' } },
        { id: 's1', name: 'dup', kind: 'audio', duration: 1, file: { fileId: 'f', relPath: 'p.wav', format: 'wav' } },
        { id: 's2', name: 'no file', kind: 'audio', duration: 1 },
      ])
    ).toEqual([
      {
        id: 's1',
        name: 'Scene',
        kind: 'video',
        file: { fileId: 'f', relPath: 'p.wav', format: 'wav' },
        duration: 0,
      },
    ])
  })

  it('versions are unique, positive and ordered', () => {
    expect(
      sanitizeVersions([
        { n: 2, createdAt: 'b' },
        { n: 1, name: ' first ', createdAt: 'a' },
        { n: 2, createdAt: 'dup' },
        { n: 0, createdAt: 'zero' },
        { n: 3 },
      ])
    ).toEqual([
      { n: 1, name: ' first ', createdAt: 'a' },
      { n: 2, createdAt: 'b' },
    ])
  })

  it('targetTrack keeps only string ids', () => {
    expect(sanitizeTargetTrack({ c1: 'track-2', c2: 3, c3: '' })).toEqual({ c1: 'track-2' })
    expect(sanitizeTargetTrack({})).toBeUndefined()
    expect(sanitizeTargetTrack([])).toBeUndefined()
  })

  it('the per-line timeline view keeps only usable numbers', () => {
    expect(
      sanitizeTimelineViews({
        c1: { pxPerSec: 120, scroll: 2.5, originalGainDb: -3 },
        c2: { pxPerSec: 9e9, scroll: -4 },
        c3: { pxPerSec: 'x' },
        c4: null,
      })
    ).toEqual({
      c1: { pxPerSec: 120, scroll: 2.5, originalGainDb: -3 },
      c2: { pxPerSec: 2000, scroll: 0 },
    })
  })

  it('an absent or empty timeline view stays absent', () => {
    expect(sanitizeTimelineViews(undefined)).toBeUndefined()
    expect(sanitizeTimelineViews({})).toBeUndefined()
    expect(sanitizeTimelineViews([])).toBeUndefined()
  })
})

describe('zod mirrors carry the new fields', () => {
  const clip = {
    id: 'cc1',
    sourceTakeId: 't1',
    srcIn: 0,
    srcOut: 2,
    start: 0,
    edits: emptyEdits(),
    trackId: 'track-2',
  }

  it('compSchema keeps tracks and trackId', () => {
    const comp = {
      clips: [clip],
      tracks: [
        {
          id: 'track-2',
          name: 'Track 2',
          characterId: 'ch',
          gainDb: -3,
          muted: false,
          solo: true,
          effects: { pitch: { semitones: 2 } },
        },
      ],
    }
    expect(JSON.stringify(compSchema.parse(comp))).toBe(JSON.stringify(comp))
  })

  it('compSchema rejects a track gain outside the model bounds', () => {
    const bad = {
      clips: [clip],
      tracks: [{ id: 'track-2', name: 'T', gainDb: -200, muted: false, solo: false }],
    }
    expect(() => compSchema.parse(bad)).toThrow()
  })

  it('the original lane and the cue region mirror their clamps', () => {
    expect(originalLaneSchema.parse({ exportMode: 'on', duckDb: -6 })).toEqual({
      exportMode: 'on',
      duckDb: -6,
    })
    expect(() => originalLaneSchema.parse({ exportMode: 'on', duckDb: -61 })).toThrow()
    expect(() => originalLaneSchema.parse({ exportMode: 'maybe' })).toThrow()
    expect(cueRegionSchema.parse({ sourceId: 's', in: 1, out: 2 })).toEqual({
      sourceId: 's',
      in: 1,
      out: 2,
    })
    expect(() => cueRegionSchema.parse({ sourceId: 's', in: 2, out: 1 })).toThrow()
  })

  it('projectFileSchema does not strip sources and versions', () => {
    const p = legacyProject()
    p.sources = [
      { id: 's1', name: 'Scene', kind: 'video', file: { fileId: 'f', relPath: 'p.wav', format: 'wav' }, duration: 12 },
    ]
    p.versions = [{ n: 1, createdAt: '2026-01-01T00:00:00.000Z' }]
    const data = JSON.parse(persisted(p)) as Record<string, unknown>
    const parsed = projectFileSchema.parse(data) as Record<string, unknown>
    expect(parsed['sources']).toEqual(data['sources'])
    expect(parsed['versions']).toEqual(data['versions'])
  })
})

const take = (id: string, over: Partial<Take> = {}): Take => ({
  id,
  kind: 'tts',
  createdAt: '2026-01-01T00:00:01.000Z',
  file: { fileId: id, relPath: `${id}.mp3`, format: 'mp3' },
  duration: 2,
  meta: {},
  edits: emptyEdits(),
  ...over,
})

const twoCues = (): Project => {
  const p = legacyProject()
  const second: Cue = {
    id: 'c2',
    characterId: 'ch',
    key: 'K2',
    fields: {},
    sourceText: 'Second',
    text: 'Другий',
    status: 'translated',
    notes: '',
    takes: [take('t2')],
  }
  p.cues.push(second)
  return p
}

describe('the new commands', () => {
  it('cue.setOriginal stores a sanitized lane and null removes it', () => {
    const p = legacyProject()
    applyProjectCommand(p, { type: 'cue.setOriginal', cueId: 'c', original: { exportMode: 'on', duckDb: -400 } })
    expect(p.cues[0].original).toEqual({ exportMode: 'on', duckDb: -60 })
    applyProjectCommand(p, { type: 'cue.setOriginal', cueId: 'c', original: null })
    expect(p.cues[0]).not.toHaveProperty('original')
  })

  it('cue.setRegion validates the source against project.sources', () => {
    const p = legacyProject()
    expect(() =>
      applyProjectCommand(p, { type: 'cue.setRegion', cueId: 'c', region: { sourceId: 's1', in: 0, out: 1 } })
    ).toThrow('is not in this project')
    p.sources = [
      { id: 's1', name: 'Scene', kind: 'video', file: { fileId: 'f', relPath: 'p.wav', format: 'wav' }, duration: 12 },
    ]
    applyProjectCommand(p, { type: 'cue.setRegion', cueId: 'c', region: { sourceId: 's1', in: 0, out: 1 } })
    expect(p.cues[0].region).toEqual({ sourceId: 's1', in: 0, out: 1 })
    applyProjectCommand(p, { type: 'cue.setRegion', cueId: 'c', region: null })
    expect(p.cues[0]).not.toHaveProperty('region')
  })

  it('cue.setTakePinned marks and unmarks a take', () => {
    const p = twoCues()
    applyProjectCommand(p, { type: 'cue.setTakePinned', cueId: 'c2', takeId: 't2', pinned: true })
    expect(p.cues[1].takes[0].pinned).toBe(true)
    applyProjectCommand(p, { type: 'cue.setTakePinned', cueId: 'c2', takeId: 't2', pinned: false })
    expect(p.cues[1].takes[0]).not.toHaveProperty('pinned')
  })

  it('a pinned take of another cue can land on this timeline', () => {
    const p = twoCues()
    applyProjectCommand(p, { type: 'cue.setTakePinned', cueId: 'c2', takeId: 't2', pinned: true })
    const comp = {
      clips: [
        { id: 'cc1', sourceTakeId: 't1', srcIn: 0, srcOut: 2, start: 0, edits: emptyEdits() },
        { id: 'cc2', sourceTakeId: 't2', srcIn: 0, srcOut: 2, start: 2, edits: emptyEdits() },
      ],
    }
    applyProjectCommand(p, { type: 'cue.setComp', cueId: 'c', comp })
    expect(p.cues[0].comp?.clips.map((c) => c.sourceTakeId)).toEqual(['t1', 't2'])
    expect(p.cues[0].status).toBe('generated')
    expect(hasValidVoicedOutput(p.cues[0], p)).toBe(true)
  })

  it('an unpinned take of another cue is still refused', () => {
    const p = twoCues()
    expect(() =>
      applyProjectCommand(p, {
        type: 'cue.setComp',
        cueId: 'c',
        comp: { clips: [{ id: 'cc2', sourceTakeId: 't2', srcIn: 0, srcOut: 2, start: 0, edits: emptyEdits() }] },
      })
    ).toThrow('is not in this cue')
  })

  it('a take used by a clip of its own line cannot be deleted', () => {
    const p = twoCues()
    applyProjectCommand(p, {
      type: 'cue.setComp',
      cueId: 'c2',
      comp: { clips: [{ id: 'cc2', sourceTakeId: 't2', srcIn: 0, srcOut: 2, start: 0, edits: emptyEdits() }] },
    })
    expect(() =>
      applyProjectCommand(p, { type: 'cue.deleteTake', cueId: 'c2', takeId: 't2' })
    ).toThrow('used by a clip on this line')
    applyProjectCommand(p, { type: 'cue.setComp', cueId: 'c2', comp: null })
    applyProjectCommand(p, { type: 'cue.deleteTake', cueId: 'c2', takeId: 't2' })
    expect(p.cues[1].takes[0].deletedAt).toBeTruthy()
  })

  it('a pinned take used on another line cannot be deleted or unpinned', () => {
    const p = twoCues()
    applyProjectCommand(p, { type: 'cue.setTakePinned', cueId: 'c2', takeId: 't2', pinned: true })
    applyProjectCommand(p, {
      type: 'cue.setComp',
      cueId: 'c',
      comp: { clips: [{ id: 'cc2', sourceTakeId: 't2', srcIn: 0, srcOut: 2, start: 0, edits: emptyEdits() }] },
    })
    expect(() =>
      applyProjectCommand(p, { type: 'cue.deleteTake', cueId: 'c2', takeId: 't2' })
    ).toThrow('used on another line')
    expect(() =>
      applyProjectCommand(p, { type: 'cue.setTakePinned', cueId: 'c2', takeId: 't2', pinned: false })
    ).toThrow('used on another line')
  })

  it('the command schema mirrors all three new commands', () => {
    for (const command of [
      { type: 'cue.setOriginal', cueId: 'c', original: { exportMode: 'off' } },
      { type: 'cue.setOriginal', cueId: 'c', original: null },
      { type: 'cue.setTakePinned', cueId: 'c', takeId: 't1', pinned: true },
      { type: 'cue.setRegion', cueId: 'c', region: { sourceId: 's', in: 0, out: 1 } },
      { type: 'cue.setRegion', cueId: 'c', region: null },
    ]) {
      expect(projectCommandSchema.parse(command)).toEqual(command)
    }
  })
})
