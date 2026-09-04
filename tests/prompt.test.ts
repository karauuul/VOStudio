import { describe, expect, it } from 'vitest'
import { buildPrompt, highlightRanges, matchTerms, stem } from '../src/shared/prompt'
import { DEFAULT_VOICE_SETTINGS, type Character, type Cue, type Term } from '../src/shared/domain'

const character = (id: string, name: string): Character => ({
  id,
  name,
  color: '#fff',
  provider: { providerId: 'elevenlabs', voiceId: 'v1', ttsModel: 'm', stsModel: 'm' },
  voiceSettings: DEFAULT_VOICE_SETTINGS,
})

const cue = (over: Partial<Cue> = {}): Cue => ({
  id: 'cue-1',
  characterId: 'ada',
  key: 'K1',
  fields: {},
  sourceText: 'The ferrofluid powers the elevator.',
  text: 'Ферофлюїд живить ліфт.',
  status: 'translated',
  notes: '',
  takes: [],
  ...over,
})

const terms: Term[] = [
  { term: 'Ferrofluid', translation: 'ферофлюїд', note: 'keep singular' },
  { term: 'elevator', translation: 'ліфт' },
  { term: 'conveyor', translation: 'конвеєр' },
]

const project = { terms, characters: [character('ada', 'Ada')] }

describe('stem', () => {
  it('leaves short words untouched apart from case', () => {
    expect(stem('Cat')).toBe('cat')
    expect(stem('ліфт')).toBe('ліфт')
    expect(stem('elbow')).toBe('elbow')
  })

  it('drops the last two characters of long words', () => {
    expect(stem('Ferrofluid')).toBe('ferroflu')
    expect(stem('ферофлюїд')).toBe('ферофлю')
    expect(stem('elevator')).toBe('elevat')
  })

  it('stems a multi-word term as one string', () => {
    expect(stem('Power Shard')).toBe('power sha')
  })

  it('returns an empty string for empty input', () => {
    expect(stem('')).toBe('')
  })
})

describe('matchTerms', () => {
  it('matches on the source side', () => {
    expect(matchTerms(terms, 'The elevator is broken', '').map((t) => t.term)).toEqual(['elevator'])
  })

  it('matches on the translation side', () => {
    expect(matchTerms(terms, '', 'Конвеєром щось їде').map((t) => t.term)).toEqual(['conveyor'])
  })

  it('matches Ukrainian inflections through the stem', () => {
    for (const form of ['ферофлюїд', 'ферофлюїду', 'ферофлюїдом']) {
      expect(matchTerms(terms, '', form).map((t) => t.term)).toEqual(['Ferrofluid'])
    }
  })

  it('matches an English plural through the stem', () => {
    expect(matchTerms(terms, 'two ferrofluids', '').map((t) => t.term)).toEqual(['Ferrofluid'])
  })

  it('never matches on an empty stem', () => {
    expect(matchTerms([{ term: '', translation: '' }], 'anything', 'anything')).toEqual([])
  })

  it('returns nothing when no term occurs', () => {
    expect(matchTerms(terms, 'Nothing here', 'Нічого тут')).toEqual([])
  })
})

describe('highlightRanges', () => {
  it('finds every case-insensitive occurrence, sorted by start', () => {
    expect(highlightRanges('Elevator and elevator', ['elevator'])).toEqual([
      { start: 0, end: 8 },
      { start: 13, end: 21 },
    ])
  })

  it('extends a stem match to the end of the word', () => {
    expect(highlightRanges('the buttons', ['button'])).toEqual([{ start: 4, end: 11 }])
  })

  it('never returns overlapping ranges', () => {
    const ranges = highlightRanges('conveyor belt', ['conveyor', 'conveyor belt', 'veyor'])
    expect(ranges).toEqual([{ start: 0, end: 13 }])
  })

  it('sorts ranges from different needles', () => {
    const ranges = highlightRanges('The ferrofluid lifts the elevator', ['elevator', 'Ferrofluid'])
    expect(ranges).toEqual([
      { start: 4, end: 14 },
      { start: 25, end: 33 },
    ])
  })

  it('skips empty needles', () => {
    expect(highlightRanges('anything', ['', ' '])).toEqual([])
  })

  it('returns nothing when there is no match', () => {
    expect(highlightRanges('nothing', ['elevator'])).toEqual([])
  })
})

describe('buildPrompt', () => {
  it('renders a full cue with duration, terms and notes', () => {
    expect(
      buildPrompt(project, cue({ referenceDuration: 2.345, notes: 'shouting' }))
    ).toBe(
      [
        'Character: Ada',
        'Source: The ferrofluid powers the elevator.',
        'Translation: Ферофлюїд живить ліфт.',
        'Duration: 2.3s',
        'Terms:',
        '- Ferrofluid = ферофлюїд (keep singular)',
        '- elevator = ліфт',
        'Notes: shouting',
      ].join('\n')
    )
  })

  it('omits the translation line when the translation is empty', () => {
    expect(buildPrompt(project, cue({ text: '' }))).toBe(
      [
        'Character: Ada',
        'Source: The ferrofluid powers the elevator.',
        'Terms:',
        '- Ferrofluid = ферофлюїд (keep singular)',
        '- elevator = ліфт',
      ].join('\n')
    )
  })

  it('omits the terms section when nothing matches', () => {
    expect(buildPrompt(project, cue({ sourceText: 'Hello', text: 'Привіт' }))).toBe(
      ['Character: Ada', 'Source: Hello', 'Translation: Привіт'].join('\n')
    )
  })

  it('omits the terms section when the project has no terms', () => {
    expect(buildPrompt({ characters: project.characters }, cue({ sourceText: 'Hi', text: '' }))).toBe(
      ['Character: Ada', 'Source: Hi'].join('\n')
    )
  })

  it('omits the duration line when there is no reference duration', () => {
    expect(buildPrompt(project, cue({ sourceText: 'Hi', text: '' }))).toBe(
      ['Character: Ada', 'Source: Hi'].join('\n')
    )
  })

  it('reports an unassigned character when the id resolves to nothing', () => {
    expect(
      buildPrompt(project, cue({ characterId: 'ghost', sourceText: 'Hi', text: '' }))
    ).toBe(['Character: Unassigned', 'Source: Hi'].join('\n'))
    expect(buildPrompt(project, cue({ characterId: '', sourceText: 'Hi', text: '' }))).toBe(
      ['Character: Unassigned', 'Source: Hi'].join('\n')
    )
  })
})
