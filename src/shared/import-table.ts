import { changeCueSourceText, changeCueText } from './approval'
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

export function tableDelimiter(fileName: string, firstLine: string): ',' | '\t' {
  if (/\.tsv$/i.test(fileName)) return '\t'
  if (/\.csv$/i.test(fileName)) return ','
  return firstLine.includes('\t') ? '\t' : ','
}

export interface TableApplyResult {
  changed: Cue[]
  matched: number
  unmatched: Cue[]
  createdCharacters: Character[]
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

export function applyTable(
  project: Pick<Project, 'cues' | 'characters'>,
  rows: string[][],
  mapping: TableMapping,
  rule: MatchRule,
  replaceTranslations: boolean
): TableApplyResult {
  const idColumn = mapping.id
  if (idColumn === undefined) {
    return { changed: [], matched: 0, unmatched: [], createdCharacters: [] }
  }
  const byKey = new Map(project.cues.map((cue) => [matchKey(cue, rule), cue]))
  const before = project.characters.length
  const changed = new Map<string, Cue>()
  const unmatched: Cue[] = []
  let matched = 0

  for (const cells of rows) {
    const id = (cells[idColumn] ?? '').trim()
    if (!id) continue
    let cue = byKey.get(id)
    let touched = false
    if (!cue) {
      cue = {
        id: crypto.randomUUID(),
        characterId: '',
        key: id,
        fields: { EventName: id },
        sourceText: '',
        text: '',
        status: 'empty',
        notes: '',
        takes: [],
      }
      project.cues.push(cue)
      byKey.set(id, cue)
      unmatched.push(cue)
      touched = true
    } else matched++
    const source = mapping.text === undefined ? '' : (cells[mapping.text] ?? '').trim()
    if (source && source !== cue.sourceText) {
      Object.assign(cue, changeCueSourceText(cue, source))
      touched = true
    }
    const translation =
      mapping.translation === undefined ? '' : (cells[mapping.translation] ?? '').trim()
    if (translation && translation !== cue.text && (replaceTranslations || !cue.text.trim())) {
      Object.assign(cue, changeCueText(cue, translation))
      if (cue.status === 'empty') cue.status = 'translated'
      touched = true
    }
    const character = mapping.character === undefined ? '' : (cells[mapping.character] ?? '').trim()
    if (character) {
      const characterId = ensureCharacter(project, character)
      if (cue.characterId !== characterId) {
        cue.characterId = characterId
        touched = true
      }
    }
    if (touched) changed.set(cue.id, cue)
  }

  return {
    changed: [...changed.values()],
    matched,
    unmatched,
    createdCharacters: project.characters.slice(before),
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
  { id: 'unmatched', label: 'Unmatched' },
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
