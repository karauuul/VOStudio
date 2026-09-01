import { describe, expect, it } from 'vitest'
import {
  containerOf,
  exportName,
  extOf,
  findCollisions,
  hasEdits,
  isFastPath,
  planBatch,
  resolvePlan,
  withWemIdSuffix,
  type PlannedTake,
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
    expect(exportName(p, c, c.takes[0])).toBe('Event_12345__12345.mp3')
  })

  it('the extension comes from the take file format', () => {
    const t = take('t1', 'wav')
    const c = cue('9', { takes: [t], finalTakeId: t.id })
    expect(exportName(project([c]), c, t)).toBe('Event_9.wav')
  })

  it('without EventName falls back to key', () => {
    const c = cue('77', { fields: {} })
    expect(exportName(project([c]), c, c.takes[0])).toBe('77.mp3')
  })
})

describe('withWemIdSuffix', () => {
  it('the suffix goes BEFORE the extension', () => {
    expect(withWemIdSuffix('Event.mp3', '123')).toBe('Event__123.mp3')
  })

  it('no extension — just appended at the end', () => {
    expect(withWemIdSuffix('Event', '123')).toBe('Event__123')
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

describe('planBatch — scope', () => {
  const approved = cue('1')
  const generated = cue('2', { status: 'generated' })
  const noFinal = cue('3', { finalTakeId: undefined, output: undefined, approval: undefined })
  const p = project([approved, generated, noFinal])

  it('approved takes only the approved ones', () => {
    expect(planBatch(p, 'approved').map((x) => x.cue.key)).toEqual(['1'])
  })

  it('keeps a valid legacy approved cue in approved exports', () => {
    const legacy = cue('legacy', { output: undefined, approval: undefined })
    expect(planBatch(project([legacy]), 'approved').map((x) => x.cue.key)).toEqual(['legacy'])
  })

  it('all-final takes everything with a final take', () => {
    expect(planBatch(p, 'all-final').map((x) => x.cue.key)).toEqual(['1', '2'])
  })

  it('a cue without finalTakeId ends up nowhere', () => {
    expect(planBatch(p, 'all-final').some((x) => x.cue.key === '3')).toBe(false)
  })

  it('approved composition can use its first source when there is no final take', () => {
    const t = take('source')
    const c = cue('comp', {
      takes: [t],
      finalTakeId: undefined,
      comp: { clips: [{ id: 'clip', sourceTakeId: t.id, srcIn: 0, srcOut: 1, start: 0, edits: emptyEdits() }] },
      output: { kind: 'comp', revision: 2 },
      approval: { textRevision: 0, outputRevision: 2, approvedAt: '2026-01-01T00:00:00.000Z' },
    })
    expect(planBatch(project([c]), 'approved').map((x) => x.take.id)).toEqual(['source'])
  })
})

describe('collisions and strategies', () => {
  const a = cue('100', { fields: { EventName: 'Same' } })
  const b = cue('200', { fields: { EventName: 'Same' } })
  const c = cue('300', { fields: { EventName: 'Unique' } })
  const planned: PlannedTake[] = planBatch(project([a, b, c]), 'approved')

  it('finds exactly one collision with both keys', () => {
    const coll = findCollisions(planned)
    expect(coll).toHaveLength(1)
    expect(coll[0].name).toBe('Same.mp3')
    expect(coll[0].cueKeys).toEqual(['100', '200'])
  })

  it('without a strategy — we write NOTHING, not even the conflict-free ones', () => {
    const r = resolvePlan(planned, {})
    expect(r.jobs).toHaveLength(0)
    expect(r.uncovered).toHaveLength(1)
  })

  it('suffix-wemid: both are kept with a suffix', () => {
    const r = resolvePlan(planned, { 'Same.mp3': 'suffix-wemid' })
    expect(r.uncovered).toHaveLength(0)
    expect(r.jobs.map((j) => j.name).sort()).toEqual([
      'Same__100.mp3',
      'Same__200.mp3',
      'Unique.mp3',
    ])
    expect(r.skipped).toBe(0)
  })

  it('skip: the conflicting ones are dropped, the rest is written', () => {
    const r = resolvePlan(planned, { 'Same.mp3': 'skip' })
    expect(r.jobs.map((j) => j.name)).toEqual(['Unique.mp3'])
    expect(r.skipped).toBe(2)
  })

  it('reuse: the LAST one stays, the rest counts as skipped', () => {
    const r = resolvePlan(planned, { 'Same.mp3': 'reuse' })
    expect(r.jobs).toHaveLength(2)
    expect(r.jobs.find((j) => j.name === 'Same.mp3')?.cue.key).toBe('200')
    expect(r.skipped).toBe(1)
  })

  it('names differing only in case collide — the filesystem would overwrite one', () => {
    const upper = cue('400', { fields: { EventName: 'SAME' } })
    const mixed = planBatch(project([a, upper, c]), 'approved')
    const coll = findCollisions(mixed)
    expect(coll).toHaveLength(1)
    expect(coll[0].cueKeys).toEqual(['100', '400'])
  })

  it('a case-differing strategy key still resolves its collision', () => {
    const upper = cue('400', { fields: { EventName: 'SAME' } })
    const mixed = planBatch(project([a, upper, c]), 'approved')
    const r = resolvePlan(mixed, { 'same.MP3': 'skip' })
    expect(r.uncovered).toHaveLength(0)
    expect(r.jobs.map((j) => j.name)).toEqual(['Unique.mp3'])
    expect(r.skipped).toBe(2)
  })

  it('a plan without collisions passes straight through', () => {
    const only = planBatch(project([c]), 'approved')
    const r = resolvePlan(only)
    expect(r.jobs).toHaveLength(1)
    expect(r.uncovered).toHaveLength(0)
    expect(r.skipped).toBe(0)
  })
})
