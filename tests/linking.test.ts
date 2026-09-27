import { describe, expect, it } from 'vitest'
import type { Cue, Project } from '../src/shared/domain'
import {
  assetLinks,
  buildRowLines,
  isUnlinked,
  linkLabel,
  looseAudioCues,
  proposalRefs,
  unlinkedAssets,
  KEY_AFFIX,
  KEY_EXACT,
  KEY_NORMALIZED,
  KEY_NUMBER,
  keyTokens,
  linkByKey,
  linkPlan,
  linkRows,
  listProposals,
  rowColumns,
  SPEAKER_CONFIDENCE,
} from '../src/shared/linking'
import { SUBTITLE_COLUMNS } from '../src/shared/asset-readers'

const cue = (id: string, key: string, sourceText = '', fields: Record<string, string> = {}): Cue => ({
  id,
  characterId: '',
  key,
  fields,
  sourceText,
  text: '',
  status: 'empty',
  notes: '',
  takes: [],
})

const project = (cues: Cue[]): Pick<Project, 'cues' | 'characters' | 'linesFromTable' | 'terms'> => ({
  cues,
  characters: [
    { id: 'ada', name: 'ADA', color: '#fff', provider: { providerId: 'elevenlabs', voiceId: '', ttsModel: 'm', stsModel: 's' }, voiceSettings: { stability: 0.5, similarity: 0.5, style: 0, speed: 1, boost: true } },
  ],
})

const asset = { id: 'a1', name: 'subs/demo.srt' }

describe('keyTokens', () => {
  it('ignores case, separators, zero padding, letter-digit joints and a file extension', () => {
    expect(keyTokens('VO_ADA_001')).toEqual(['vo', 'ada', '1'])
    expect(keyTokens('ada-001.wav')).toEqual(['ada', '1'])
    expect(keyTokens('Line007')).toEqual(['line', '7'])
    expect(keyTokens('000')).toEqual(['0'])
  })
})

describe('linkByKey', () => {
  it('ranks exact, normalized and shared-affix matches with their reasons', () => {
    const cues = [cue('c1', 'ada_001'), cue('c2', 'ada_002'), cue('c3', 'alien_003'), cue('c4', 'Exact')]
    const report = linkByKey(cues, ['VO_ADA_001', 'vo-ada-2', 'VO_ALIEN_003', 'Exact', 'VO_BOB_009', ''])
    expect(report.links.map((l) => [l.row, l.key, l.confidence])).toEqual([
      [0, 'ada_001', KEY_AFFIX],
      [1, 'ada_002', KEY_AFFIX],
      [2, 'alien_003', KEY_AFFIX],
      [3, 'Exact', KEY_EXACT],
    ])
    expect(report.links[0].reason).toBe('key "VO_ADA_001" matches after dropping the prefix or suffix shared by all keys')
    expect(report.unmatched).toEqual([4, 5])
  })

  it('matches line fields but not the folder path, and reports ties as ambiguous', () => {
    const cues = [cue('c1', 'line-001', '', { EventName: 'Hello_01', path: 'x' }), cue('c2', 'k', '', { EventName: 'Twin' }), cue('c3', 'k2', '', { EventName: 'twin' })]
    const report = linkByKey(cues, ['hello-1', 'x', 'TWIN'])
    expect(report.links).toEqual([{ row: 0, cueId: 'c1', key: 'line-001', confidence: KEY_NORMALIZED, reason: 'key "hello-1" matches ignoring case, separators and zero padding' }])
    expect(report.unmatched).toEqual([1])
    expect(report.ambiguous).toEqual([{ row: 2, candidates: ['k', 'k2'] }])
  })

  it('gives only-number matches a low confidence and lets one line be claimed once', () => {
    const cues = [cue('c1', 'line-001'), cue('c2', 'line-002')]
    const report = linkByKey(cues, ['ADA_001', 'ADA_002', 'ada_0001'])
    expect(report.links.map((l) => [l.row, l.confidence])).toEqual([[0, KEY_NUMBER], [1, KEY_NUMBER]])
    expect(report.ambiguous).toEqual([{ row: 2, candidates: ['line-001'] }])
  })
})

describe('linkRows', () => {
  const rows = [
    ['VO_ADA_001', 'Welcome back, pioneer.'],
    ['VO_ADA_007', 'Resource node located.'],
    ['', 'Something nobody said.'],
  ]

  it('links by key first, then by text, and lists lines that need a transcript', () => {
    const cues = [cue('c1', 'ada_001'), cue('c2', 'ada_005', 'resource node located'), cue('c3', 'ada_009')]
    const report = linkRows(cues, rows, { key: 0, text: 1 }, 'auto')
    expect(report.links.map((l) => [l.row, l.key, l.confidence, l.reason])).toEqual([
      [0, 'ada_001', KEY_AFFIX, 'key "VO_ADA_001" matches after dropping the prefix or suffix shared by all keys'],
      [1, 'ada_005', 1, 'text similarity 1'],
    ])
    expect(report.unmatched).toEqual([2])
    expect(report.needsTranscribe).toEqual(['ada_009'])
  })

  it('needs the column its strategy uses', () => {
    expect(() => linkRows([], rows, { text: 1 }, 'key')).toThrow('Linking by key needs a key column; pass mapping.key')
    expect(() => linkRows([], rows, { key: 0 }, 'text')).toThrow('Linking by text needs a text column; pass mapping.text')
    expect(linkRows([cue('c1', 'VO_ADA_001')], rows, { key: 0 }, 'key').links).toHaveLength(1)
  })
})

describe('rowColumns', () => {
  it('uses fixed subtitle columns, a single column as text, and header detection for tables', () => {
    expect(rowColumns('subtitles', SUBTITLE_COLUMNS)).toEqual({ text: 4, character: 3, start: 1, end: 2 })
    expect(rowColumns('text', ['text'])).toEqual({ text: 0 })
    expect(rowColumns('table', ['cueId', 'character', 'sourceText', 'translation'])).toEqual({ key: 0, text: 2, translation: 3, character: 1 })
    expect(rowColumns('table', ['a', 'b'], { key: 'b', text: 0 })).toEqual({ key: 1, text: 0 })
  })
})

describe('buildRowLines', () => {
  const rows = [
    ['1', '1', '2.5', 'ADA', 'Welcome back, pioneer.'],
    ['2', '3', '4', 'Queen', 'Play for us.'],
    ['3', '5', '6', '', ''],
  ]
  const columns = { text: 4, character: 3, start: 1, end: 2 }

  it('creates one line per row with its origin, timing and speaker proposals, and skips rows built before', () => {
    const p = project([])
    const first = buildRowLines(p, rows, columns, asset)
    expect(first.summary).toEqual({ created: 2, updated: 0, unchanged: 0, skipped: 1, alreadyBuilt: 0, characterProposals: 2 })
    expect(p.cues.map((c) => [c.sourceText, c.origins, c.fields.start, c.fields.end])).toEqual([
      ['Welcome back, pioneer.', [{ assetId: 'a1', row: 0 }], '1', '2.5'],
      ['Play for us.', [{ assetId: 'a1', row: 1 }], '3', '4'],
    ])
    const queen = p.characters.find((c) => c.name === 'Queen')
    expect(p.cues[0].proposals).toEqual({ character: { characterId: 'ada', confidence: SPEAKER_CONFIDENCE, reason: 'speaker in subs/demo.srt' } })
    expect(p.cues[1].proposals?.character?.characterId).toBe(queen?.id)
    expect(p.cues.every((c) => c.characterId === '')).toBe(true)
    expect(first.changes).toMatchObject({ charactersReplace: true, linesFromTable: true })
    expect(first.changes?.cues).toHaveLength(2)
    const again = buildRowLines(p, rows, columns, asset)
    expect(again.summary).toMatchObject({ created: 0, alreadyBuilt: 2, skipped: 1 })
    expect(p.cues).toHaveLength(2)
  })

  it('updates a line whose key matches instead of creating one', () => {
    const p = project([{ ...cue('c1', 'K1'), origins: [{ assetId: 'wav' }] }])
    const built = buildRowLines(p, [['K1', 'Hi'], ['K2', 'Yo']], { key: 0, text: 1 }, asset)
    expect(built.summary).toMatchObject({ created: 1, updated: 1 })
    expect(p.cues.map((c) => [c.key, c.sourceText, c.origins])).toEqual([
      ['K1', 'Hi', [{ assetId: 'wav' }, { assetId: 'a1', row: 0 }]],
      ['K2', 'Yo', [{ assetId: 'a1', row: 1 }]],
    ])
  })
})

describe('linkPlan', () => {
  it('writes the original text, suggests a translation, proposes the link and the speaker', () => {
    const p = project([{ ...cue('c1', 'k1', 'old'), text: 'Текст' }, cue('c2', 'k2', 'same')])
    const rows = [['k1', 'new', 'Переклад', 'Bob'], ['k2', 'same', 'Текст', 'ADA']]
    const links = [
      { row: 0, cueId: 'c1', key: 'k1', confidence: 1, reason: 'r1' },
      { row: 1, cueId: 'c2', key: 'k2', confidence: 0.7, reason: 'r2' },
    ]
    const plan = linkPlan(p, links, rows, { key: 0, text: 1, translation: 2, character: 3 }, asset)
    expect(plan.fields).toEqual([
      { cueId: 'c1', from: { sourceText: 'old', suggestedText: null }, to: { sourceText: 'new', suggestedText: 'Переклад' } },
      { cueId: 'c2', from: { suggestedText: null }, to: { suggestedText: 'Текст' } },
    ])
    expect(plan.addCharacters.map((c) => c.name)).toEqual(['Bob'])
    expect(plan.proposals).toEqual([
      {
        cueId: 'c1',
        link: { assetId: 'a1', row: 0, confidence: 1, reason: 'r1' },
        character: { characterId: plan.addCharacters[0].id, confidence: SPEAKER_CONFIDENCE, reason: 'speaker in subs/demo.srt' },
      },
      { cueId: 'c2', link: { assetId: 'a1', row: 1, confidence: 0.7, reason: 'r2' }, character: { characterId: 'ada', confidence: SPEAKER_CONFIDENCE, reason: 'speaker in subs/demo.srt' } },
    ])
  })
})

describe('derived links and the proposal list', () => {
  it('counts lines per asset from origins and pending link proposals', () => {
    const cues = [
      { ...cue('c1', 'a'), origins: [{ assetId: 'x' }] },
      { ...cue('c2', 'b'), origins: [{ assetId: 'x', row: 1 }, { assetId: 'z' }], proposals: { link: { assetId: 'y', row: 0, confidence: 0.8, reason: '' } } },
    ]
    expect(Object.fromEntries(assetLinks(cues))).toEqual({ x: { lines: 2, proposed: 0 }, z: { lines: 1, proposed: 0 }, y: { lines: 0, proposed: 1 } })
  })

  it('lists character, link, text and term proposals with kind and confidence filters', () => {
    const p = {
      cues: [
        { ...cue('c1', 'a'), suggestedText: 'S', proposals: { character: { characterId: 'ada', confidence: 0.9, reason: 'r' }, link: { assetId: 'x', row: 2, confidence: 0.6, reason: 'l' } } },
      ],
      terms: [{ term: 'node', translation: 'вузол', proposed: true as const }, { term: 'pioneer', translation: 'піонер' }],
    }
    expect(listProposals(p).map((e) => e.kind)).toEqual(['character', 'link', 'text', 'term'])
    expect(listProposals(p, undefined, 0.8).map((e) => e.kind)).toEqual(['character'])
    expect(listProposals(p, 'term').map((e) => e.term?.term)).toEqual(['node'])
  })
})

describe('bin state', () => {
  it('labels an asset by linked lines and pending link proposals', () => {
    expect(linkLabel(undefined)).toBe('Unlinked')
    expect(linkLabel({ lines: 0, proposed: 0 })).toBe('Unlinked')
    expect(linkLabel({ lines: 1, proposed: 0 })).toBe('1 line')
    expect(linkLabel({ lines: 1200, proposed: 0 })).toBe('1,200 lines')
    expect(linkLabel({ lines: 0, proposed: 2 })).toBe('2 proposed')
    expect(linkLabel({ lines: 3, proposed: 1 })).toBe('3 lines · 1 proposed')
  })

  it('treats an asset with only proposals as unlinked', () => {
    expect(isUnlinked(undefined)).toBe(true)
    expect(isUnlinked({ lines: 0, proposed: 4 })).toBe(true)
    expect(isUnlinked({ lines: 1, proposed: 0 })).toBe(false)
    const links = assetLinks([
      { ...cue('c1', 'a'), origins: [{ assetId: 'x' }] },
      { ...cue('c2', 'b'), proposals: { link: { assetId: 'y', row: 0, confidence: 0.8, reason: '' } } },
    ])
    expect(unlinkedAssets([{ id: 'x' }, { id: 'y' }, { id: 'z' }], links).map((a) => a.id)).toEqual(['y', 'z'])
  })

  it('keeps only lines not built from an audio or video asset for the folder rows', () => {
    const assets = [
      { id: 'wav', kind: 'audio' as const },
      { id: 'srt', kind: 'subtitles' as const },
    ]
    const cues = [
      { ...cue('c1', 'a'), origins: [{ assetId: 'wav' }] },
      { ...cue('c2', 'b'), origins: [{ assetId: 'srt', row: 0 }] },
      cue('c3', 'c'),
    ]
    expect(looseAudioCues(cues, assets).map((c) => c.id)).toEqual(['c2', 'c3'])
    expect(looseAudioCues(cues)).toBe(cues)
  })

  it('collects pending character and link proposals as refs, never text suggestions', () => {
    const cues = [
      { ...cue('c1', 'a'), suggestedText: 'S', proposals: { character: { characterId: 'ada', confidence: 0.9, reason: '' } } },
      { ...cue('c2', 'b'), proposals: { character: { characterId: 'ada', confidence: 0.9, reason: '' }, link: { assetId: 'x', row: 1, confidence: 1, reason: '' } } },
      { ...cue('c3', 'c'), suggestedText: 'T' },
    ]
    expect(proposalRefs(cues)).toEqual([
      { cueId: 'c1', kind: 'character' },
      { cueId: 'c2', kind: 'character' },
      { cueId: 'c2', kind: 'link' },
    ])
  })
})
