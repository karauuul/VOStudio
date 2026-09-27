import { changeCueSourceText, changeCueText, invalidateVoicedOutput } from './approval'
import { parseCsv } from './csv'
import { LINE_TEXT_MAX, newLineCue, nextLineNumber, splitParagraphs } from './lines'
import { matchRowsByText, type TextMatchReport } from './agent-text'
import { PATH_FIELD } from './export-plan'
import type { ChangeSet, FieldStep, LineFields } from './project-commands'
import {
  blankCharacter,
  type Character,
  type Cue,
  type MatchRule,
  type Project,
} from './domain'

export type { MatchRule } from './domain'

export const MATCH_RULES: { id: MatchRule; label: string }[] = [
  { id: 'id', label: 'file name = id' },
  { id: 'exportName', label: 'file name = exportName' },
  { id: 'tableId', label: 'table id column' },
]

export const DEFAULT_MATCH_RULE: MatchRule = 'id'

export function matchKey(cue: Pick<Cue, 'key' | 'fields'>, rule: MatchRule): string {
  return rule === 'exportName' ? cue.fields['exportName'] || cue.key : cue.key
}

export type TableMatchBy = 'key' | 'text'
export type TableColumn = 'id' | 'text' | 'translation' | 'character'
export type TableMapping = Partial<Record<TableColumn, number>>

const HINTS: Record<TableColumn, string[]> = {
  id: ['cueid', 'id', 'eventname', 'key', 'wemid', 'exportname', 'name', 'file', 'filename'],
  text: ['sourcetext', 'source', 'original', 'en'],
  translation: ['translation', 'translated', 'target', 'localized', 'uk'],
  character: ['character', 'speaker', 'voice', 'actor'],
}

const EXACT_ORDER: TableColumn[] = ['id', 'text', 'translation', 'character']
const LOOSE_ORDER: TableColumn[] = ['id', 'translation', 'text', 'character']
const LINE_TEXT = 'text'

const normalize = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, '')

export function detectMapping(headers: string[]): TableMapping {
  const normalized = headers.map(normalize)
  const mapping: TableMapping = {}
  const used = new Set<number>()
  const claim = (column: TableColumn, index: number): void => {
    mapping[column] = index
    used.add(index)
  }
  for (const column of EXACT_ORDER) {
    const index = normalized.findIndex((h, i) => !used.has(i) && HINTS[column].includes(h))
    if (index >= 0) claim(column, index)
  }
  for (const column of LOOSE_ORDER) {
    if (mapping[column] !== undefined) continue
    const hints = HINTS[column].filter((h) => h.length >= 4)
    const index = normalized.findIndex((h, i) => !used.has(i) && hints.some((hint) => h.includes(hint)))
    if (index >= 0) claim(column, index)
  }
  const exact = normalized.findIndex((h, i) => !used.has(i) && h === LINE_TEXT)
  const lineText = exact >= 0 ? exact : normalized.findIndex((h, i) => !used.has(i) && h.includes(LINE_TEXT))
  const free = mapping.translation === undefined ? 'translation' : mapping.text === undefined ? 'text' : null
  if (lineText >= 0 && free) claim(free, lineText)
  return mapping
}

export const tableColumnLabels = (ai: boolean): Record<TableColumn, string> => ({
  id: 'Key',
  text: 'Original',
  translation: ai ? 'Translation' : 'Text',
  character: 'Character',
})

export const TABLE_FILE = /\.(csv|tsv|txt|xlsx)$/i

export function tableDelimiter(fileName: string, firstLine: string): ',' | '\t' {
  if (/\.tsv$/i.test(fileName)) return '\t'
  if (/\.csv$/i.test(fileName)) return ','
  return firstLine.includes('\t') ? '\t' : ','
}

export interface TableFile {
  script: boolean
  headers: string[]
  rows: string[][]
}

export const TABLE_ROWS_MAX = 100_000
export const TABLE_COLUMNS_MAX = 4096
export const PREVIEW_CELL_MAX = 200

export const previewCell = (cell: string): string =>
  cell.length > PREVIEW_CELL_MAX ? `${cell.slice(0, PREVIEW_CELL_MAX - 1)}…` : cell
export const CUE_KEY_MAX = 4096
export const CHARACTER_ID_MAX = 200

export const TABLE_CELLS_MAX = 4_000_000

export const TOO_MANY_ROWS = `Table has more than ${TABLE_ROWS_MAX} rows`
export const TOO_MANY_COLUMNS = `Table has more than ${TABLE_COLUMNS_MAX} columns`

function bounded(file: TableFile): TableFile {
  if (file.rows.length > TABLE_ROWS_MAX) throw new Error(TOO_MANY_ROWS)
  if (file.headers.length > TABLE_COLUMNS_MAX || file.rows.some((cells) => cells.length > TABLE_COLUMNS_MAX)) {
    throw new Error(TOO_MANY_COLUMNS)
  }
  return file
}

export function headedTable(headers: string[], rows: string[][]): TableFile {
  if (headers.length === 0) throw new Error('Table has no header row')
  return bounded({ script: false, headers, rows })
}

export function parseTableFile(fileName: string, raw: string): TableFile {
  const firstLine = raw.slice(0, raw.search(/\r?\n/) + 1 || undefined)
  if (/\.txt$/i.test(fileName) && !firstLine.includes('\t')) {
    return bounded({ script: true, headers: [], rows: splitParagraphs(raw.replace(/^\uFEFF/, '')).map((part) => [part]) })
  }
  const csv = parseCsv(raw, tableDelimiter(fileName, firstLine))
  return headedTable(csv.headers, csv.rows)
}

export function tableMapping(file: TableFile, requested?: TableMapping): TableMapping {
  if (file.script) return { translation: 0 }
  if (requested) return requested
  const mapping = detectMapping(file.headers)
  if (file.headers.length === 1 && Object.keys(mapping).length === 0) mapping.translation = 0
  return mapping
}

export function assignColumn(mapping: TableMapping, column: number, field: TableColumn | null): TableMapping {
  const next: TableMapping = {}
  for (const key of Object.keys(mapping) as TableColumn[]) {
    if (mapping[key] !== column && key !== field) next[key] = mapping[key]
  }
  if (field) next[field] = column
  return next
}

export interface TableSummary {
  added: number
  updated: number
  suggested: number
  unchanged: number
  skipped: number
}

export interface TableApplyResult {
  changed: Cue[]
  matched: number
  unmatched: Cue[]
  createdCharacters: Character[]
  summary: TableSummary
  rows: TableRowLine[]
  textMatch?: TextMatchReport
}

export interface TableRowLine {
  row: number
  cueId: string
}

function ensureCharacter(project: Pick<Project, 'characters'>, name: string): string {
  const lower = name.trim().toLowerCase()
  const found = project.characters.find(
    (character) => character.id === name || character.name.trim().toLowerCase() === lower
  )
  if (found) return found.id
  project.characters.push(blankCharacter(name, name, project.characters.length))
  return name
}

const cellAt = (cells: string[], column: number | undefined): string =>
  column === undefined ? '' : (cells[column] ?? '').trim()

const keyedCue = (key: string): Cue => ({
  id: crypto.randomUUID(),
  characterId: '',
  key,
  fields: { EventName: key },
  sourceText: '',
  text: '',
  status: 'empty',
  notes: '',
  takes: [],
})

export function coalesceRows(rows: string[][], keyColumn: number): { cells: string[]; row: number }[] {
  const merged = new Map<string, string[]>()
  const out: { cells: string[]; row: number }[] = []
  for (const [row, cells] of rows.entries()) {
    const key = (cells[keyColumn] ?? '').trim()
    const seen = key ? merged.get(key) : undefined
    if (!seen) {
      const copy = [...cells]
      if (key) merged.set(key, copy)
      out.push({ cells: copy, row })
      continue
    }
    cells.forEach((cell, i) => {
      if (cell.trim()) seen[i] = cell
    })
  }
  return out
}

export function applyTable(
  project: Pick<Project, 'cues' | 'characters' | 'linesFromTable'>,
  rows: string[][],
  mapping: TableMapping,
  rule: MatchRule,
  replaceTranslations: boolean,
  keepOriginal = false,
  matchBy: TableMatchBy = 'key'
): TableApplyResult {
  const textMatch = matchBy === 'text' ? matchRowsByText(project.cues, rows, textColumn(mapping)) : undefined
  const idColumn = textMatch ? undefined : mapping.id
  const byId = new Map(project.cues.map((cue) => [cue.id, cue]))
  const byKey = new Map(project.cues.map((cue) => [matchKey(cue, rule), cue]))
  const before = project.characters.length
  const changed = new Map<string, Cue>()
  const unmatched: Cue[] = []
  const summary: TableSummary = { added: 0, updated: 0, suggested: 0, unchanged: 0, skipped: 0 }
  let matched = 0
  let line = nextLineNumber(project.cues)
  const lines: TableRowLine[] = []
  const entries = textMatch
    ? textMatch.matched.map((m) => ({ cells: rows[m.index], row: m.index, cue: byId.get(m.cueId) }))
    : (idColumn === undefined ? rows.map((cells, row) => ({ cells, row })) : coalesceRows(rows, idColumn)).map((entry) => ({ ...entry, cue: undefined }))
  if (textMatch) summary.skipped += rows.length - entries.length

  for (const { cells, row, cue: textCue } of entries) {
    const id = cellAt(cells, idColumn)
    const source = cellAt(cells, mapping.text)
    const translation = cellAt(cells, mapping.translation)
    const character = cellAt(cells, mapping.character)
    if (
      (idColumn === undefined ? !source && !translation : !id) ||
      id.length > CUE_KEY_MAX ||
      character.length > CHARACTER_ID_MAX ||
      source.length > LINE_TEXT_MAX ||
      translation.length > LINE_TEXT_MAX
    ) {
      summary.skipped++
      continue
    }
    let cue = textCue ?? (idColumn === undefined ? undefined : byKey.get(id))
    if (!cue && textMatch) {
      summary.skipped++
      continue
    }
    const created = !cue
    if (!cue) {
      cue = idColumn === undefined ? newLineCue(crypto.randomUUID(), line++) : keyedCue(id)
      project.cues.push(cue)
      if (idColumn !== undefined) byKey.set(id, cue)
      unmatched.push(cue)
    } else matched++
    let touched = created
    let suggested = false
    if (source && source !== cue.sourceText && !(keepOriginal && cue.sourceText.trim())) {
      Object.assign(cue, changeCueSourceText(cue, source))
      touched = true
    }
    if (translation && translation !== cue.text) {
      if (replaceTranslations || !cue.text.trim()) {
        Object.assign(cue, changeCueText(cue, translation))
        if (cue.status === 'empty') cue.status = 'translated'
        delete cue.suggestedText
        touched = true
      } else if (translation !== cue.suggestedText) {
        cue.suggestedText = translation
        suggested = true
      }
    } else if (translation && cue.suggestedText !== undefined) {
      delete cue.suggestedText
      touched = true
    }
    if (character) {
      const characterId = ensureCharacter(project, character)
      if (cue.characterId !== characterId) {
        cue.characterId = characterId
        Object.assign(cue, invalidateVoicedOutput(cue, project))
        touched = true
      }
    }
    if (touched || suggested) changed.set(cue.id, cue)
    lines.push({ row, cueId: cue.id })
    summary[created ? 'added' : suggested ? 'suggested' : touched ? 'updated' : 'unchanged']++
  }
  if (unmatched.length > 0) project.linesFromTable = true

  return {
    changed: [...changed.values()],
    matched,
    unmatched,
    createdCharacters: project.characters.slice(before),
    summary,
    rows: lines,
    ...(textMatch ? { textMatch } : {}),
  }
}

export function textColumn(mapping: TableMapping): number {
  if (mapping.text === undefined) throw new Error('Matching by text needs a mapped original text column')
  return mapping.text
}

export interface TableOptions {
  mapping: TableMapping
  rule: MatchRule
  replaceTranslations: boolean
  keepOriginal: boolean
  matchBy?: TableMatchBy
}

export interface TableUndo {
  ids: string[]
  fields: FieldStep[]
  characters: Character[]
}

export interface TableCommit {
  summary: TableSummary
  rows: TableRowLine[]
  textMatch?: TextMatchReport
  undo: TableUndo
  changes: ChangeSet | null
}

const lineFields = (cue: Cue): Required<LineFields> => ({
  sourceText: cue.sourceText,
  text: cue.text,
  characterId: cue.characterId,
  suggestedText: cue.suggestedText ?? null,
})

const LINE_FIELD_KEYS = ['sourceText', 'text', 'characterId', 'suggestedText'] as const

export function previewTable(project: Pick<Project, 'cues' | 'characters'>, rows: string[][], options: TableOptions): TableSummary {
  const copy = { cues: project.cues.map((cue) => ({ ...cue })), characters: [...project.characters] }
  return applyTable(copy, rows, options.mapping, options.rule, options.replaceTranslations, options.keepOriginal, options.matchBy).summary
}

export function commitTable(
  project: Pick<Project, 'cues' | 'characters' | 'linesFromTable'>,
  rows: string[][],
  options: TableOptions
): TableCommit {
  const before = new Map(project.cues.map((cue) => [cue.id, lineFields(cue)]))
  const applied = applyTable(project, rows, options.mapping, options.rule, options.replaceTranslations, options.keepOriginal, options.matchBy)
  const fields: FieldStep[] = []
  for (const cue of applied.changed) {
    const from = before.get(cue.id)
    if (!from) continue
    const to = lineFields(cue)
    const keys = LINE_FIELD_KEYS.filter((key) => from[key] !== to[key])
    if (keys.length === 0) continue
    fields.push({
      cueId: cue.id,
      from: Object.fromEntries(keys.map((key) => [key, from[key]])),
      to: Object.fromEntries(keys.map((key) => [key, to[key]])),
    })
  }
  const createdCharacters = applied.createdCharacters.length > 0
  const createdLines = applied.unmatched.length > 0
  return {
    summary: applied.summary,
    rows: applied.rows,
    ...(applied.textMatch ? { textMatch: applied.textMatch } : {}),
    undo: {
      ids: applied.unmatched.map((cue) => cue.id),
      fields,
      characters: structuredClone(applied.createdCharacters),
    },
    changes:
      applied.changed.length === 0 && !createdCharacters
        ? null
        : {
            cues: structuredClone(applied.changed),
            ...(createdCharacters ? { characters: structuredClone(project.characters), charactersReplace: true } : {}),
            ...(createdLines ? { linesFromTable: true } : {}),
          },
  }
}

export interface AudioMatch<T> {
  update: { cue: Cue; file: T }[]
  create: T[]
  duplicates: T[]
}

export function matchAudioFiles<T extends { name: string }>(
  cues: Pick<Cue, 'key' | 'fields'>[],
  files: T[],
  rule: MatchRule
): AudioMatch<T> {
  const byKey = new Map(cues.map((cue) => [matchKey(cue, rule), cue as Cue]))
  const update: { cue: Cue; file: T }[] = []
  const create: T[] = []
  const duplicates: T[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.name)) {
      duplicates.push(file)
      continue
    }
    seen.add(file.name)
    const cue = byKey.get(file.name)
    if (cue) update.push({ cue, file })
    else create.push(file)
  }
  return { update, create, duplicates }
}

export function attachesOnly(project: Pick<Project, 'template' | 'csvBinding' | 'linesFromTable' | 'cues'>): boolean {
  return (
    project.template !== undefined ||
    project.csvBinding !== undefined ||
    project.linesFromTable === true ||
    project.cues.some((cue) => Object.keys(cue.fields).some((field) => field !== 'EventName' && field !== PATH_FIELD))
  )
}

export type ImportTab = 'all' | 'notranscript' | 'notranslation' | 'unmatched'

export function hasSourceMaterial(project: Pick<Project, 'cues' | 'languages'>): boolean {
  return (
    project.languages !== undefined ||
    project.cues.some(
      (cue) =>
        cue.sourceText.trim() !== '' ||
        cue.referenceAudio !== undefined ||
        cue.region !== undefined ||
        (cue.referenceDuration ?? 0) > 0
    )
  )
}

export const importTabs = (ai: boolean): { id: ImportTab; label: string }[] =>
  ai
    ? [
        { id: 'all', label: 'All' },
        { id: 'notranscript', label: 'No transcript' },
        { id: 'notranslation', label: 'No translation' },
        { id: 'unmatched', label: 'No audio' },
      ]
    : [
        { id: 'all', label: 'All' },
        { id: 'notranslation', label: 'No text' },
      ]

export const hasAudio = (cue: Cue): boolean => !!cue.referenceAudio || !!cue.region

export function matchesImportTab(cue: Cue, tab: ImportTab): boolean {
  switch (tab) {
    case 'notranscript':
      return !cue.sourceText.trim()
    case 'notranslation':
      return !cue.text.trim()
    case 'unmatched':
      return !hasAudio(cue)
    default:
      return true
  }
}

export interface ImportCounts {
  lines: number
  transcribed: number
  translated: number
  notranscript: number
  notranslation: number
  unmatched: number
}

export function importCounts(cues: Cue[]): ImportCounts {
  const counts: ImportCounts = {
    lines: cues.length,
    transcribed: 0,
    translated: 0,
    notranscript: 0,
    notranslation: 0,
    unmatched: 0,
  }
  for (const cue of cues) {
    if (cue.sourceText.trim()) counts.transcribed++
    else counts.notranscript++
    if (cue.text.trim()) counts.translated++
    else counts.notranslation++
    if (!hasAudio(cue)) counts.unmatched++
  }
  return counts
}

export interface AudioSourceRow {
  name: string
  files: number
  formats: string[]
  duration: number
  lines: number
}

const parentName = (relPath: string): string => {
  const parts = relPath.split(/[\\/]/)
  return parts.length > 1 ? parts[parts.length - 2] : ''
}

export function audioSources(cues: Cue[]): AudioSourceRow[] {
  const rows = new Map<string, AudioSourceRow>()
  for (const cue of cues) {
    const ref = cue.referenceAudio
    if (!ref) continue
    const name = parentName(ref.relPath) || 'reference'
    let row = rows.get(name)
    if (!row) rows.set(name, (row = { name, files: 0, formats: [], duration: 0, lines: 0 }))
    row.files++
    row.lines++
    row.duration += cue.referenceDuration ?? 0
    if (!row.formats.includes(ref.format)) row.formats.push(ref.format)
  }
  return [...rows.values()]
}

export type LineDot = 'ready' | 'transcript' | 'none'

export function lineDot(cue: Cue): LineDot {
  if (!hasAudio(cue)) return 'none'
  return cue.text.trim() ? 'ready' : 'transcript'
}
