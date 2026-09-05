import { describe, expect, it } from 'vitest'
import { compSchema, cueApprovalSchema, cueOutputSchema, cueRevisionFieldsSchema } from '../src/main/schemas'
import {
  approveCue,
  approvalState,
  changeCueSourceText,
  changeCueText,
  changeCompOutput,
  changeTakeOutput,
  sanitizeApproval,
  sanitizeCueOutput,
  usesCompOutput,
} from '../src/shared/approval'
import { emptyEdits, type Cue, type CueComp, type Take } from '../src/shared/domain'
import { matchesFilter } from '../src/shared/cue-filter'

const take = (id = 't1', kind: Take['kind'] = 'tts'): Take => ({
  id,
  kind,
  createdAt: '2026-08-30T00:00:00.000Z',
  file: { fileId: id, relPath: `${id}.mp3`, format: 'mp3' },
  duration: 1,
  meta: {},
  edits: emptyEdits(),
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
  takes: [take()],
  finalTakeId: 't1',
  ...over,
})

function approvedTakeCue(): Cue {
  return approveCue(changeTakeOutput(cue(), 't1'), '2026-08-30T01:00:00.000Z')
}

function approvedCompCue(): Cue {
  return approveCue(changeCompOutput(cue({ comp: comp() }), comp()), '2026-08-30T01:00:00.000Z')
}

function legacyApprovedCue(over: Partial<Cue> = {}): Cue {
  return cue({ status: 'approved', output: undefined, approval: undefined, ...over })
}

describe('revision-bound approval', () => {
  it('invalidates current approval when text changes', () => {
    const next = changeCueText(approvedTakeCue(), 'Changed')
    expect(approvalState(next)).toBe('stale')
    expect(next.approval).toBeDefined()
  })

  it('invalidates current approval when the source text changes', () => {
    const before = approvedTakeCue()
    const next = changeCueSourceText(before, 'Changed source')
    expect(next.sourceText).toBe('Changed source')
    expect(next.text).toBe(before.text)
    expect(next.textRevision).toBe((before.textRevision ?? 0) + 1)
    expect(approvalState(next)).toBe('stale')
    expect(changeCueSourceText(before, before.sourceText)).toBe(before)
  })

  it('invalidates current approval when the final take changes', () => {
    const before = approvedTakeCue()
    const next = changeTakeOutput({ ...before, takes: [...before.takes, take('t2')] }, 't2')
    expect(approvalState(next)).toBe('stale')
  })

  it('preserves a legacy approval when reselecting its existing final take', () => {
    const before = legacyApprovedCue()
    const next = changeTakeOutput(before, 't1')
    expect(next).toBe(before)
    expect(next.status).toBe('approved')
    expect(approvalState(next)).toBe('approved')
    expect(next.output).toBeUndefined()
    expect(next.approval).toBeUndefined()
  })

  it('persists a selected take as both playback and export output', () => {
    const next = changeTakeOutput({ ...cue(), takes: [take('t1'), take('t2')] }, 't2')
    expect(next.finalTakeId).toBe('t2')
    expect(next.output).toEqual({ kind: 'take', takeId: 't2', revision: 1 })
  })

  it.each([
    ['comp', (c: Cue) => changeCompOutput(c, { ...c.comp!, clips: [...c.comp!.clips, { ...c.comp!.clips[0], id: 'c2', start: 1 }] })],
    ['region', (c: Cue) => changeCompOutput(c, { ...c.comp!, region: { in: 0.1, out: 0.9 } })],
    ['processing', (c: Cue) => changeCompOutput(c, { ...c.comp!, clips: [{ ...c.comp!.clips[0], edits: { ...c.comp!.clips[0].edits, gainDb: -3 } }] })],
  ])('invalidates current approval after %s changes', (_name, mutate) => {
    expect(approvalState(mutate(approvedCompCue()))).toBe('stale')
  })

  it('rejects approval without a valid voiced output', () => {
    expect(() => approveCue(cue({ takes: [], finalTakeId: undefined }), '2026-08-30T01:00:00.000Z')).toThrow(/voiced output/i)
    expect(() => approveCue(cue({ takes: [take('raw', 'recording')], finalTakeId: 'raw' }), '2026-08-30T01:00:00.000Z')).toThrow(/voiced output/i)
  })

  it('materializes the existing comp precedence when a legacy voiced cue is approved', () => {
    const next = approveCue(cue({ comp: comp() }), '2026-08-30T01:00:00.000Z')
    expect(next.output).toEqual({ kind: 'comp', revision: 1 })
    expect(approvalState(next)).toBe('approved')
  })

  it('uses explicit output instead of an old composition left in take history', () => {
    const legacy = cue({ comp: comp() })
    expect(usesCompOutput(legacy)).toBe(true)
    expect(usesCompOutput(changeTakeOutput(legacy, 't1'))).toBe(false)
  })

  it('derives voiced, stale approval, needs review, and current approval honestly', () => {
    expect(approvalState(cue())).toBe('needs-review')
    expect(approvalState(legacyApprovedCue())).toBe('approved')
    expect(matchesFilter(legacyApprovedCue(), 'appr')).toBe(true)
    expect(approvalState(approvedTakeCue())).toBe('approved')
    expect(approvalState(changeCueText(approvedTakeCue(), 'Changed'))).toBe('stale')
    expect(approvalState(cue({ takes: [], finalTakeId: undefined }))).toBe('unvoiced')
  })

  it.each([
    ['text', (c: Cue) => changeCueText(c, 'Changed')],
    ['take', (c: Cue) => changeTakeOutput({ ...c, takes: [...c.takes, take('t2')] }, 't2')],
    ['comp', (c: Cue) => changeCompOutput(c, comp())],
    ['region', (c: Cue) => changeCompOutput(c, { ...comp(), region: { in: 0.1, out: 0.9 } })],
    ['processing', (c: Cue) => changeCompOutput(c, { ...comp(), clips: [{ ...comp().clips[0], edits: { ...emptyEdits(), gainDb: -3 } }] })],
  ])('invalidates a legacy approval after a real %s change', (_name, mutate) => {
    expect(approvalState(mutate(legacyApprovedCue()))).toBe('needs-review')
  })
})

describe('optional persisted fields', () => {
  it('sanitizes revisions without adding fields to old cues', () => {
    const old = cue()
    const snapshot = JSON.stringify(old)
    expect(sanitizeCueOutput(undefined)).toBeUndefined()
    expect(sanitizeApproval(undefined)).toBeUndefined()
    expect(JSON.stringify(old)).toBe(snapshot)
    expect(JSON.stringify(cueRevisionFieldsSchema.parse({}))).toBe('{}')
  })

  it('roundtrips output and approval through their zod mirrors', () => {
    const current = approvedTakeCue()
    expect(cueOutputSchema.parse(JSON.parse(JSON.stringify(current.output)))).toEqual(current.output)
    expect(cueApprovalSchema.parse(JSON.parse(JSON.stringify(current.approval)))).toEqual(current.approval)
  })

  it('keeps old comp JSON byte-identical through the existing schema', () => {
    const old = comp()
    expect(JSON.stringify(compSchema.parse(JSON.parse(JSON.stringify(old))))).toBe(JSON.stringify(old))
  })
})
