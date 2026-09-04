import { describe, expect, it } from 'vitest'
import {
  approvalState,
  approveCue,
  changeCompOutput,
  changeCueText,
  changeTakeOutput,
  type CueApprovalState,
} from '../src/shared/approval'
import { emptyEdits, type Cue, type CueComp, type CueStatus, type Take } from '../src/shared/domain'
import { matchesFilter } from '../src/renderer/CueList'

const APPROVED_AT = '2026-08-30T01:00:00.000Z'
const PARTITION = ['notgen', 'review', 'appr', 'excluded']

const take = (id = 't1'): Take => ({
  id,
  kind: 'tts',
  createdAt: '2026-08-30T00:00:00.000Z',
  file: { fileId: id, relPath: `${id}.mp3`, format: 'mp3' },
  duration: 1,
  meta: {},
  edits: emptyEdits(),
})

const comp = (): CueComp => ({
  clips: [{ id: 'c1', sourceTakeId: 't1', srcIn: 0, srcOut: 1, start: 0, edits: emptyEdits() }],
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

const unvoiced = (status: CueStatus): Cue => cue({ takes: [], finalTakeId: undefined, status })
const needsReview = (status: CueStatus): Cue => cue({ status })
const approvedCue = (status: CueStatus): Cue => ({
  ...approveCue(changeTakeOutput(cue(), 't1'), APPROVED_AT),
  status,
})
const staleCue = (status: CueStatus): Cue => ({
  ...changeCueText(approveCue(changeTakeOutput(cue(), 't1'), APPROVED_AT), 'Changed'),
  status,
})
const staleWithoutOutput = (): Cue =>
  changeCompOutput(
    approveCue(changeCompOutput(cue({ comp: comp(), finalTakeId: undefined }), comp()), APPROVED_AT),
    null
  )

describe('review filter', () => {
  it.each([
    ['needs-review', needsReview('generated'), true],
    ['stale with output', staleCue('generated'), true],
    ['stale without output', staleWithoutOutput(), false],
    ['unvoiced', unvoiced('translated'), false],
    ['approved', approvedCue('approved'), false],
    ['excluded', unvoiced('excluded'), false],
    ['excluded with output', needsReview('excluded'), false],
  ])('%s', (_name, c, expected) => {
    expect(matchesFilter(c, 'review')).toBe(expected)
  })
})

describe('queue partition', () => {
  const rows: Array<[CueApprovalState, CueStatus, Cue]> = [
    ['unvoiced', 'empty', unvoiced('empty')],
    ['unvoiced', 'translated', unvoiced('translated')],
    ['unvoiced', 'generated', unvoiced('generated')],
    ['unvoiced', 'approved', unvoiced('approved')],
    ['unvoiced', 'excluded', unvoiced('excluded')],
    ['needs-review', 'empty', needsReview('empty')],
    ['needs-review', 'translated', needsReview('translated')],
    ['needs-review', 'generated', needsReview('generated')],
    ['needs-review', 'excluded', needsReview('excluded')],
    ['stale', 'empty', staleCue('empty')],
    ['stale', 'translated', staleCue('translated')],
    ['stale', 'generated', staleCue('generated')],
    ['stale', 'approved', staleCue('approved')],
    ['stale', 'excluded', staleCue('excluded')],
    ['stale', 'translated', staleWithoutOutput()],
    ['approved', 'empty', approvedCue('empty')],
    ['approved', 'translated', approvedCue('translated')],
    ['approved', 'generated', approvedCue('generated')],
    ['approved', 'approved', approvedCue('approved')],
    ['approved', 'excluded', approvedCue('excluded')],
  ]

  it.each(rows)('%s cue with status %s matches exactly one queue', (state, status, c) => {
    expect(approvalState(c)).toBe(state)
    expect(c.status).toBe(status)
    expect(PARTITION.filter((f) => matchesFilter(c, f))).toHaveLength(1)
  })

  it('covers every approval state and every status', () => {
    expect(new Set(rows.map((r) => r[0]))).toEqual(
      new Set<CueApprovalState>(['unvoiced', 'needs-review', 'stale', 'approved'])
    )
    expect(new Set(rows.map((r) => r[1]))).toEqual(
      new Set<CueStatus>(['empty', 'translated', 'generated', 'approved', 'excluded'])
    )
  })
})

describe('unknown filter ids from an old ui.json', () => {
  it('falls through to matching everything', () => {
    expect(matchesFilter(needsReview('generated'), 'translated')).toBe(false)
    expect(matchesFilter(needsReview('generated'), 'some-removed-filter')).toBe(true)
    expect(matchesFilter(unvoiced('excluded'), '')).toBe(true)
  })
})
