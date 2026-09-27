import { describe, expect, it } from 'vitest'
import {
  FALLBACK_CHARS_PER_SECOND,
  glossaryIssues,
  matchRowsByText,
  normalizeText,
  removeTerms,
  similarity,
  similarityIndex,
  speakingRate,
  translationContext,
  trigrams,
  upsertTerms,
} from '../src/shared/agent-text'
import { emptyEdits, type Cue, type Take } from '../src/shared/domain'

const cue = (over: Partial<Cue> & { key: string }): Cue => ({
  id: `id-${over.key}`,
  characterId: 'ada',
  fields: {},
  sourceText: '',
  text: '',
  status: 'empty',
  notes: '',
  takes: [],
  ...over,
})

const take = (id: string, text: string, duration: number, kind: Take['kind'] = 'tts'): Take => ({
  id,
  kind,
  createdAt: 'now',
  file: { fileId: id, relPath: `/p/${id}.mp3`, format: 'mp3' },
  duration,
  meta: { text },
  edits: emptyEdits(),
})

describe('text similarity', () => {
  it('normalizes case, punctuation, whitespace and unicode forms', () => {
    expect(normalizeText('  Hello,   WORLD!!  ')).toBe('hello world')
    expect(normalizeText('Привіт — світе…')).toBe('привіт світе')
    expect(normalizeText('ﬁne ①')).toBe('fine 1')
    expect(normalizeText('?!')).toBe('')
  })

  it('pads trigrams with spaces and scores with the Dice coefficient', () => {
    expect([...trigrams('Ab')]).toEqual([' ab', 'ab '])
    expect(similarity('Welcome back, pioneer.', 'welcome back pioneer')).toBe(1)
    expect(similarity('', 'x')).toBe(0)
    expect(similarity('night', 'nacht')).toBeCloseTo((2 * 1) / (5 + 5), 5)
    const a = similarity('Resource node located.', 'Resource node found.')
    expect(a).toBeGreaterThan(0.5)
    expect(a).toBeLessThan(1)
    expect(similarity('Resource node found.', 'Resource node located.')).toBe(a)
  })

  it('ranks an index by score and breaks ties by position', () => {
    const query = similarityIndex(['alpha beta', 'gamma', 'alpha beta', 'alpha'])
    expect(query('alpha beta').map((r) => r.index)).toEqual([0, 2, 3])
    expect(query('alpha beta')[0].score).toBe(1)
    expect(query('zzz')).toEqual([])
  })
})

describe('matchRowsByText', () => {
  const cues = [
    cue({ key: 'A', sourceText: 'Welcome back, pioneer.' }),
    cue({ key: 'B', sourceText: 'Warning, hostile fauna detected nearby.' }),
    cue({ key: 'C', sourceText: 'Play for us.' }),
    cue({ key: 'D', sourceText: 'Play for us!' }),
    cue({ key: 'E', sourceText: '' }),
  ]

  it('matches fuzzy rows, lists ambiguous and unmatched rows and never matches blank lines', () => {
    const report = matchRowsByText(
      cues,
      [['welcome back pioneer'], ['Warning: hostile fauna nearby'], ['Play for us'], ['Totally different'], ['']],
      0
    )
    expect(report.matched.map((m) => [m.index, m.key])).toEqual([[0, 'A'], [1, 'B']])
    expect(report.matched[0].score).toBe(1)
    expect(report.ambiguous).toEqual([{ index: 2, candidates: ['C', 'D'] }])
    expect(report.unmatched).toEqual([3, 4])
  })

  it('gives a line to the best row only and reports the other as ambiguous', () => {
    const report = matchRowsByText(cues.slice(0, 2), [['Welcome back pioneers'], ['Welcome back, pioneer.']], 0)
    expect(report.matched).toEqual([{ index: 1, cueId: 'id-A', key: 'A', score: 1 }])
    expect(report.ambiguous).toEqual([{ index: 0, candidates: ['A'] }])
  })
})

describe('speakingRate', () => {
  it('uses the median characters per second of live TTS takes of the character', () => {
    const a = cue({ key: 'A', takes: [take('t1', 'x'.repeat(20), 2), take('t2', 'x'.repeat(30), 2), take('t3', 'x'.repeat(100), 1, 'recording')] })
    const b = cue({ key: 'B', takes: [take('t4', 'x'.repeat(24), 2), { ...take('t5', 'x'.repeat(90), 1), deletedAt: 'now' }] })
    const other = cue({ key: 'C', characterId: 'bob', takes: [take('t6', 'x'.repeat(80), 1)] })
    expect(speakingRate([a, b, other], 'ada')).toBe(12)
    expect(speakingRate([a, b, other], 'nobody')).toBe(FALLBACK_CHARS_PER_SECOND)
  })
})

describe('glossary helpers', () => {
  it('upserts by term case-insensitively and removes by term', () => {
    const current = [{ term: 'Pioneer', translation: 'піонер' }, { term: 'node', translation: 'вузол' }]
    expect(upsertTerms(current, [{ term: 'pioneer', translation: 'першопрохідець' }, { term: 'FICSIT', translation: 'FICSIT' }])).toEqual([
      { term: 'pioneer', translation: 'першопрохідець' },
      { term: 'node', translation: 'вузол' },
      { term: 'FICSIT', translation: 'FICSIT' },
    ])
    expect(removeTerms(current, [' NODE '])).toEqual([{ term: 'Pioneer', translation: 'піонер' }])
  })

  it('flags translated lines whose text lacks the translation of a term in the source', () => {
    const terms = [{ term: 'pioneer', translation: 'піонер' }, { term: 'node', translation: 'вузол' }]
    const ok = cue({ key: 'OK', sourceText: 'Hello pioneers', text: 'Привіт, піонери' })
    const missing = cue({ key: 'BAD', sourceText: 'Resource node, pioneer', text: 'Знайдено ресурс, піонере' })
    const empty = cue({ key: 'EMPTY', sourceText: 'pioneer' })
    const issues = glossaryIssues(terms, [ok, missing, empty])
    expect(issues.map((i) => [i.cue.key, i.missing.map((t) => t.term)])).toEqual([['BAD', ['node']]])
  })
})

describe('translationContext', () => {
  it('describes each line with neighbours, budget, terms and memory', () => {
    const cues = [
      cue({ key: 'L1', sourceText: 'Resource node located.', text: 'Ресурсний вузол знайдено.' }),
      cue({ key: 'L2', sourceText: 'Hello' }),
      cue({ key: 'L3', sourceText: 'Resource node found.', referenceDuration: 1.5, suggestedText: 'Вузол' }),
      cue({ key: 'L4', sourceText: 'Bye', characterId: 'bob', region: { sourceId: 's', in: 1, out: 3 } }),
    ]
    const project = {
      cues,
      characters: [{ id: 'ada', name: 'Ada' }] as never,
      terms: [{ term: 'node', translation: 'вузол' }],
    }
    const [l3, l4] = translationContext(project, [cues[2], cues[3]])
    expect(l3).toMatchObject({
      key: 'L3',
      character: 'Ada',
      suggestedText: 'Вузол',
      duration: 1.5,
      charsPerSecond: 14,
      budget: 21,
      terms: [{ term: 'node', translation: 'вузол' }],
    })
    expect((l3.neighbours as { key: string }[]).map((n) => n.key)).toEqual(['L1', 'L2', 'L4'])
    expect((l3.memory as { key: string }[]).map((m) => m.key)).toEqual(['L1'])
    expect(l4).toMatchObject({ character: null, duration: 2, budget: 28, memory: [], terms: [] })
    expect(l4).not.toHaveProperty('suggestedText')
  })
})
