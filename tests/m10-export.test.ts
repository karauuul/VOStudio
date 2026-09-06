import { describe, expect, it } from 'vitest'
import { emptyEdits, type Cue, type Project, type Take } from '../src/shared/domain'
import {
  EXPORT_FORMATS,
  estimateBytes,
  formatBytes,
  formatSpec,
  lengthMode,
  loudnessGainDb,
  loudnessMode,
  parseEbur128,
  sanitizeExportSettings,
} from '../src/shared/export-settings'
import {
  compPlanFor,
  contentLength,
  exportName,
  isFastPath,
  mixesOriginal,
  renderLength,
  renderWindow,
  resolveCompClips,
  toClipPlan,
} from '../src/shared/export-plan'
import { matchesLineFilter, readinessRows, statusWords, summarize } from '../src/shared/readiness'
import { exportedLines, mergeExported } from '../src/shared/deliver'
import { applyChangeSet, applyProjectCommand } from '../src/shared/project-commands'
import { compTracks } from '../src/shared/library'
import { exportSettingsSchema, projectCommandSchema, projectFileSchema } from '../src/main/schemas'

function take(id: string, over: Partial<Take> = {}): Take {
  return {
    id,
    kind: 'tts',
    createdAt: '2026-01-01T00:00:00.000Z',
    file: { fileId: id, relPath: `E:/p/${id}.mp3`, format: 'mp3' },
    duration: 3,
    meta: {},
    edits: emptyEdits(),
    ...over,
  }
}

function cue(key: string, over: Partial<Cue> = {}): Cue {
  const t = over.takes?.[0] ?? take('t-' + key)
  return {
    id: 'c-' + key,
    characterId: 'ada',
    key,
    fields: { EventName: 'Ev_' + key },
    sourceText: 'source',
    text: 'переклад',
    status: 'generated',
    notes: '',
    referenceAudio: { fileId: 'r' + key, relPath: `E:/orig/${key}.wav`, format: 'wav' },
    referenceDuration: 3.5,
    takes: [t],
    finalTakeId: t.id,
    output: { kind: 'take', takeId: t.id, revision: 1 },
    ...over,
  } as Cue
}

const project = (cues: Cue[], over: Partial<Project> = {}): Project =>
  ({ cues, exportTemplate: '{EventName}.{ext}', ...over }) as Project

describe('export settings', () => {
  it('sanitizer keeps only known values and drops an empty object', () => {
    expect(
      sanitizeExportSettings({ outDir: '  D:/out  ', format: 'mp3-192', loudness: 'match', length: 'pad' })
    ).toEqual({ outDir: 'D:/out', format: 'mp3-192', loudness: 'match', length: 'pad' })
    expect(sanitizeExportSettings({ format: 'flac', loudness: 'loud', length: 'x' })).toBeUndefined()
    expect(sanitizeExportSettings({ outDir: '   ' })).toBeUndefined()
    expect(sanitizeExportSettings(null)).toBeUndefined()
    expect(sanitizeExportSettings([1])).toBeUndefined()
  })

  it('absent settings mean trim and no loudness matching', () => {
    expect(lengthMode(undefined)).toBe('trim')
    expect(loudnessMode(undefined)).toBe('off')
    expect(formatSpec(undefined)).toBe(EXPORT_FORMATS[0])
  })

  it('the zod mirror accepts every format and rejects an unknown one', () => {
    for (const f of EXPORT_FORMATS) {
      expect(exportSettingsSchema.parse({ format: f.id })).toEqual({ format: f.id })
    }
    expect(() => exportSettingsSchema.parse({ format: 'flac' })).toThrow()
    expect(exportSettingsSchema.parse(null)).toBeNull()
  })

  it('size estimate follows the format and reads back in units', () => {
    expect(estimateBytes(1, 'wav-48-24')).toBe(144000)
    expect(estimateBytes(1, 'wav-44-16')).toBe(88200)
    expect(estimateBytes(10, 'mp3-192')).toBe(240000)
    expect(estimateBytes(-5, 'ogg')).toBe(0)
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB')
  })
})

describe('loudness', () => {
  const summary = [
    'Parsed_ebur128_0',
    '  Integrated loudness:',
    '    I:         -18.4 LUFS',
    '    Threshold: -28.9 LUFS',
  ].join('\n')

  it('reads the integrated loudness out of the ffmpeg summary', () => {
    expect(parseEbur128(summary)).toBe(-18.4)
    expect(parseEbur128('no numbers here')).toBeNull()
  })

  it('takes the last I: line when ffmpeg logs progress', () => {
    expect(parseEbur128('I: -30.0 LUFS\nI: -23.5 LUFS')).toBe(-23.5)
  })

  it('gain is reference minus rendered, clamped, zero without a measurement', () => {
    expect(loudnessGainDb(-16, -20)).toBe(4)
    expect(loudnessGainDb(-20, -16)).toBe(-4)
    expect(loudnessGainDb(-5, -99)).toBe(24)
    expect(loudnessGainDb(-99, -5)).toBe(-24)
    expect(loudnessGainDb(null, -20)).toBe(0)
    expect(loudnessGainDb(-20, null)).toBe(0)
  })
})

describe('output name follows the chosen format', () => {
  it('the extension comes from the format, not from the take', () => {
    const c = cue('1')
    expect(exportName(project([c]), c, c.takes[0])).toBe('Ev_1.wav')
    expect(exportName(project([c], { export: { format: 'mp3-192' } }), c, c.takes[0])).toBe('Ev_1.mp3')
    expect(exportName(project([c], { export: { format: 'ogg' } }), c, c.takes[0])).toBe('Ev_1.ogg')
  })
})

describe('render length', () => {
  it('take trims and speed count toward the rendered length', () => {
    const t = take('t', { duration: 4, edits: { ...emptyEdits(), trimEnd: 1, timeStretch: 2 } })
    const c = cue('1', { takes: [t], referenceAudio: undefined, referenceDuration: undefined })
    expect(contentLength(c, t, project([c]))).toBe(1.5)
    expect(renderLength(c, t, project([c]))).toBe(1.5)
  })

  it('a plain take renders its own length', () => {
    const c = cue('1')
    const p = project([c])
    expect(contentLength(c, c.takes[0], p)).toBe(3)
    expect(renderWindow(c, c.takes[0], p)).toBeUndefined()
    expect(renderLength(c, c.takes[0], p)).toBe(3)
  })

  it('Trim to in / out uses the line region', () => {
    const t = take('t')
    const c = cue('1', {
      takes: [t],
      comp: {
        clips: [{ id: 'cc', sourceTakeId: 't', srcIn: 0, srcOut: 3, start: 0, edits: emptyEdits() }],
        region: { in: 0.5, out: 2.5 },
      },
      output: { kind: 'comp', revision: 1 },
    })
    const p = project([c], { export: { length: 'trim' } })
    expect(renderLength(c, t, p)).toBe(2)
  })

  it('Pad to original stretches the window to the original length', () => {
    const c = cue('1')
    const p = project([c], { export: { length: 'pad' } })
    expect(renderWindow(c, c.takes[0], p)).toEqual({ in: 0, out: 3.5 })
    expect(renderLength(c, c.takes[0], p)).toBe(3.5)
  })

  it('As is ignores both the region and the original', () => {
    const c = cue('1')
    const p = project([c], { export: { length: 'asis' } })
    expect(renderWindow(c, c.takes[0], p)).toBeUndefined()
    expect(renderLength(c, c.takes[0], p)).toBe(3)
  })

  it('a mixed original extends the content to whichever is longer', () => {
    const c = cue('1', { original: { exportMode: 'on', duckDb: -12 } })
    const p = project([c], { export: { length: 'asis' } })
    expect(contentLength(c, c.takes[0], p)).toBe(3.5)
  })
})

describe('the Original lane on export', () => {
  const mixed = cue('1', { original: { exportMode: 'on', duckDb: -12 } })

  it('exportMode on with a reference mixes the original', () => {
    expect(mixesOriginal(mixed)).toBe(true)
    expect(mixesOriginal(cue('2'))).toBe(false)
    expect(mixesOriginal(cue('3', { original: { exportMode: 'on' }, referenceAudio: undefined }))).toBe(
      false
    )
  })

  it('a mixed line never takes the byte-copy fast path', () => {
    const wav = take('t', { file: { fileId: 't', relPath: 'E:/p/t.wav', format: 'wav' } })
    expect(isFastPath(wav, 'a.wav')).toBe(true)
    expect(isFastPath(wav, 'a.wav', undefined, undefined, mixed)).toBe(false)
    expect(isFastPath(wav, 'a.wav', undefined, { loudness: 'match' })).toBe(false)
    expect(isFastPath(wav, 'a.wav', undefined, { length: 'pad' })).toBe(false)
  })

  it('a take-output line gets a one-clip plan with the original voice', () => {
    const p = project([mixed])
    const plan = compPlanFor(mixed, mixed.takes[0], p)!
    expect(plan.clips).toEqual([
      { srcPath: 'E:/p/t-1.mp3', srcIn: 0, srcOut: 3, start: 0, edits: emptyEdits() },
    ])
    expect(plan.original).toEqual({ srcPath: 'E:/orig/1.wav', gainDb: -12 })
  })

  it('a line without the mix and without a window renders through the plain clip path', () => {
    const c = cue('2')
    expect(compPlanFor(c, c.takes[0], project([c]))).toBeUndefined()
  })
})

describe('offline and live schedule the same composition', () => {
  const t1 = take('t1', { edits: { ...emptyEdits(), effects: { pitch: { semitones: 2 } } } })
  const t2 = take('t2')
  const c = cue('1', {
    takes: [t1, t2],
    original: { exportMode: 'on', duckDb: -9 },
    comp: {
      clips: [
        { id: 'a', sourceTakeId: 't1', srcIn: 0.2, srcOut: 2, start: 0, edits: emptyEdits(), trackId: 'tr1' },
        { id: 'b', sourceTakeId: 't2', srcIn: 0, srcOut: 1, start: 1.8, edits: emptyEdits(), crossfade: 0.08, trackId: 'tr2' },
      ],
      region: { in: 0, out: 2.8 },
      tracks: [
        { id: 'tr1', name: 'Track 1', gainDb: -2, muted: false, solo: false },
        { id: 'tr2', name: 'Track 2', gainDb: 0, muted: false, solo: true },
      ],
    },
    output: { kind: 'comp', revision: 4 },
  })
  const p = project([c])

  it('the offline plan for exportMode on equals the live plan', () => {
    const offline = compPlanFor(c, t1, p)!
    const live = resolveCompClips(p, c, c.comp!)

    expect(offline.clips).toEqual(live.map(toClipPlan))
    expect(offline.tracks).toEqual(compTracks(c.comp!))
    expect(offline.region).toEqual({ in: 0, out: 2.8 })
    expect(offline.original).toEqual({ srcPath: 'E:/orig/1.wav', gainDb: -9 })
  })

  it('source effects travel with the source on both sides', () => {
    const offline = compPlanFor(c, t1, p)!
    expect(offline.clips[0].edits.effects).toEqual({ pitch: { semitones: 2 } })
    expect(resolveCompClips(p, c, c.comp!)[0].clip.edits.effects).toEqual({ pitch: { semitones: 2 } })
  })
})

describe('readiness', () => {
  const ready = cue('ready')
  const noAudio = cue('quiet', { takes: [], finalTakeId: undefined, output: null })
  const excluded = cue('gone', { status: 'excluded' })
  const longA = cue('long', { takes: [take('tl', { duration: 6 })], referenceDuration: 3.5 })
  const dupA = cue('dupA', { fields: { EventName: 'Same' } })
  const dupB = cue('dupB', { fields: { EventName: 'Same' } })

  const rows = (p: Project, exported = {}): Record<string, ReturnType<typeof readinessRows>[number]> =>
    Object.fromEntries(readinessRows(p, exported).map((r) => [r.cueKey, r]))

  it('classifies every line by one status', () => {
    const p = project([ready, noAudio, excluded, longA, dupA, dupB])
    const r = rows(p)
    expect(r['ready'].status).toBe('ready')
    expect(r['quiet'].status).toBe('no-audio')
    expect(r['gone'].status).toBe('excluded')
    expect(r['long'].status).toBe('longer')
    expect(r['dupA'].status).toBe('collision')
    expect(r['dupB'].status).toBe('collision')
  })

  it('over-length is reported with the delta and only outside As is', () => {
    const p = project([longA])
    expect(rows(p)['long'].overBy).toBeCloseTo(2.5, 6)
    expect(statusWords(rows(p)['long'])).toBe('Longer by 2.50s')
    expect(rows(project([longA], { export: { length: 'asis' } }))['long'].status).toBe('ready')
  })

  it('a difference under the tolerance is still Ready', () => {
    const near = cue('near', { takes: [take('tn', { duration: 3.55 })], referenceDuration: 3.5 })
    expect(rows(project([near]))['near'].status).toBe('ready')
  })

  it('changed means the output revision moved since the export that wrote it', () => {
    const p = project([ready])
    const same = rows(p, { ready: { revision: 1, version: 11 } })['ready']
    expect(same.changed).toBe(false)
    expect(same.exportedVersion).toBe(11)
    expect(statusWords(same)).toBe('Ready')

    const moved = rows(p, { ready: { revision: 0, version: 10 } })['ready']
    expect(moved.changed).toBe(true)
    expect(moved.exportedVersion).toBe(10)
    expect(statusWords(moved)).toBe('Ready · changed')
  })

  it('a line never exported is neither changed nor versioned', () => {
    const r = rows(project([ready]))['ready']
    expect(r.changed).toBe(false)
    expect(r.exportedVersion).toBeUndefined()
  })

  it('lengths come from the reference and the render window', () => {
    const r = rows(project([ready]))['ready']
    expect(r.originalLength).toBe(3.5)
    expect(r.outputLength).toBe(3)
  })

  it('the filters split the table without overlap', () => {
    const p = project([ready, noAudio, excluded, longA, dupA, dupB])
    const all = readinessRows(p, { ready: { revision: 0, version: 9 } })
    expect(all.filter((r) => matchesLineFilter(r, 'all'))).toHaveLength(6)
    expect(all.filter((r) => matchesLineFilter(r, 'ready')).map((r) => r.cueKey)).toEqual(['ready'])
    expect(all.filter((r) => matchesLineFilter(r, 'changed')).map((r) => r.cueKey)).toEqual(['ready'])
    expect(all.filter((r) => matchesLineFilter(r, 'notready')).map((r) => r.cueKey)).toEqual([
      'quiet',
      'long',
      'dupA',
      'dupB',
    ])
  })

  it('the summary counts each reason and estimates the size', () => {
    const p = project([ready, noAudio, excluded, longA, dupA, dupB])
    const s = summarize(p, readinessRows(p, { ready: { revision: 1, version: 11 } }))
    expect(s).toMatchObject({
      total: 6,
      ready: 1,
      changed: 0,
      unchanged: 1,
      done: 1,
      notReady: 4,
      noAudio: 1,
      longer: 1,
      collision: 2,
      excluded: 1,
    })
    expect(s.bytes).toBe(estimateBytes(3, undefined))
  })
})

describe('the deliver report carries revision and version per line', () => {
  it('previous entries survive an export that did not rewrite them', () => {
    const old = [
      { cueId: 'a', exportName: 'a', file: 'audio/a.wav', bytes: 1, sha256: 'x', revision: 1, version: 10 },
      { cueId: 'b', exportName: 'b', file: 'audio/b.wav', bytes: 1, sha256: 'y', revision: 1, version: 10 },
    ]
    const fresh = [
      { cueId: 'b', exportName: 'b', file: 'audio/B.WAV', bytes: 2, sha256: 'z', revision: 2, version: 11 },
    ]
    const merged = mergeExported(old, fresh)
    expect(merged.map((e) => e.cueId)).toEqual(['a', 'b'])
    expect(exportedLines({ exported: merged })).toEqual({
      a: { revision: 1, version: 10 },
      b: { revision: 2, version: 11 },
    })
  })

  it('an old report without the new fields reads as revision 0 and no version', () => {
    expect(
      exportedLines({
        exported: [{ cueId: 'a', exportName: 'a', file: 'audio/a.wav', bytes: 1, sha256: 'x' }],
      })
    ).toEqual({ a: { revision: 0 } })
  })
})

describe('project export settings round trip', () => {
  const stored = (p: Project): string => {
    const { ui: _ui, ...rest } = p
    return JSON.stringify(rest, null, 2)
  }

  const base = (): Project =>
    ({
      id: 'p',
      schemaVersion: 1,
      name: 'P',
      createdAt: '2026-01-01T00:00:00.000Z',
      media: { referenceDir: 'ref', referencePattern: '{key}.wav' },
      characters: [],
      cues: [cue('1')],
      sessions: [],
      pronunciationRules: '',
      exportTemplate: '{EventName}.{ext}',
      ui: { filter: '', search: '' },
    }) as Project

  it('a project without the field survives the file schema and a command untouched', () => {
    const p = base()
    const before = stored(p)
    const parsed = projectFileSchema.parse(JSON.parse(before)) as Record<string, unknown>
    expect(parsed).toEqual(JSON.parse(before))
    expect(parsed).not.toHaveProperty('export')
    applyProjectCommand(p, projectCommandSchema.parse({
      type: 'cue.setExcluded',
      cueId: 'c-1',
      excluded: false,
    }) as never)
    expect(stored(p)).toBe(before)
  })

  it('setExport writes, sanitizes and clears the field', () => {
    const p = base()
    applyProjectCommand(p, {
      type: 'project.setExport',
      settings: { outDir: 'D:/out', format: 'mp3-192', loudness: 'match', length: 'pad' },
    })
    expect(p.export).toEqual({ outDir: 'D:/out', format: 'mp3-192', loudness: 'match', length: 'pad' })
    expect(projectFileSchema.parse(JSON.parse(stored(p)))).toHaveProperty('export')
    applyProjectCommand(p, { type: 'project.setExport', settings: null })
    expect(p).not.toHaveProperty('export')
  })

  it('setExportTemplate refuses an empty name', () => {
    const p = base()
    expect(() =>
      applyProjectCommand(p, { type: 'project.setExportTemplate', template: '   ' })
    ).toThrow('cannot be empty')
    applyProjectCommand(p, { type: 'project.setExportTemplate', template: '{Key}.{ext}' })
    expect(p.exportTemplate).toBe('{Key}.{ext}')
  })

  it('the command schema mirrors both project commands', () => {
    for (const command of [
      { type: 'project.setExport', settings: { format: 'ogg', length: 'asis' } },
      { type: 'project.setExport', settings: null },
      { type: 'project.setExportTemplate', template: '{Key}.wav' },
    ]) {
      expect(projectCommandSchema.parse(command)).toEqual(command)
    }
  })

  it('the change set reaches the renderer copy of the project', () => {
    const p = base()
    const changes = applyProjectCommand(p, { type: 'project.setExport', settings: { format: 'ogg' } })
    expect(applyChangeSet(base(), changes).export).toEqual({ format: 'ogg' })
    const cleared = applyProjectCommand(p, { type: 'project.setExport', settings: null })
    expect(applyChangeSet(applyChangeSet(base(), changes), cleared)).not.toHaveProperty('export')
  })
})

describe('Same as source format', () => {
  it('keeps the take extension and the byte-copy path when no format is chosen', async () => {
    const { exportName, isFastPath } = await import('../src/shared/export-plan')
    const { emptyEdits } = await import('../src/shared/domain')
    const take = { id: 't', kind: 'tts', createdAt: '', file: { fileId: 'f', relPath: 'a.mp3', format: 'mp3' }, duration: 1, meta: {}, edits: emptyEdits() } as never
    const cue = { id: 'c', characterId: '', key: 'K', fields: {}, sourceText: '', text: '', status: 'generated', notes: '', takes: [take] } as never
    const project = { exportTemplate: '{Key}.{ext}' } as never
    expect(exportName(project, cue, take)).toBe('K.mp3')
    expect(isFastPath(take, 'K.mp3', undefined, undefined, cue)).toBe(true)
    expect(exportName({ exportTemplate: '{Key}.{ext}', export: { format: 'wav-48-24' } } as never, cue, take)).toBe('K.wav')
  })
})
