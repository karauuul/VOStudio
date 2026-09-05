import { describe, expect, it } from 'vitest'
import { preflightPlan } from '../src/shared/export-preflight'
import { emptyEdits, type Cue, type CueComp, type Project, type Take } from '../src/shared/domain'

function take(id: string): Take {
  return {
    id,
    kind: 'tts',
    createdAt: '2026-01-01T00:00:00.000Z',
    file: { fileId: id, relPath: `E:/p/takes/${id}.mp3`, format: 'mp3' },
    duration: 1,
    meta: {},
    edits: emptyEdits(),
  }
}

function comp(takeIds: string[]): CueComp {
  return {
    clips: takeIds.map((id, i) => ({
      id: 'clip-' + id,
      sourceTakeId: id,
      srcIn: 0,
      srcOut: 1,
      start: i,
      edits: emptyEdits(),
    })),
  }
}

function cue(key: string, event: string, over: Partial<Cue> = {}): Cue {
  const t = take('t-' + key)
  return {
    id: 'c-' + key,
    characterId: 'ada',
    key,
    fields: { EventName: event },
    sourceText: '',
    text: 'text',
    status: 'approved',
    notes: '',
    referenceAudio: { fileId: 'r-' + key, relPath: `E:/p/ref/${key}.wav`, format: 'wav' },
    takes: [t],
    finalTakeId: t.id,
    output: { kind: 'take', takeId: t.id, revision: 1 },
    approval: { textRevision: 0, outputRevision: 1, approvedAt: '2026-01-01T00:00:00.000Z' },
    ...over,
  } as Cue
}

const project = (cues: Cue[], exportTemplate = '{EventName}.{ext}'): Project =>
  ({ cues, exportTemplate }) as Project

describe('preflightPlan scope and counts', () => {
  const cues = [
    cue('1', 'Alpha'),
    cue('2', 'Beta', { status: 'generated', approval: null }),
    cue('3', 'Gamma', { status: 'excluded', takes: [], finalTakeId: undefined, output: null, approval: null }),
    cue('4', 'Delta', { status: 'translated', takes: [], finalTakeId: undefined, output: null, approval: null }),
    cue('5', 'Epsilon', { text: 'changed', textRevision: 7 }),
  ]
  const p = project(cues)

  it('counts approved and unapproved outputs independently of the chosen scope', () => {
    const approved = preflightPlan(p, 'approved')
    const all = preflightPlan(p, 'all-final')
    expect(approved.approved).toBe(1)
    expect(approved.unapproved).toBe(2)
    expect(all.approved).toBe(1)
    expect(all.unapproved).toBe(2)
    expect(approved.eligible).toBe(1)
    expect(all.eligible).toBe(3)
  })

  it('reports readiness groups over the whole project', () => {
    const r = preflightPlan(p, 'approved')
    expect(r.stale).toBe(1)
    expect(r.missingOutput).toBe(1)
    expect(r.excluded).toBe(1)
  })

  it('resolves a file name for every eligible cue', () => {
    expect(preflightPlan(p, 'approved').names).toEqual([
      { cueId: 'c-1', cueKey: '1', name: 'Alpha.mp3' },
    ])
    expect(preflightPlan(p, 'all-final').names.map((n) => n.name)).toEqual([
      'Alpha.mp3',
      'Beta.mp3',
      'Epsilon.mp3',
    ])
  })

  it('counts cues without reference audio inside the scope only', () => {
    const noRef = project([cue('1', 'Alpha', { referenceAudio: undefined }), cue('2', 'Beta', { status: 'generated', approval: null, referenceAudio: undefined })])
    expect(preflightPlan(noRef, 'approved').missingReference).toBe(1)
    expect(preflightPlan(noRef, 'all-final').missingReference).toBe(2)
  })
})

describe('preflightPlan collisions', () => {
  const p = project([cue('1', 'Same'), cue('2', 'Same')])

  it('lists a collision with its colliding name and cue keys and keeps planned names', () => {
    const r = preflightPlan(p, 'approved')
    expect(r.collisions).toEqual([{ name: 'Same.mp3', cueKeys: ['1', '2'] }])
    expect(r.names.map((n) => n.name)).toEqual(['Same.mp3', 'Same.mp3'])
  })

  it('applies a chosen strategy to the resolved names', () => {
    expect(
      preflightPlan(p, 'approved', { 'Same.mp3': 'suffix-wemid' }).names.map((n) => n.name)
    ).toEqual(['Same__1.mp3', 'Same__2.mp3'])
    const skipped = preflightPlan(p, 'approved', { 'Same.mp3': 'skip' })
    expect(skipped.names).toEqual([])
    expect(skipped.skipped).toBe(2)
    const reuse = preflightPlan(p, 'approved', { 'Same.mp3': 'reuse' })
    expect(reuse.names.map((n) => n.cueKey)).toEqual(['2'])
    expect(reuse.skipped).toBe(1)
  })
})

describe('preflightPlan sources', () => {
  it('lists the take file of a take output and every clip source of a composition output', () => {
    const takes = [take('a'), take('b')]
    const compCue = cue('2', 'Comp', {
      takes,
      finalTakeId: 'a',
      comp: comp(['a', 'b']),
      output: { kind: 'comp', revision: 1 },
    })
    const r = preflightPlan(project([cue('1', 'Alpha'), compCue]), 'all-final')
    expect(r.sources.map((s) => s.path)).toEqual([
      'E:/p/takes/t-1.mp3',
      'E:/p/takes/a.mp3',
      'E:/p/takes/b.mp3',
    ])
  })

  it('marks out-of-scope sources so they cannot block the chosen scope', () => {
    const p = project([cue('1', 'Alpha'), cue('2', 'Beta', { status: 'generated', approval: null })])
    expect(preflightPlan(p, 'approved').sources.map((s) => s.inScope)).toEqual([true, false])
    expect(preflightPlan(p, 'all-final').sources.map((s) => s.inScope)).toEqual([true, true])
  })

  it('takes collision-skipped sources out of scope', () => {
    const p = project([cue('1', 'Same'), cue('2', 'Same')])
    const skipped = preflightPlan(p, 'all-final', { 'Same.mp3': 'skip' })
    expect(skipped.sources.map((s) => s.inScope)).toEqual([false, false])
    const reused = preflightPlan(p, 'all-final', { 'Same.mp3': 'reuse' })
    expect(reused.sources.map((s) => s.inScope)).toEqual([false, true])
  })
})

describe('preflightPlan container validation', () => {
  it('flags a resolved name whose container is not supported', () => {
    const r = preflightPlan(project([cue('1', 'Alpha')], '{EventName}.bin'), 'approved')
    expect(r.invalid).toEqual([{ cueId: 'c-1', cueKey: '1', name: 'Alpha.bin' }])
  })

  it('accepts the supported containers', () => {
    expect(preflightPlan(project([cue('1', 'Alpha')], '{EventName}.wav'), 'approved').invalid).toEqual([])
  })
})
