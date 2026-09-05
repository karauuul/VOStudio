import { describe, expect, it } from 'vitest'
import {
  approvalState,
  approveCue,
  changeCompOutput,
  changeCueText,
  changeTakeOutput,
  type CueApprovalState,
} from '../src/shared/approval'
import {
  emptyEdits,
  type Character,
  type Cue,
  type CueComp,
  type CueStatus,
  type Take,
} from '../src/shared/domain'
import {
  FILTERS,
  filterCounts,
  filterCues,
  matchesFilter,
  reviewGeneration,
  reviewLabel,
} from '../src/shared/cue-filter'

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

describe('presentation', () => {
  it('names every shared filter', () => {
    expect(FILTERS.map((f) => `${f.id}:${f.label}`)).toEqual([
      'work:Working set',
      'notgen:Needs output',
      'review:Review',
      'gen:Outputs',
      'appr:Approved',
      'sugg:Suggestions',
      'excluded:Excluded',
      'all:All',
    ])
  })

  it.each([
    ['approved', approvedCue('approved'), 'Approved'],
    ['stale', staleCue('generated'), 'Stale approval'],
    ['needs review', needsReview('generated'), 'Needs review'],
    ['candidate without output', cue({ output: null }), 'Needs output'],
    ['no audio', unvoiced('translated'), 'Needs voice'],
    ['excluded', unvoiced('excluded'), 'Excluded'],
  ])('labels a %s cue', (_name, c, expected) => {
    expect(reviewLabel(c)).toBe(expected)
  })
})

describe('counts', () => {
  const rows = [
    cue({ id: 'a', fields: { EventName: 'Intro_1' } }),
    cue({ id: 'b', fields: { EventName: 'Intro_2' }, characterId: 'bob' }),
    unvoiced('translated'),
  ]

  it('uses the same search and character scope as the results', () => {
    for (const search of ['', 'intro']) {
      for (const character of ['all', 'ada']) {
        const counts = filterCounts(rows, search, character)
        for (const f of FILTERS) {
          expect(counts[f.id]).toBe(filterCues(rows, f.id, search, character).length)
        }
      }
    }
    expect(filterCounts(rows, 'intro', 'ada')['work']).toBe(1)
    expect(filterCounts(rows, '', 'all')['work']).toBe(3)
  })
})

describe('bulk generation review', () => {
  const characters: Pick<Character, 'id' | 'provider'>[] = [
    { id: 'ada', provider: { providerId: 'elevenlabs', voiceId: 'v1', ttsModel: '', stsModel: '' } },
    { id: 'mute', provider: { providerId: 'elevenlabs', voiceId: '', ttsModel: '', stsModel: '' } },
  ]

  it('queues only eligible cues', () => {
    const rows = [
      cue({ id: 'ok' }),
      cue({ id: 'busy' }),
      cue({ id: 'empty', text: '   ' }),
      cue({ id: 'novoice', characterId: 'mute' }),
      cue({ id: 'skip', status: 'excluded' }),
    ]
    const review = reviewGeneration(rows, characters, (id) => id === 'busy')
    expect(review.eligible.map((c) => c.id)).toEqual(['ok'])
    expect([review.busy, review.missingText, review.missingVoice, review.excluded]).toEqual([
      1, 1, 1, 1,
    ])
  })
})
