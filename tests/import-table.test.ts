import { describe, expect, it } from 'vitest'
import { parseCsv } from '../src/shared/csv'
import {
  applyTable,
  attachesOnly,
  commitTable,
  detectMapping,
  hasSourceMaterial,
  importCounts,
  importTabs,
  lineDot,
  matchAudioFiles,
  matchesImportTab,
  matchKey,
  tableColumnLabels,
  tableDelimiter,
} from '../src/shared/import-table'
import {
  sanitizeLanguages,
  sanitizeMatchRule,
  type Character,
  type Cue,
  type Project,
} from '../src/shared/domain'
import { applyChangeSet, applyProjectCommand } from '../src/shared/project-commands'
import { isManualProject, newLineCue } from '../src/shared/lines'

const cue = (over: Partial<Cue> & { key: string }): Cue => ({
  id: `id-${over.key}`,
  characterId: '',
  fields: {},
  sourceText: '',
  text: '',
  status: 'empty',
  notes: '',
  takes: [],
  ...over,
})

const project = (cues: Cue[], characters: Character[] = []): Pick<Project, 'cues' | 'characters'> => ({
  cues,
  characters,
})

describe('detectMapping', () => {
  it('maps the canonical template header', () => {
    expect(detectMapping(['cueId', 'character', 'sourceText', 'translation', 'refAudio'])).toEqual({
      id: 0,
      character: 1,
      text: 2,
      translation: 3,
    })
  })

  it('maps a game export header', () => {
    expect(detectMapping(['EventName', 'Original', 'Speaker'])).toEqual({
      id: 0,
      text: 1,
      character: 2,
    })
  })

  it('prefers the translation column over a source-text column for target-like names', () => {
    const m = detectMapping(['id', 'text', 'targetText'])
    expect(m.id).toBe(0)
    expect(m.text).toBe(1)
    expect(m.translation).toBe(2)
  })

  it('claims each header at most once', () => {
    const m = detectMapping(['name', 'name', 'name'])
    expect(Object.values(m)).toEqual([0])
  })

  it('leaves columns unmapped when nothing matches', () => {
    expect(detectMapping(['alpha', 'beta'])).toEqual({})
  })

  it('maps a bare Text header to the line text unless the table has a translation column', () => {
    expect(detectMapping(['Text'])).toEqual({ translation: 0 })
    expect(detectMapping(['EventName', 'Text', 'Character'])).toEqual({ id: 0, translation: 1, character: 2 })
    expect(detectMapping(['Text', 'Translation'])).toEqual({ text: 0, translation: 1 })
    expect(detectMapping(['Source', 'Text'])).toEqual({ text: 0, translation: 1 })
    expect(detectMapping(['Key', 'Text', 'Original'])).toEqual({ id: 0, translation: 1, text: 2 })
    expect(detectMapping(['Key', 'Line text'])).toEqual({ id: 0, translation: 1 })
    expect(detectMapping(['Text', 'Original', 'Translation'])).toEqual({ text: 1, translation: 2 })
  })

  it('maps explicit original and translation headers by name', () => {
    for (const original of ['Source', 'Original', 'EN', 'sourceText']) {
      for (const translation of ['Translation', 'UK', 'Localized', 'Target']) {
        expect(detectMapping(['Key', original, translation])).toEqual({ id: 0, text: 1, translation: 2 })
      }
    }
    expect(detectMapping(['Original'])).toEqual({ text: 0 })
    expect(detectMapping(['EN'])).toEqual({ text: 0 })
  })

  it('leaves Cyrillic headers unmapped', () => {
    expect(detectMapping(['Ключ', 'Текст', 'Персонаж'])).toEqual({})
  })

  it('labels the line text Text in manual projects and Translation in translation projects', () => {
    expect(tableColumnLabels(false)).toEqual({ id: 'Key', text: 'Original', translation: 'Text', character: 'Character' })
    expect(tableColumnLabels(true)).toEqual({ id: 'Key', text: 'Original', translation: 'Translation', character: 'Character' })
  })
})

describe('tableDelimiter', () => {
  it('follows the extension', () => {
    expect(tableDelimiter('a.tsv', 'id,text')).toBe('\t')
    expect(tableDelimiter('a.csv', 'id\ttext')).toBe(',')
  })

  it('sniffs a .txt file', () => {
    expect(tableDelimiter('a.txt', 'id\ttext')).toBe('\t')
    expect(tableDelimiter('a.txt', 'id,text')).toBe(',')
  })
})

describe('parseCsv with a tab delimiter', () => {
  it('splits on tabs and keeps commas inside cells', () => {
    const csv = parseCsv('id\ttext\nA\thello, world\n', '\t')
    expect(csv.headers).toEqual(['id', 'text'])
    expect(csv.rows).toEqual([['A', 'hello, world']])
  })

  it('still parses commas by default', () => {
    expect(parseCsv('a,b\n1,2\n').rows).toEqual([['1', '2']])
  })
})

describe('matchKey', () => {
  it('uses the cue key for id and table rules', () => {
    const c = cue({ key: 'K1', fields: { exportName: 'E1' } })
    expect(matchKey(c, 'id')).toBe('K1')
    expect(matchKey(c, 'tableId')).toBe('K1')
    expect(matchKey(c, 'exportName')).toBe('E1')
  })

  it('falls back to the key when exportName is missing', () => {
    expect(matchKey(cue({ key: 'K1' }), 'exportName')).toBe('K1')
  })
})

describe('applyTable', () => {
  const rows = (...lines: string[]): string[][] => parseCsv(['id,text,translation,character', ...lines, ''].join('\n')).rows
  const mapping = { id: 0, text: 1, translation: 2, character: 3 }

  it('fills the transcript and turns unmatched rows into lines with no audio', () => {
    const p = project([cue({ key: 'A' }), cue({ key: 'B' })])
    const r = applyTable(p, rows('A,Hello,,', 'C,Nope,,'), mapping, 'id', false)
    expect(p.cues[0].sourceText).toBe('Hello')
    expect(r.matched).toBe(1)
    expect(r.unmatched.map((c) => c.key)).toEqual(['C'])
    expect(r.changed).toHaveLength(2)
    const created = p.cues.find((c) => c.key === 'C')!
    expect(created.referenceAudio).toBeUndefined()
    expect(created.sourceText).toBe('Nope')
    expect(created.fields['EventName']).toBe('C')
    expect(matchesImportTab(created, 'unmatched')).toBe(true)
  })

  it('is idempotent — a second run matches the lines it created', () => {
    const p = project([])
    applyTable(p, rows('C,Nope,,'), mapping, 'id', false)
    const again = applyTable(p, rows('C,Nope,,'), mapping, 'id', false)
    expect(p.cues).toHaveLength(1)
    expect(again.matched).toBe(1)
    expect(again.unmatched).toEqual([])
  })

  it('does not overwrite a non-empty translation unless asked', () => {
    const p = project([cue({ key: 'A', text: 'stary' })])
    applyTable(p, rows('A,,new,'), mapping, 'id', false)
    expect(p.cues[0].text).toBe('stary')
    expect(p.cues[0].suggestedText).toBe('new')
    applyTable(p, rows('A,,new,'), mapping, 'id', true)
    expect(p.cues[0].text).toBe('new')
  })

  it('fills an empty translation and marks the cue translated', () => {
    const p = project([cue({ key: 'A' })])
    applyTable(p, rows('A,,new,'), mapping, 'id', false)
    expect(p.cues[0].text).toBe('new')
    expect(p.cues[0].status).toBe('translated')
  })

  it('creates characters named by the table', () => {
    const p = project([cue({ key: 'A' })])
    const r = applyTable(p, rows('A,,,ADA'), mapping, 'id', false)
    expect(p.cues[0].characterId).toBe('ADA')
    expect(r.createdCharacters.map((c) => c.name)).toEqual(['ADA'])
    const again = applyTable(p, rows('A,,,ADA'), mapping, 'id', false)
    expect(again.createdCharacters).toEqual([])
  })

  it('matches by exportName when the rule says so', () => {
    const p = project([cue({ key: 'A', fields: { exportName: 'OUT_A' } })])
    const r = applyTable(p, rows('OUT_A,Hello,,'), mapping, 'exportName', false)
    expect(r.matched).toBe(1)
    expect(p.cues[0].sourceText).toBe('Hello')
  })

  it('appends new lines without an id column and leaves existing lines alone', () => {
    const p = project([cue({ key: 'A' })])
    const r = applyTable(p, rows('A,Hello,,'), { text: 1 }, 'id', false)
    expect(r.matched).toBe(0)
    expect(p.cues).toHaveLength(2)
    expect(p.cues[0].sourceText).toBe('')
    expect(p.cues[1]).toMatchObject({ key: 'line-001', sourceText: 'Hello', fields: { EventName: 'Line 1' } })
  })

  it('stales an approval when the source text changes', () => {
    const c = cue({ key: 'A', sourceText: 'old', textRevision: 1 })
    const p = project([c])
    applyTable(p, rows('A,new,,'), mapping, 'id', false)
    expect(p.cues[0].textRevision).toBe(2)
  })
})

describe('matchAudioFiles', () => {
  it('splits files into updates and new lines', () => {
    const cues = [cue({ key: 'A' }), cue({ key: 'B' })]
    const r = matchAudioFiles(cues, [{ name: 'A' }, { name: 'C' }, { name: 'C' }], 'id')
    expect(r.update.map((u) => u.cue.key)).toEqual(['A'])
    expect(r.create.map((f) => f.name)).toEqual(['C'])
  })
})

describe('attachesOnly', () => {
  const ref = (name: string) => ({ fileId: name, relPath: `/p/audio/reference/${name}.wav`, format: 'wav' as const })
  const audioLine = (key: string) => cue({ key, fields: { EventName: key }, referenceAudio: ref(key), referenceDuration: 1 })
  const owner = (over: Partial<Project> = {}): Pick<Project, 'template' | 'csvBinding' | 'linesFromTable' | 'cues'> => ({
    cues: [],
    ...over,
  })

  it('attaches only in a project that came from a template', () => {
    expect(attachesOnly(owner({ template: { name: 'Demo' }, cues: [audioLine('VO_ADA_001')] }))).toBe(true)
  })

  it('attaches only in a project bound to a CSV', () => {
    const csvBinding = { csvPath: 'x.csv', encoding: 'utf-8-sig' as const, columnOrder: [], mapping: { key: 'WemId' } }
    expect(attachesOnly(owner({ csvBinding }))).toBe(true)
  })

  it('attaches only once a table created lines, also after every line got its audio', () => {
    const p = { ...owner(), characters: [] }
    commitTable(p, [['A', 'Alpha'], ['B', 'Beta']], { mapping: { id: 0, translation: 1 }, rule: 'id', replaceTranslations: false, keepOriginal: false })
    expect(p.linesFromTable).toBe(true)
    expect(attachesOnly(p)).toBe(true)
    for (const line of p.cues) line.referenceAudio = ref(line.key)
    expect(attachesOnly(p)).toBe(true)
  })

  it('attaches only in a template project saved before the template identity existed', () => {
    const fields = { cueId: 'VO_ADA_001', exportName: 'VO_ADA_001', EventName: 'VO_ADA_001' }
    expect(attachesOnly(owner({ cues: [cue({ key: 'VO_ADA_001', fields, referenceAudio: ref('VO_ADA_001') })] }))).toBe(true)
  })

  it('keeps creating lines in audio-first, empty and manual projects', () => {
    expect(attachesOnly(owner({ cues: [audioLine('LINE_A'), audioLine('LINE_B')] }))).toBe(false)
    expect(attachesOnly(owner())).toBe(false)
    expect(attachesOnly(owner({ cues: [newLineCue('c1', 1, 'Hello'), newLineCue('c2', 2)] }))).toBe(false)
  })
})

describe('import tabs and counts', () => {
  const cues = [
    cue({ key: 'A', sourceText: 'a', text: 'ua', referenceAudio: { fileId: 'f', relPath: 'f.wav', format: 'wav' } }),
    cue({ key: 'B', sourceText: 'b', referenceAudio: { fileId: 'f', relPath: 'g.wav', format: 'wav' } }),
    cue({ key: 'C' }),
  ]

  it('counts the footer numbers', () => {
    expect(importCounts(cues)).toEqual({
      lines: 3,
      transcribed: 2,
      translated: 1,
      notranscript: 1,
      notranslation: 2,
      unmatched: 1,
    })
  })

  it('filters by tab', () => {
    expect(cues.filter((c) => matchesImportTab(c, 'unmatched')).map((c) => c.key)).toEqual(['C'])
    expect(cues.filter((c) => matchesImportTab(c, 'notranscript')).map((c) => c.key)).toEqual(['C'])
    expect(cues.filter((c) => matchesImportTab(c, 'all'))).toHaveLength(3)
  })

  it('picks the row dot', () => {
    expect(cues.map(lineDot)).toEqual(['ready', 'transcript', 'none'])
  })

  it('uses the translation layout only when the project has source material', () => {
    const line = (over: Partial<Cue> = {}): Cue => ({ id: 'x', characterId: '', key: 'k', fields: {}, sourceText: '', text: 't', status: 'translated', notes: '', takes: [], ...over })
    const tts = { id: 'g', kind: 'tts' as const, createdAt: 'now', file: { fileId: 'g', relPath: '/p/g.mp3', format: 'mp3' as const }, duration: 1, meta: {}, edits: { trimStart: 0, trimEnd: 0, gainDb: 0, fadeIn: { duration: 0, shape: 'equalPower' as const }, fadeOut: { duration: 0, shape: 'equalPower' as const } } }
    expect(hasSourceMaterial({ cues: [line({ takes: [tts] })] })).toBe(false)
    expect(hasSourceMaterial({ cues: [line()], languages: { source: 'en', target: 'uk' } })).toBe(true)
    expect(hasSourceMaterial({ cues: [line({ sourceText: 'Hello' })] })).toBe(true)
    expect(hasSourceMaterial({ cues: [line({ referenceAudio: { fileId: 'r', relPath: '/p/r.wav', format: 'wav' } })] })).toBe(true)
    expect(hasSourceMaterial({ cues: [line({ region: { sourceId: 's', in: 0, out: 1 } })] })).toBe(true)
    expect(hasSourceMaterial({ cues: [line({ referenceDuration: 2.5 })] })).toBe(true)
    expect(hasSourceMaterial({ cues: [line({ referenceDuration: 0 })] })).toBe(false)
  })

  it('keeps the translation tabs', () => {
    expect(importTabs(true)).toEqual([
      { id: 'all', label: 'All' },
      { id: 'notranscript', label: 'No transcript' },
      { id: 'notranslation', label: 'No translation' },
      { id: 'unmatched', label: 'No audio' },
    ])
  })

  it('offers only text tabs in a manual project built from a table', () => {
    const p = project([])
    const headers = ['EventName', 'Text', 'Character']
    const mapping = detectMapping(headers)
    applyTable(p, [['a', 'One', 'ADA'], ['b', 'Two', 'ADA'], ['c', '', 'BOB']], mapping, 'id', false)
    expect(isManualProject(p)).toBe(true)
    expect(importTabs(false)).toEqual([
      { id: 'all', label: 'All' },
      { id: 'notranslation', label: 'No text' },
    ])
    expect(importCounts(p.cues)).toMatchObject({ lines: 3, notranslation: 1 })
    expect(p.cues.filter((c) => matchesImportTab(c, 'notranslation')).map((c) => c.key)).toEqual(['c'])
  })
})

describe('Project.languages', () => {
  it('sanitizes a pair and rejects half-filled ones', () => {
    expect(sanitizeLanguages({ source: ' en ', target: 'uk' })).toEqual({ source: 'en', target: 'uk' })
    expect(sanitizeLanguages({ source: 'en' })).toBeUndefined()
    expect(sanitizeLanguages(null)).toBeUndefined()
  })

  it('sanitizes the match rule', () => {
    expect(sanitizeMatchRule('exportName')).toBe('exportName')
    expect(sanitizeMatchRule('nope')).toBeUndefined()
  })

  it('roundtrips through the command and the change set', () => {
    const p = { name: 'P', cues: [], characters: [] } as unknown as Project
    const changes = applyProjectCommand(p, {
      type: 'project.setLanguages',
      languages: { source: 'en', target: 'uk' },
    })
    expect(p.languages).toEqual({ source: 'en', target: 'uk' })
    expect(JSON.parse(JSON.stringify(p)).languages).toEqual({ source: 'en', target: 'uk' })
    const applied = applyChangeSet({ ...p, languages: undefined }, changes)
    expect(applied.languages).toEqual({ source: 'en', target: 'uk' })
  })

  it('leaves a project without the field untouched', () => {
    const p = { name: 'P', cues: [], characters: [] } as unknown as Project
    const before = JSON.stringify(p)
    applyProjectCommand(p, { type: 'project.rename', name: 'Q' })
    expect('languages' in p).toBe(false)
    expect(JSON.stringify({ ...p, name: 'P' })).toBe(before)
  })

  it('clears the field when set to null', () => {
    const p = { name: 'P', cues: [], characters: [], languages: { source: 'en', target: 'uk' } } as unknown as Project
    const changes = applyProjectCommand(p, { type: 'project.setLanguages', languages: null })
    expect('languages' in p).toBe(false)
    expect('languages' in applyChangeSet({ ...p, languages: { source: 'en', target: 'uk' } }, changes)).toBe(false)
  })
})
