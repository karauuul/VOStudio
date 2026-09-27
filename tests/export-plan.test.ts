import { describe, expect, it } from 'vitest'
import {
  containerOf,
  DEFAULT_EXPORT_TEMPLATE,
  exportName,
  exportNamePreview,
  exportPath,
  extOf,
  findCollisions,
  hasEdits,
  hasOriginals,
  isFastPath,
  planBatch,
  timelineEchoes,
} from '../src/shared/export-plan'
import { emptyEdits, type ClipEffects, type CompClip, type CompTrack, type Cue, type CueComp, type Project, type Take } from '../src/shared/domain'
import { newLineCue } from '../src/shared/lines'

function take(id: string, format: 'mp3' | 'wav' = 'mp3', edits = emptyEdits()): Take {
  return {
    id,
    kind: 'tts',
    createdAt: '2026-01-01T00:00:00.000Z',
    file: { fileId: id, relPath: `E:/p/takes/${id}.${format}`, format },
    duration: 0,
    meta: {},
    edits,
  }
}

function cue(key: string, opts: Partial<Cue> = {}): Cue {
  const t = opts.takes?.[0] ?? take('t-' + key)
  const currentApproval = (opts.status ?? 'approved') === 'approved'
  return {
    id: 'c-' + key,
    characterId: 'ada',
    key,
    fields: { EventName: opts.fields?.EventName ?? 'Event_' + key },
    sourceText: '',
    text: '',
    status: 'approved',
    notes: '',
    takes: [t],
    finalTakeId: t.id,
    ...(currentApproval ? {
      output: { kind: 'take' as const, takeId: t.id, revision: 1 },
      approval: { textRevision: 0, outputRevision: 1, approvedAt: '2026-01-01T00:00:00.000Z' },
    } : {}),
    ...opts,
  } as Cue
}

const project = (cues: Cue[], template = '{EventName}.{ext}'): Project =>
  ({ cues, exportTemplate: template }) as Project

describe('extOf / containerOf', () => {
  it('extension in lower case, with the dot', () => {
    expect(extOf('a.MP3')).toBe('.mp3')
    expect(extOf('a.b.wav')).toBe('.wav')
  })

  it('no extension and a hidden file — empty', () => {
    expect(extOf('noext')).toBe('')
    expect(extOf('.hidden')).toBe('')
  })

  it('container only from the supported ones', () => {
    expect(containerOf('a.mp3')).toBe('mp3')
    expect(containerOf('a.wav')).toBe('wav')
    expect(containerOf('a.ogg')).toBe('ogg')
    expect(containerOf('a.flac')).toBeNull()
  })
})

describe('hasEdits', () => {
  it('empty edits — false', () => {
    expect(hasEdits(emptyEdits())).toBe(false)
  })

  it('any field makes edits non-empty', () => {
    expect(hasEdits({ ...emptyEdits(), trimStart: 0.1 })).toBe(true)
    expect(hasEdits({ ...emptyEdits(), trimEnd: 0.1 })).toBe(true)
    expect(hasEdits({ ...emptyEdits(), gainDb: -3 })).toBe(true)
    expect(hasEdits({ ...emptyEdits(), fadeIn: { duration: 0.2, shape: 'linear' } })).toBe(true)
    expect(hasEdits({ ...emptyEdits(), fadeOut: { duration: 0.2, shape: 'linear' } })).toBe(true)
    expect(hasEdits({ ...emptyEdits(), timeStretch: 1.1 })).toBe(true)
    expect(hasEdits({ ...emptyEdits(), gainEnvelope: [{ t: 0, db: -2 }] })).toBe(true)
  })

  it('timeStretch === 1 and an empty envelope do not count', () => {
    expect(hasEdits({ ...emptyEdits(), timeStretch: 1 })).toBe(false)
    expect(hasEdits({ ...emptyEdits(), gainEnvelope: [] })).toBe(false)
  })
})

describe('exportName', () => {
  it('placeholders are substituted', () => {
    const c = cue('12345')
    const p = project([c], '{EventName}__{WemId}.{ext}')
    expect(exportName(p, c, c.takes[0])).toBe('Event_12345__12345.mp3')
  })

  it('the extension comes from the chosen format', () => {
    const t = take('t1', 'wav')
    const c = cue('9', { takes: [t], finalTakeId: t.id })
    const p = { ...project([c]), export: { format: 'mp3-192' as const } }
    expect(exportName(p, c, t)).toBe('Event_9.mp3')
  })

  it('without EventName falls back to key', () => {
    const c = cue('77', { fields: {} })
    expect(exportName(project([c]), c, c.takes[0])).toBe('77.mp3')
  })

  it('{Name} is the line label: the event name, or the key when it is empty', () => {
    const c = cue('12345')
    expect(exportName(project([c], '{Name}.{ext}'), c, c.takes[0])).toBe('Event_12345.mp3')
    const bare = cue('88', { fields: { EventName: '' } })
    expect(exportName(project([bare], '{Name}.{ext}'), bare, bare.takes[0])).toBe('88.mp3')
  })

  it('the default template names a manual line after its label, as {EventName} did', () => {
    const line = { ...newLineCue('c1', 3, 'Hello'), takes: [take('t1', 'wav')] }
    const t = line.takes[0]
    expect(exportName(project([line], DEFAULT_EXPORT_TEMPLATE), line, t)).toBe('Line 3.wav')
    expect(exportName(project([line], DEFAULT_EXPORT_TEMPLATE), line, t)).toBe(
      exportName(project([line], '{EventName}.{ext}'), line, t)
    )
  })
})

describe('hasOriginals', () => {
  it('false when no line has original audio', () => {
    expect(hasOriginals({ cues: [] })).toBe(false)
    expect(hasOriginals({ cues: [cue('1'), newLineCue('c2', 2)] })).toBe(false)
  })

  it('true when any line has reference audio or a source region', () => {
    const reference = { fileId: 'r', relPath: 'E:/r.wav', format: 'wav' as const }
    expect(hasOriginals({ cues: [cue('1'), cue('2', { referenceAudio: reference })] })).toBe(true)
    expect(hasOriginals({ cues: [cue('3', { region: { sourceId: 's', in: 1, out: 2 } })] })).toBe(true)
  })

  it('true for a timing-only original and false for a zero duration', () => {
    expect(hasOriginals({ cues: [cue('4', { referenceDuration: 2.5 })] })).toBe(true)
    expect(hasOriginals({ cues: [cue('5', { referenceDuration: 0 })] })).toBe(false)
  })
})

describe('exportNamePreview', () => {
  it('is the exported file name when the line has output audio', () => {
    const c = cue('5')
    const p = project([c], '{EventName}.{ext}')
    expect(exportNamePreview(p, c)).toBe(exportName(p, c, c.takes[0]))
    expect(exportNamePreview(p, c)).toBe('Event_5.mp3')
  })

  it('drops the unknown extension when the line has no audio yet', () => {
    const c = cue('6', { takes: [], finalTakeId: undefined, output: null, fields: { exportName: 'VO_ADA_006' } })
    expect(exportNamePreview(project([c], '{exportName}.{ext}'), c)).toBe('VO_ADA_006')
    expect(exportNamePreview(project([c], '{Key}_{ext}_x'), c)).toBe('6__x')
    expect(exportNamePreview(project([c], '{Key}'), c)).toBe('6')
  })

  it('keeps dots inside names and applies a fixed output format', () => {
    const c = cue('7', { takes: [], finalTakeId: undefined, output: null, fields: { EventName: 'Mr. Smith' } })
    expect(exportNamePreview(project([c]), c)).toBe('Mr. Smith')
    const p = { ...project([c]), export: { format: 'wav-48-24' as const } }
    expect(exportNamePreview(p, c)).toBe('Mr. Smith.wav')
  })
})

describe('isFastPath — byte copy or render', () => {
  it('empty edits + the same container = a copy', () => {
    expect(isFastPath(take('t', 'mp3'), 'a.mp3')).toBe(true)
    expect(isFastPath(take('t', 'wav'), 'a.wav')).toBe(true)
  })

  it('any edits disable the fast-path', () => {
    expect(isFastPath(take('t', 'mp3', { ...emptyEdits(), gainDb: -1 }), 'a.mp3')).toBe(false)
    expect(isFastPath(take('t', 'mp3', { ...emptyEdits(), trimEnd: 0.5 }), 'a.mp3')).toBe(false)
  })

  it('a different container disables the fast-path', () => {
    expect(isFastPath(take('t', 'mp3'), 'a.wav')).toBe(false)
    expect(isFastPath(take('t', 'wav'), 'a.ogg')).toBe(false)
  })

  it('a non-empty composition kills the fast-path', () => {
    const comp = {
      clips: [
        {
          id: 'c1',
          sourceTakeId: 't',
          srcIn: 0,
          srcOut: 1,
          start: 0,
          edits: emptyEdits(),
        },
      ],
    }
    expect(isFastPath(take('t', 'mp3'), 'a.mp3', comp)).toBe(false)
  })

  it('an empty or missing composition does not touch the fast-path', () => {
    expect(isFastPath(take('t', 'mp3'), 'a.mp3', { clips: [] })).toBe(true)
    expect(isFastPath(take('t', 'mp3'), 'a.mp3', undefined)).toBe(true)
  })
})

describe('planBatch', () => {
  const approved = cue('1')
  const generated = cue('2', { status: 'generated' })
  const noFinal = cue('3', { finalTakeId: undefined, output: undefined, approval: undefined })
  const excluded = cue('4', { status: 'excluded' })
  const p = project([approved, generated, noFinal, excluded])

  it('takes everything with a valid voiced output', () => {
    expect(planBatch(p).map((x) => x.cue.key)).toEqual(['1', '2'])
  })

  it('a cue without finalTakeId ends up nowhere', () => {
    expect(planBatch(p).some((x) => x.cue.key === '3')).toBe(false)
  })

  it('an excluded cue is never exported', () => {
    expect(planBatch(p).some((x) => x.cue.key === '4')).toBe(false)
  })

  it('a composition can use its first source when there is no final take', () => {
    const t = take('source')
    const c = cue('comp', {
      takes: [t],
      finalTakeId: undefined,
      comp: { clips: [{ id: 'clip', sourceTakeId: t.id, srcIn: 0, srcOut: 1, start: 0, edits: emptyEdits() }] },
      output: { kind: 'comp', revision: 2 },
    })
    expect(planBatch(project([c])).map((x) => x.take.id)).toEqual(['source'])
  })
})

describe('collisions', () => {
  const a = cue('100', { fields: { EventName: 'Same' } })
  const b = cue('200', { fields: { EventName: 'Same' } })
  const c = cue('300', { fields: { EventName: 'Unique' } })

  it('finds exactly one collision with both keys', () => {
    const coll = findCollisions(planBatch(project([a, b, c])))
    expect(coll).toHaveLength(1)
    expect(coll[0].name).toBe('Same.mp3')
    expect(coll[0].cueKeys).toEqual(['100', '200'])
  })

  it('a name that is also a folder of another name collides', () => {
    const file = cue('500', { fields: { EventName: 'sfx' } })
    const nested = cue('600', { fields: { EventName: 'x', path: 'sfx.mp3' } })
    const planned = planBatch({ ...project([file, nested]), exportTemplate: '{Path}{EventName}.{ext}' })
    expect(planned.map((p) => p.name)).toEqual(['sfx.mp3', 'sfx.mp3/x.mp3'])
    expect(findCollisions(planned)).toEqual([{ name: 'sfx.mp3/x.mp3', cueKeys: ['500', '600'] }])
  })

  it('names differing only in case collide — the filesystem would overwrite one', () => {
    const upper = cue('400', { fields: { EventName: 'SAME' } })
    const coll = findCollisions(planBatch(project([a, upper, c])))
    expect(coll).toHaveLength(1)
    expect(coll[0].cueKeys).toEqual(['100', '400'])
  })

  it('a plan without collisions is clean', () => {
    expect(findCollisions(planBatch(project([c])))).toHaveLength(0)
  })
})

describe('{Path} export token', () => {
  it('expands to the relative folder with a trailing slash and to nothing without one', () => {
    const nested = cue('8', { fields: { EventName: 'hit', path: 'sfx/combat' } })
    const flat = cue('9', { fields: { EventName: 'hit' } })
    expect(exportName(project([nested], '{Path}{EventName}.{ext}'), nested, nested.takes[0])).toBe('sfx/combat/hit.mp3')
    expect(exportName(project([flat], '{Path}{EventName}.{ext}'), flat, flat.takes[0])).toBe('hit.mp3')
    expect(exportNamePreview(project([nested], '{Path}{EventName}.{ext}'), nested)).toBe('sfx/combat/hit.mp3')
  })

  it('leaves names unchanged for templates without the token', () => {
    const nested = cue('8', { fields: { EventName: 'hit', path: 'sfx/combat' } })
    expect(exportName(project([nested]), nested, nested.takes[0])).toBe('hit.mp3')
  })

  it('cannot escape the export folder', () => {
    expect(exportPath('../../etc')).toBe('etc/')
    expect(exportPath('/abs/dir/')).toBe('abs/dir/')
    expect(exportPath('C:\\Windows\\..\\x')).toBe('Windows/x/')
    expect(exportPath('a/./b/ ../c.')).toBe('a/b/c/')
    expect(exportPath('ab:c/d?e')).toBe('ab_c/d_e/')
    expect(exportPath('d:rel')).toBe('rel/')
    expect(exportPath('$&')).toBe('$&/')
    expect(exportPath(undefined)).toBe('')
    expect(exportPath(' / .. / ')).toBe('')
    const sneaky = cue('10', { fields: { EventName: 'x', path: '../../../outside' } })
    expect(exportName(project([sneaky], '{Path}{EventName}.{ext}'), sneaky, sneaky.takes[0])).toBe('outside/x.mp3')
  })

  it('keeps dots of folders out of the extension', () => {
    expect(extOf('v1.2/NAME')).toBe('')
    expect(extOf('v1.2/NAME.wav')).toBe('.wav')
    expect(extOf('dir/.hidden')).toBe('')
    const c = cue('11', { takes: [], finalTakeId: undefined, output: null, fields: { EventName: 'NAME', path: 'v1.2' } })
    const p = { ...project([c], '{Path}{EventName}'), export: { format: 'wav-48-24' as const } }
    expect(exportNamePreview(p, c)).toBe('v1.2/NAME.wav')
  })
})

describe('timelineEchoes', () => {
  const reverb: ClipEffects = { reverb: { mix: 0.3, size: 0.5, decay: 1 } }
  const delay: ClipEffects = { delay: { time: 0.2, feedback: 0.3, mix: 0.3 } }
  const clip = (effects?: ClipEffects): CompClip => ({ id: 'k', sourceTakeId: 't', srcIn: 0, srcOut: 1, start: 0, edits: { ...emptyEdits(), ...(effects ? { effects } : {}) } })
  const track = (extra: Partial<CompTrack> = {}): CompTrack => ({ id: 'track-1', name: 'Track 1', gainDb: 0, muted: false, solo: false, ...extra })
  const line = (effects?: ClipEffects): Cue => cue('A', { takes: [take('t', 'mp3', { ...emptyEdits(), ...(effects ? { effects } : {}) })] })
  const check = (c: Cue, comp: CueComp): boolean => timelineEchoes(project([c]), c, comp)

  it('flags delay or reverb on a clip, its take or its audible track', () => {
    expect(check(line(), { clips: [clip()] })).toBe(false)
    expect(check(line(), { clips: [clip(reverb)] })).toBe(true)
    expect(check(line(delay), { clips: [clip()] })).toBe(true)
    expect(check(line(), { clips: [clip()], tracks: [track({ effects: delay })] })).toBe(true)
  })

  it('ignores bypassed effects, other kinds and muted tracks', () => {
    expect(check(line(reverb), { clips: [clip({ reverb: { mix: 0.3, size: 0.5, decay: 1, enabled: false } })] })).toBe(false)
    expect(check(line({ eq: { lowFreq: 100, lowGain: 3, midFreq: 1000, midGain: 0, midQ: 1, highFreq: 8000, highGain: 0 } }), { clips: [clip()] })).toBe(false)
    expect(check(line(), { clips: [clip(reverb)], tracks: [track({ muted: true })] })).toBe(false)
  })
})
