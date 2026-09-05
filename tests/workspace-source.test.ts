import { describe, expect, it } from 'vitest'
import { approvalState, approveCue, changeCompOutput, changeTakeOutput } from '../src/shared/approval'
import { emptyEdits, type Cue, type CueComp, type Take } from '../src/shared/domain'
import {
  cueDecision,
  initialPreviewSource,
  outputSource,
  resolvePreview,
  setFinalEligible,
  shouldSelectCandidate,
  type PreviewSource,
} from '../src/shared/workspace-source'

const take = (id: string, over: Partial<Take> = {}): Take => ({
  id,
  kind: 'tts',
  createdAt: '2026-08-30T00:00:00.000Z',
  file: { fileId: id, relPath: `${id}.mp3`, format: 'mp3' },
  duration: 1,
  meta: {},
  edits: emptyEdits(),
  ...over,
})

const comp = (sourceTakeId = 't1'): CueComp => ({
  clips: [{ id: 'c1', sourceTakeId, srcIn: 0, srcOut: 1, start: 0, edits: emptyEdits() }],
})

const cue = (over: Partial<Cue> = {}): Cue => ({
  id: 'cue-1',
  characterId: 'ada',
  key: '1',
  fields: {},
  sourceText: 'Source',
  text: 'Text',
  status: 'generated',
  notes: '',
  takes: [take('t1')],
  ...over,
})

describe('initialPreviewSource', () => {
  it('follows an explicit take output', () => {
    const c = changeTakeOutput(cue({ takes: [take('t1'), take('t2')] }), 't1')
    expect(initialPreviewSource(c)).toEqual({ kind: 'take', takeId: 't1' })
  })

  it('follows an explicit comp output', () => {
    const c = changeCompOutput(cue({ comp: comp() }), comp())
    expect(initialPreviewSource(c)).toEqual({ kind: 'comp' })
  })

  it('prefers a legacy comp over the legacy final take', () => {
    const c = cue({ comp: comp(), finalTakeId: 't1', output: undefined })
    expect(initialPreviewSource(c)).toEqual({ kind: 'comp' })
  })

  it('follows the legacy final take when no comp is usable', () => {
    const c = cue({ finalTakeId: 't1', output: undefined })
    expect(initialPreviewSource(c)).toEqual({ kind: 'take', takeId: 't1' })
  })

  it('falls back to the newest take for an explicit null output', () => {
    const c = cue({
      takes: [take('t1'), take('t2', { createdAt: '2026-08-30T02:00:00.000Z' })],
      finalTakeId: 't1',
      output: null,
    })
    expect(initialPreviewSource(c)).toEqual({ kind: 'take', takeId: 't2' })
  })

  it('falls back when the explicit take output is dangling', () => {
    const c = cue({ takes: [take('t1')], output: { kind: 'take', takeId: 'gone', revision: 3 } })
    expect(initialPreviewSource(c)).toEqual({ kind: 'take', takeId: 't1' })
  })

  it('ignores soft-deleted takes', () => {
    const c = cue({
      takes: [
        take('t1'),
        take('t2', { createdAt: '2026-08-30T03:00:00.000Z', deletedAt: '2026-08-30T04:00:00.000Z' }),
      ],
      output: null,
    })
    expect(initialPreviewSource(c)).toEqual({ kind: 'take', takeId: 't1' })
  })

  it('picks the newest live take regardless of array order', () => {
    const c = cue({
      takes: [
        take('t1', { createdAt: '2026-08-30T05:00:00.000Z' }),
        take('t2', { createdAt: '2026-08-30T01:00:00.000Z' }),
      ],
      output: null,
    })
    expect(initialPreviewSource(c)).toEqual({ kind: 'take', takeId: 't1' })
  })

  it('falls back to a recording only when no voiced take exists', () => {
    const withVoiced = cue({
      takes: [
        take('t1'),
        take('r1', { kind: 'recording', createdAt: '2026-08-30T06:00:00.000Z' }),
      ],
      output: null,
    })
    expect(initialPreviewSource(withVoiced)).toEqual({ kind: 'take', takeId: 't1' })
    const recordingOnly = cue({ takes: [take('r1', { kind: 'recording' })], output: null })
    expect(initialPreviewSource(recordingOnly)).toEqual({ kind: 'take', takeId: 'r1' })
  })

  it('returns none without takes', () => {
    expect(initialPreviewSource(cue({ takes: [], status: 'translated' }))).toEqual({ kind: 'none' })
  })
})

describe('resolvePreview', () => {
  it('maps a take to a one-clip composition carrying its trim', () => {
    const trimmed = take('t1', {
      duration: 4,
      edits: { ...emptyEdits(), trimStart: 0.5, trimEnd: 1 },
    })
    const resolved = resolvePreview(cue({ takes: [trimmed] }), { kind: 'take', takeId: 't1' })
    expect(resolved.take).toBe(trimmed)
    expect(resolved.comp?.clips).toHaveLength(1)
    expect(resolved.comp?.clips[0]).toMatchObject({
      sourceTakeId: 't1',
      srcIn: 0.5,
      srcOut: 3,
      start: 0,
    })
    expect(resolved.comp?.clips[0].edits.trimStart).toBe(0)
    expect(resolved.comp?.clips[0].edits.trimEnd).toBe(0)
  })

  it('uses a measured duration when the model duration is missing', () => {
    const c = cue({ takes: [take('t1', { duration: 0 })] })
    expect(resolvePreview(c, { kind: 'take', takeId: 't1' }).comp).toBeUndefined()
    expect(resolvePreview(c, { kind: 'take', takeId: 't1' }, 2).comp?.clips[0].srcOut).toBe(2)
  })

  it('returns the source without a take for a dangling reference', () => {
    const resolved = resolvePreview(cue(), { kind: 'take', takeId: 'gone' })
    expect(resolved).toEqual({ source: { kind: 'take', takeId: 'gone' } })
  })

  it('returns the source without a take for a soft-deleted take', () => {
    const c = cue({ takes: [take('t1', { deletedAt: '2026-08-30T04:00:00.000Z' })] })
    expect(resolvePreview(c, { kind: 'take', takeId: 't1' }).take).toBeUndefined()
  })

  it('returns the comp of a comp source even when the output is a take', () => {
    const c = changeTakeOutput(cue({ comp: comp() }), 't1')
    expect(resolvePreview(c, { kind: 'comp' }).comp).toBe(c.comp)
  })

  it('returns nothing for a comp source without clips', () => {
    expect(resolvePreview(cue(), { kind: 'comp' })).toEqual({ source: { kind: 'comp' } })
    expect(resolvePreview(cue({ comp: { clips: [] } }), { kind: 'comp' }).comp).toBeUndefined()
  })

  it('resolves nothing for the none source', () => {
    expect(resolvePreview(cue(), { kind: 'none' })).toEqual({ source: { kind: 'none' } })
  })
})

describe('outputSource', () => {
  it('reports the explicit take and comp outputs', () => {
    expect(outputSource(changeTakeOutput(cue(), 't1'))).toEqual({ kind: 'take', takeId: 't1' })
    expect(outputSource(changeCompOutput(cue({ comp: comp() }), comp()))).toEqual({ kind: 'comp' })
  })

  it('reports nothing for an explicit null output', () => {
    expect(outputSource(cue({ output: null }))).toBeNull()
  })

  it('follows the legacy final take without an output field', () => {
    expect(outputSource(cue({ finalTakeId: 't1', output: undefined }))).toEqual({
      kind: 'take',
      takeId: 't1',
    })
  })
})

describe('setFinalEligible', () => {
  it('accepts a voiced take that is not the output', () => {
    const c = changeTakeOutput(cue({ takes: [take('t1'), take('t2')] }), 't1')
    expect(setFinalEligible(c, { kind: 'take', takeId: 't2' })).toBe(true)
    expect(setFinalEligible(c, { kind: 'take', takeId: 't1' })).toBe(false)
  })

  it('rejects a raw recording and a missing take', () => {
    const c = cue({ takes: [take('r1', { kind: 'recording' })], output: null })
    expect(setFinalEligible(c, { kind: 'take', takeId: 'r1' })).toBe(false)
    expect(setFinalEligible(c, { kind: 'take', takeId: 'gone' })).toBe(false)
  })

  it('accepts a retained comp that is not the output', () => {
    const c = changeTakeOutput(cue({ comp: comp() }), 't1')
    expect(setFinalEligible(c, { kind: 'comp' })).toBe(true)
    expect(setFinalEligible(changeCompOutput(c, comp()), { kind: 'comp' })).toBe(false)
    expect(setFinalEligible(cue(), { kind: 'comp' })).toBe(false)
  })
})

describe('cueDecision', () => {
  it('offers Set final while a different source is previewed', () => {
    const c = approveCue(changeTakeOutput(cue({ takes: [take('t1'), take('t2')] }), 't1'))
    expect(cueDecision(c, { kind: 'take', takeId: 't2' })).toBe('set-final')
    expect(cueDecision(c, { kind: 'take', takeId: 't1' })).toBe('approved')
  })

  it('offers Approve for an unapproved output and after a stale approval', () => {
    const c = changeTakeOutput(cue({ takes: [take('t1'), take('t2')] }), 't1')
    expect(cueDecision(c, { kind: 'take', takeId: 't1' })).toBe('approve')
    const stale = changeTakeOutput(approveCue(c), 't2')
    expect(approvalState(stale)).toBe('stale')
    expect(cueDecision(stale, { kind: 'take', takeId: 't2' })).toBe('approve')
  })

  it('has no action without an output or for an excluded cue', () => {
    expect(cueDecision(cue({ takes: [], output: null }), { kind: 'none' })).toBe('none')
    const c = approveCue(changeTakeOutput(cue(), 't1'))
    expect(cueDecision({ ...c, status: 'excluded' }, { kind: 'take', takeId: 't1' })).toBe('none')
  })
})

describe('shouldSelectCandidate', () => {
  const base = {
    active: true,
    take: take('new'),
    submitted: { kind: 'take', takeId: 't1' } as PreviewSource,
    current: { kind: 'take', takeId: 't1' } as PreviewSource,
    playing: false,
    recording: false,
  }

  it('selects a finished candidate on an untouched cue', () => {
    expect(shouldSelectCandidate(base)).toBe(true)
  })

  it('keeps the preview when the user changed the source, left the cue, or is busy', () => {
    expect(shouldSelectCandidate({ ...base, current: { kind: 'comp' } })).toBe(false)
    expect(shouldSelectCandidate({ ...base, active: false })).toBe(false)
    expect(shouldSelectCandidate({ ...base, playing: true })).toBe(false)
    expect(shouldSelectCandidate({ ...base, recording: true })).toBe(false)
    expect(shouldSelectCandidate({ ...base, submitted: null })).toBe(false)
  })

  it('ignores raw recordings and fragment takes', () => {
    expect(shouldSelectCandidate({ ...base, take: take('r1', { kind: 'recording' }) })).toBe(false)
    expect(shouldSelectCandidate({ ...base, take: take('f1', { fragment: true }) })).toBe(false)
  })
})
