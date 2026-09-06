import { describe, expect, it } from 'vitest'
import {
  containerOf,
  exportName,
  extOf,
  findCollisions,
  hasEdits,
  isFastPath,
  planBatch,
} from '../src/shared/export-plan'
import { emptyEdits, type Cue, type Project, type Take } from '../src/shared/domain'

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
    expect(exportName(p, c, c.takes[0])).toBe('Event_12345__12345.wav')
  })

  it('the extension comes from the chosen format', () => {
    const t = take('t1', 'wav')
    const c = cue('9', { takes: [t], finalTakeId: t.id })
    const p = { ...project([c]), export: { format: 'mp3-192' as const } }
    expect(exportName(p, c, t)).toBe('Event_9.mp3')
  })

  it('without EventName falls back to key', () => {
    const c = cue('77', { fields: {} })
    expect(exportName(project([c]), c, c.takes[0])).toBe('77.wav')
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
    expect(coll[0].name).toBe('Same.wav')
    expect(coll[0].cueKeys).toEqual(['100', '200'])
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
