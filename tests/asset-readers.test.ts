import { describe, expect, it } from 'vitest'
import { TAKE_FILE_EXTENSIONS } from '../src/shared/take-import'
import {
  ASSET_EXTENSIONS,
  assetKind,
  binAddedText,
  routeDrop,
  jsonRecords,
  markdownTable,
  parseJsonPath,
  parseSubtitles,
  parseTimestamp,
  resolveColumn,
  selectJson,
  SUBTITLE_COLUMNS,
  subtitleTable,
  textTable,
} from '../src/shared/asset-readers'

describe('assetKind', () => {
  it('maps extensions to kinds and anything else to other', () => {
    expect(['a.CSV', 'b.tsv', 'c.xlsx'].map(assetKind)).toEqual(['table', 'table', 'table'])
    expect(['a.srt', 'b.VTT'].map(assetKind)).toEqual(['subtitles', 'subtitles'])
    expect(['a.md', 'b.txt'].map(assetKind)).toEqual(['text', 'text'])
    expect(['a.json', 'b.xml'].map(assetKind)).toEqual(['data', 'data'])
    expect(['a.wav', 'b.mp3', 'c.ogg', 'd.flac', 'e.m4a'].map(assetKind)).toEqual(['audio', 'audio', 'audio', 'audio', 'audio'])
    expect(TAKE_FILE_EXTENSIONS.map((ext) => assetKind(`take.${ext.toUpperCase()}`))).toEqual(TAKE_FILE_EXTENSIONS.map(() => 'audio'))
    expect(routeDrop(['/in/a.aac', '/in/b.opus', '/in/c.webm'])).toEqual({ templates: [], lines: ['/in/a.aac', '/in/b.opus', '/in/c.webm'], bin: [] })
    expect(['a.mp4', 'b.mov', 'c.mkv'].map(assetKind)).toEqual(['video', 'video', 'video'])
    expect(['game.locres', 'README', 'dir.v2/file'].map(assetKind)).toEqual(['other', 'other', 'other'])
  })
})

describe('subtitles', () => {
  it('reads SRT with CRLF, a BOM, multi-line text and NAME: speakers', () => {
    const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nADA: Welcome back,\r\npioneer.\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n<i>Resource node located.</i>\r\n'
    expect(parseSubtitles(srt)).toEqual([
      { index: 1, start: 1, end: 2.5, text: 'Welcome back,\npioneer.', speaker: 'ADA' },
      { index: 2, start: 3, end: 4, text: 'Resource node located.' },
    ])
  })

  it('reads VTT with a header, notes, cue ids, settings and voice tags', () => {
    const vtt = 'WEBVTT\n\nNOTE made by hand\n\nintro\n00:01.000 --> 00:02.000 align:start\n<v Alien Queen>Play for us.</v>\n\n01:00:00.5 --> 01:00:01.25\nMission Control: this is a sentence\n'
    expect(parseSubtitles(vtt)).toEqual([
      { index: 1, start: 1, end: 2, text: 'Play for us.', speaker: 'Alien Queen' },
      { index: 2, start: 3600.5, end: 3601.25, text: 'this is a sentence', speaker: 'Mission Control' },
    ])
  })

  it('skips blocks without a readable timing or text', () => {
    expect(parseSubtitles('1\n00:00:01,000 --> nope\nText\n\n2\n00:00:02,000 --> 00:00:03,000\n\n')).toEqual([])
    expect(parseTimestamp('1:02:03.4')).toBe(3723.4)
    expect(parseTimestamp('garbage')).toBeNull()
  })

  it('turns rows into a table with fixed columns', () => {
    const table = subtitleTable('srt', [{ index: 1, start: 0.1234, end: 2, text: 'Hi' }])
    expect(table).toEqual({ format: 'srt', columns: SUBTITLE_COLUMNS, rows: [['1', '0.123', '2', '', 'Hi']] })
  })
})

describe('text and markdown', () => {
  it('reads the first markdown table as rows with escaped pipes', () => {
    const md = '# Lines\n\n| id | text |\n|---|:---:|\n| A1 | Hello \\| there |\n| A2 | Bye |\n\nafter'
    expect(markdownTable(md)).toEqual({ format: 'markdown table', columns: ['id', 'text'], rows: [['A1', 'Hello | there'], ['A2', 'Bye']] })
    expect(markdownTable('no table here')).toBeNull()
  })

  it('reads text as paragraphs, or lines when there are no blank lines', () => {
    expect(textTable('a.txt', 'One.\nTwo.\n')).toEqual({ format: 'txt', columns: ['text'], rows: [['One.'], ['Two.']] })
    expect(textTable('a.md', 'First\nstill first\n\nSecond')).toEqual({ format: 'md', columns: ['text'], rows: [['First\nstill first'], ['Second']] })
  })
})

describe('JSON records', () => {
  const dump = {
    meta: { game: 'x' },
    lines: [
      { id: 'L1', text: { en: 'Hello' }, speaker: 'Ada', tags: ['a'] },
      { id: 'L2', text: { en: 'Bye' }, speaker: null },
    ],
    byKey: { k1: { en: 'One' }, k2: { en: 'Two' } },
  }

  it('parses dotted, bracketed, quoted and wildcard steps', () => {
    expect(parseJsonPath('$.lines[*].text.en')).toEqual([{ key: 'lines' }, { all: true }, { key: 'text' }, { key: 'en' }])
    expect(parseJsonPath("byKey['k1'][0].*")).toEqual([{ key: 'byKey' }, { key: 'k1' }, { index: 0 }, { all: true }])
    expect(parseJsonPath('$')).toEqual([])
    expect(() => parseJsonPath('$.a[')).toThrow(/Invalid JSON path/)
    expect(selectJson(dump, parseJsonPath('$.byKey.*.en'))).toEqual(['One', 'Two'])
  })

  it('selects records with explicit field paths', () => {
    expect(jsonRecords(dump, '$.lines[*]', ['id', 'text.en', 'speaker', 'tags[0]'])).toEqual({
      format: 'json',
      columns: ['id', 'text.en', 'speaker', 'tags[0]'],
      rows: [['L1', 'Hello', 'Ada', 'a'], ['L2', 'Bye', '', '']],
    })
  })

  it('derives columns from record keys, or one value column for scalars', () => {
    const table = jsonRecords(dump, '$.lines[*]')
    expect(table.columns).toEqual(['id', 'text', 'speaker', 'tags'])
    expect(table.rows[0]).toEqual(['L1', '{"en":"Hello"}', 'Ada', '["a"]'])
    expect(jsonRecords(dump, '$.lines[*].id')).toEqual({ format: 'json', columns: ['value'], rows: [['L1'], ['L2']] })
    expect(() => jsonRecords(dump, '$.missing[*]')).toThrow(/selects nothing/)
  })
})

describe('resolveColumn', () => {
  it('takes an index, an exact header or a loose header', () => {
    const columns = ['Cue ID', 'Source Text']
    expect(resolveColumn(columns, 1)).toBe(1)
    expect(resolveColumn(columns, 'Cue ID')).toBe(0)
    expect(resolveColumn(columns, 'source_text')).toBe(1)
    expect(() => resolveColumn(columns, 'nope')).toThrow('No column "nope"; columns are "Cue ID", "Source Text"')
    expect(() => resolveColumn(columns, 5)).toThrow(/does not exist/)
  })
})

describe('bin routing', () => {
  it('sends audio and video to lines, every other file to the bin, folders to both and a template to re-import', () => {
    expect(
      routeDrop(['/in/a.wav', '/in/b.MP3', '/in/c.mp4', '/in/t.csv', '/in/t.xlsx', '/in/n.txt', '/in/s.srt', '/in/d.json', '/in/x.xml', '/in/voice', '/in/g.locres', '/in/demo.vostudio-src'])
    ).toEqual({
      templates: ['/in/demo.vostudio-src'],
      lines: ['/in/a.wav', '/in/b.MP3', '/in/c.mp4', '/in/voice', '/in/g.locres'],
      bin: ['/in/t.csv', '/in/t.xlsx', '/in/n.txt', '/in/s.srt', '/in/d.json', '/in/x.xml', '/in/voice', '/in/g.locres'],
    })
  })

  it('leaves an audio-only drop on the line import exactly as before', () => {
    expect(routeDrop(['C:/vo/a.wav', 'C:/vo/b.ogg'])).toEqual({ templates: [], lines: ['C:/vo/a.wav', 'C:/vo/b.ogg'], bin: [] })
  })

  it('reports what landed in the bin', () => {
    expect(binAddedText({ added: [1, 2], skipped: [] })).toBe('2 added to the bin')
    expect(binAddedText({ added: [], skipped: [1] })).toBe('0 added to the bin · 1 skipped')
  })

  it('offers every known extension in the file picker', () => {
    expect(ASSET_EXTENSIONS).toEqual(expect.arrayContaining(['wav', 'mp3', 'ogg', 'm4a', 'mp4', 'mov', 'mkv', 'srt', 'vtt', 'md', 'txt', 'json', 'csv', 'xlsx']))
  })
})
