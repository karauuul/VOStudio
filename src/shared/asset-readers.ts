import type { AssetKind } from './domain'
import { TABLE_COLUMNS_MAX, TABLE_ROWS_MAX } from './import-table'
import { splitParagraphs } from './lines'

const KIND_BY_EXTENSION: Record<string, AssetKind> = {
  wav: 'audio',
  mp3: 'audio',
  ogg: 'audio',
  flac: 'audio',
  m4a: 'audio',
  mp4: 'video',
  mov: 'video',
  mkv: 'video',
  csv: 'table',
  tsv: 'table',
  xlsx: 'table',
  srt: 'subtitles',
  vtt: 'subtitles',
  md: 'text',
  txt: 'text',
  json: 'data',
  xml: 'data',
}

export const extensionOf = (fileName: string): string => /\.([^./\\]+)$/.exec(fileName)?.[1].toLowerCase() ?? ''

export const assetKind = (fileName: string): AssetKind => KIND_BY_EXTENSION[extensionOf(fileName)] ?? 'other'

export const inPlaceKind = (kind: AssetKind): boolean => kind === 'audio' || kind === 'video'

export interface AssetTable {
  format: string
  columns: string[]
  rows: string[][]
}

export interface AssetText {
  format: string
  lines: string[]
}

function bounded(table: AssetTable): AssetTable {
  if (table.rows.length > TABLE_ROWS_MAX) throw new Error(`The asset has more than ${TABLE_ROWS_MAX} rows.`)
  if (table.columns.length > TABLE_COLUMNS_MAX) throw new Error(`The asset has more than ${TABLE_COLUMNS_MAX} columns.`)
  return table
}

export const textLines = (raw: string): string[] => raw.replace(/^\uFEFF/, '').split(/\r\n?|\n/)

export interface SubtitleRow {
  index: number
  start: number
  end: number
  text: string
  speaker?: string
}

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/

export function parseTimestamp(value: string): number | null {
  const m = TIMESTAMP.exec(value.trim())
  if (!m) return null
  const [, h, min, sec, frac] = m
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec) + (frac ? Number(frac.padEnd(3, '0')) / 1000 : 0)
}

const VOICE_TAG = /^<v(?:\.[^\s>]*)?\s+([^>]+)>/i
const SPEAKER_PREFIX = /^([\p{L}][\p{L}\p{N}_'.-]*(?: [\p{L}\p{N}_'.-]+){0,2}):\s+(\S.*)$/su

function speakerOf(text: string): { text: string; speaker?: string } {
  const voice = VOICE_TAG.exec(text)
  const plain = text.replace(/<[^>]*>/g, '').trim()
  if (voice) return { text: plain, speaker: voice[1].trim() }
  const prefix = SPEAKER_PREFIX.exec(plain)
  if (prefix && prefix[1].length <= 32) return { text: prefix[2].trim(), speaker: prefix[1] }
  return { text: plain }
}

export function parseSubtitles(raw: string): SubtitleRow[] {
  const out: SubtitleRow[] = []
  const blocks = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const at = lines.findIndex((line) => line.includes('-->'))
    if (at < 0) continue
    const [from, rest] = lines[at].split('-->')
    const start = parseTimestamp(from)
    const end = parseTimestamp((rest ?? '').trim().split(/\s+/)[0] ?? '')
    if (start === null || end === null) continue
    const body = lines.slice(at + 1).join('\n').trim()
    if (!body) continue
    const { text, speaker } = speakerOf(body)
    if (out.length >= TABLE_ROWS_MAX) throw new Error(`The asset has more than ${TABLE_ROWS_MAX} rows.`)
    out.push({ index: out.length + 1, start, end: Math.max(start, end), text, ...(speaker ? { speaker } : {}) })
  }
  return out
}

export const SUBTITLE_COLUMNS = ['index', 'start', 'end', 'speaker', 'text']

const seconds = (value: number): string => String(Math.round(value * 1000) / 1000)

export function subtitleTable(format: string, rows: SubtitleRow[]): AssetTable {
  return {
    format,
    columns: SUBTITLE_COLUMNS,
    rows: rows.map((row) => [String(row.index), seconds(row.start), seconds(row.end), row.speaker ?? '', row.text]),
  }
}

const MD_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

const markdownCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))

export function markdownTable(raw: string): AssetTable | null {
  const lines = textLines(raw)
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes('|') || !MD_SEPARATOR.test(lines[i + 1].trim())) continue
    const columns = markdownCells(lines[i])
    const rows: string[][] = []
    for (let j = i + 2; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) rows.push(markdownCells(lines[j]))
    return bounded({ format: 'markdown table', columns, rows })
  }
  return null
}

export function textTable(fileName: string, raw: string): AssetTable {
  const table = extensionOf(fileName) === 'md' ? markdownTable(raw) : null
  if (table) return table
  return bounded({ format: extensionOf(fileName) || 'text', columns: ['text'], rows: splitParagraphs(raw.replace(/^\uFEFF/, '')).map((line) => [line]) })
}

type JsonStep = { key: string } | { index: number } | { all: true }

const PATH_TOKEN = /\.\*|\[\*\]|\[(\d+)\]|\[\s*(?:'([^']*)'|"([^"]*)")\s*\]|\.?([^.[\]]+)/y

export function parseJsonPath(path: string): JsonStep[] {
  const source = path.trim().replace(/^\$/, '')
  const steps: JsonStep[] = []
  PATH_TOKEN.lastIndex = 0
  while (PATH_TOKEN.lastIndex < source.length) {
    const at = PATH_TOKEN.lastIndex
    const m = PATH_TOKEN.exec(source)
    if (!m || m[0] === '') throw new Error(`Invalid JSON path "${path}" at character ${at + 1}.`)
    if (m[0] === '.*' || m[0] === '[*]') steps.push({ all: true })
    else if (m[1] !== undefined) steps.push({ index: Number(m[1]) })
    else steps.push({ key: m[2] ?? m[3] ?? m[4] })
  }
  return steps
}

export function selectJson(value: unknown, steps: JsonStep[]): unknown[] {
  let current = [value]
  for (const step of steps) {
    const next: unknown[] = []
    for (const item of current) {
      if (item === null || typeof item !== 'object') continue
      if ('all' in step) for (const child of Array.isArray(item) ? item : Object.values(item)) next.push(child)
      else if ('index' in step) {
        if (Array.isArray(item) && step.index < item.length) next.push(item[step.index])
      } else if (!Array.isArray(item) && Object.prototype.hasOwnProperty.call(item, step.key)) {
        next.push((item as Record<string, unknown>)[step.key])
      }
    }
    if (next.length > TABLE_ROWS_MAX) throw new Error(`The JSON path selects more than ${TABLE_ROWS_MAX} records.`)
    current = next
  }
  return current
}

export const jsonCell = (value: unknown): string =>
  value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)

const COLUMN_SAMPLE = 200

export function jsonRecords(root: unknown, path: string, fields?: string[]): AssetTable {
  const records = selectJson(root, parseJsonPath(path))
  if (records.length === 0) throw new Error(`The JSON path "${path}" selects nothing.`)
  if (fields && fields.length > 0) {
    const steps = fields.map(parseJsonPath)
    return bounded({
      format: 'json',
      columns: fields,
      rows: records.map((record) => steps.map((s) => (s.length === 0 ? jsonCell(record) : jsonCell(selectJson(record, s)[0])))),
    })
  }
  const objects = records.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))
  if (!objects) return bounded({ format: 'json', columns: ['value'], rows: records.map((r) => [jsonCell(r)]) })
  const columns = [...new Set(records.slice(0, COLUMN_SAMPLE).flatMap((r) => Object.keys(r as object)))]
  return bounded({
    format: 'json',
    columns,
    rows: records.map((r) => columns.map((c) => jsonCell((r as Record<string, unknown>)[c]))),
  })
}

const columnName = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export function resolveColumn(columns: string[], ref: string | number): number {
  if (typeof ref === 'number') {
    if (ref >= 0 && ref < columns.length) return ref
    throw new Error(`Column ${ref} does not exist; the asset has ${columns.length} columns.`)
  }
  const exact = columns.indexOf(ref)
  if (exact >= 0) return exact
  const loose = columns.findIndex((c) => columnName(c) === columnName(ref))
  if (loose >= 0) return loose
  throw new Error(`No column "${ref}"; columns are ${columns.map((c) => `"${c}"`).join(', ')}.`)
}
