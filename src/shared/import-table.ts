import { changeCueSourceText, changeCueText } from './approval'
import { parseCsv } from './csv'
import { newLineCue, nextLineNumber, splitParagraphs } from './lines'
import type { ChangeSet, FieldStep, LineFields } from './project-commands'
import {
  characterColor,
  DEFAULT_VOICE_SETTINGS,
  ELEVENLABS_STS_MODEL,
  ELEVENLABS_TTS_MODEL,
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

export type TableColumn = 'id' | 'text' | 'translation' | 'character'
export type TableMapping = Partial<Record<TableColumn, number>>

const HINTS: Record<TableColumn, string[]> = {
  id: ['cueid', 'id', 'eventname', 'key', 'wemid', 'exportname', 'name', 'file', 'filename'],
  text: ['sourcetext', 'source', 'original', 'text', 'en'],
  translation: ['translation', 'translated', 'target', 'localized', 'uk'],
  character: ['character', 'speaker', 'voice', 'actor'],
}

const EXACT_ORDER: TableColumn[] = ['id', 'text', 'translation', 'character']
const LOOSE_ORDER: TableColumn[] = ['id', 'translation', 'text', 'character']

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
  return mapping
}

export const TABLE_FILE = /\.(csv|tsv|txt)$/i

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
export const CUE_KEY_MAX = 4096
export const CHARACTER_ID_MAX = 200

function bounded(file: TableFile): TableFile {
  if (file.rows.length > TABLE_ROWS_MAX) throw new Error(`Table has more than ${TABLE_ROWS_MAX} rows`)
  return file
}

export function parseTableFile(fileName: string, raw: string): TableFile {
  const firstLine = raw.slice(0, raw.search(/\r?\n/) + 1 || undefined)
  if (/\.txt$/i.test(fileName) && !firstLine.includes('\t')) {
    return bounded({ script: true, headers: [], rows: splitParagraphs(raw.replace(/^\uFEFF/, '')).map((part) => [part]) })
  }
  const csv = parseCsv(raw, tableDelimiter(fileName, firstLine))
  if (csv.headers.length === 0) throw new Error('Table has no header row')
  return bounded({ script: false, headers: csv.headers, rows: csv.rows })
}

export function tableMapping(
  file: TableFile,
  cues: Pick<Cue, 'sourceText'>[],
  requested?: TableMapping
): TableMapping {
  if (file.script) return { translation: 0 }
  if (requested) return requested
  const mapping = detectMapping(file.headers)
  if (file.headers.length === 1 && Object.keys(mapping).length === 0) mapping.text = 0
  if (mapping.text !== undefined && mapping.translation === undefined && cues.every((cue) => !cue.sourceText.trim())) {
    mapping.translation = mapping.text
    delete mapping.text
  }
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
  unchanged: number
  skipped: number
}

export interface TableApplyResult {
  changed: Cue[]
  matched: number
  unmatched: Cue[]
  createdCharacters: Character[]
  summary: TableSummary
}

function ensureCharacter(project: Pick<Project, 'characters'>, name: string): string {
  const lower = name.trim().toLowerCase()
  const found = project.characters.find(
    (character) => character.id === name || character.name.trim().toLowerCase() === lower
  )
  if (found) return found.id
  project.characters.push({
    id: name,
    name,
    color: characterColor(project.characters.length),
    provider: {
      providerId: 'elevenlabs',
      voiceId: '',
      ttsModel: ELEVENLABS_TTS_MODEL,
      stsModel: ELEVENLABS_STS_MODEL,
    },
    voiceSettings: { ...DEFAULT_VOICE_SETTINGS },
  })
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

export function applyTable(
  project: Pick<Project, 'cues' | 'characters'>,
  rows: string[][],
  mapping: TableMapping,
  rule: MatchRule,
  replaceTranslations: boolean,
  keepOriginal = false
): TableApplyResult {
  const idColumn = mapping.id
  const byKey = new Map(project.cues.map((cue) => [matchKey(cue, rule), cue]))
  const before = project.characters.length
  const changed = new Map<string, Cue>()
  const unmatched: Cue[] = []
  const summary: TableSummary = { added: 0, updated: 0, unchanged: 0, skipped: 0 }
  let matched = 0
  let line = nextLineNumber(project.cues)

  for (const cells of rows) {
    const id = cellAt(cells, idColumn)
    const source = cellAt(cells, mapping.text)
    const translation = cellAt(cells, mapping.translation)
    const character = cellAt(cells, mapping.character)
    if (
      (idColumn === undefined ? !source && !translation : !id) ||
      id.length > CUE_KEY_MAX ||
      character.length > CHARACTER_ID_MAX
    ) {
      summary.skipped++
      continue
    }
    let cue = idColumn === undefined ? undefined : byKey.get(id)
    const created = !cue
    if (!cue) {
      cue = idColumn === undefined ? newLineCue(crypto.randomUUID(), line++) : keyedCue(id)
      project.cues.push(cue)
      if (idColumn !== undefined) byKey.set(id, cue)
      unmatched.push(cue)
    } else matched++
    let touched = created
    if (source && source !== cue.sourceText && !(keepOriginal && cue.sourceText.trim())) {
      Object.assign(cue, changeCueSourceText(cue, source))
      touched = true
    }
    if (translation && translation !== cue.text && (replaceTranslations || !cue.text.trim())) {
      Object.assign(cue, changeCueText(cue, translation))
      if (cue.status === 'empty') cue.status = 'translated'
      touched = true
    }
    if (character) {
      const characterId = ensureCharacter(project, character)
      if (cue.characterId !== characterId) {
        cue.characterId = characterId
        touched = true
      }
    }
    if (touched) changed.set(cue.id, cue)
    summary[created ? 'added' : touched ? 'updated' : 'unchanged']++
  }

  return {
    changed: [...changed.values()],
    matched,
    unmatched,
    createdCharacters: project.characters.slice(before),
    summary,
  }
}

export interface TableOptions {
  mapping: TableMapping
  rule: MatchRule
  replaceTranslations: boolean
  keepOriginal: boolean
}

export interface TableUndo {
  ids: string[]
  fields: FieldStep[]
  characters: Character[]
}

export interface TableCommit {
  summary: TableSummary
  undo: TableUndo
  changes: ChangeSet | null
}

const lineFields = (cue: Cue): Required<LineFields> => ({
  sourceText: cue.sourceText,
  text: cue.text,
  characterId: cue.characterId,
})

const LINE_FIELD_KEYS = ['sourceText', 'text', 'characterId'] as const

export function previewTable(project: Pick<Project, 'cues' | 'characters'>, rows: string[][], options: TableOptions): TableSummary {
  const copy = { cues: project.cues.map((cue) => ({ ...cue })), characters: [...project.characters] }
  return applyTable(copy, rows, options.mapping, options.rule, options.replaceTranslations, options.keepOriginal).summary
}

export function commitTable(project: Pick<Project, 'cues' | 'characters'>, rows: string[][], options: TableOptions): TableCommit {
  const before = new Map(project.cues.map((cue) => [cue.id, lineFields(cue)]))
  const applied = applyTable(project, rows, options.mapping, options.rule, options.replaceTranslations, options.keepOriginal)
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
  return {
    summary: applied.summary,
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
          },
  }
}

export interface AudioMatch<T> {
  update: { cue: Cue; file: T }[]
  create: T[]
}

export function matchAudioFiles<T extends { name: string }>(
  cues: Pick<Cue, 'key' | 'fields'>[],
  files: T[],
  rule: MatchRule
): AudioMatch<T> {
  const byKey = new Map(cues.map((cue) => [matchKey(cue, rule), cue as Cue]))
  const update: { cue: Cue; file: T }[] = []
  const create: T[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.name)) continue
    seen.add(file.name)
    const cue = byKey.get(file.name)
    if (cue) update.push({ cue, file })
    else create.push(file)
  }
  return { update, create }
}

export type ImportTab = 'all' | 'notranscript' | 'notranslation' | 'unmatched'

export const IMPORT_TABS: { id: ImportTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'notranscript', label: 'No transcript' },
  { id: 'notranslation', label: 'No translation' },
  { id: 'unmatched', label: 'No audio' },
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
