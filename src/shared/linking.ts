import { matchRowsByText, normalizeText } from './agent-text'
import {
  speakerCharacters,
  withOrigin,
  type AssetKind,
  type Character,
  type Cue,
  type Project,
  type ProjectAsset,
  type ProposalKind,
  type Term,
} from './domain'
import { PATH_FIELD } from './export-plan'
import { detectMapping, commitTable, type TableMapping } from './import-table'
import { inPlaceKind, resolveColumn, SUBTITLE_COLUMNS } from './asset-readers'
import { TEXT_TOO_LONG, textTooLong } from './lines'
import type { ChangeSet, FieldStep, ProposalItem, ProposalRef } from './project-commands'

export const KEY_EXACT = 1
export const KEY_NORMALIZED = 0.95
export const KEY_AFFIX = 0.85
export const KEY_NUMBER = 0.6
export const SPEAKER_CONFIDENCE = 0.9
export const START_FIELD = 'start'
export const END_FIELD = 'end'

const IGNORED_FIELDS = new Set([PATH_FIELD, START_FIELD, END_FIELD])

export function keyTokens(key: string): string[] {
  return key
    .normalize('NFKC')
    .trim()
    .replace(/\.[a-z][a-z0-9]{1,3}$/i, '')
    .split(/[^\p{L}\p{N}]+|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)
    .filter(Boolean)
    .map((token) => (/^\d+$/.test(token) ? token.replace(/^0+(?=\d)/, '') : token.toLowerCase()))
}

function commonAffix(lists: string[][], fromEnd: boolean): number {
  const usable = lists.filter((tokens) => tokens.length > 1)
  if (usable.length < 2) return 0
  const at = (tokens: string[], i: number): string => tokens[fromEnd ? tokens.length - 1 - i : i]
  let n = 0
  const shortest = Math.min(...usable.map((tokens) => tokens.length))
  while (n < shortest - 1 && usable.every((tokens) => at(tokens, n) === at(usable[0], n))) n++
  return n
}

function affixForms(lists: string[][]): (tokens: string[]) => string[] {
  const head = commonAffix(lists, false)
  const tail = commonAffix(lists, true)
  return (tokens) => {
    const forms: string[] = []
    for (let i = 0; i <= Math.min(head, tokens.length - 1); i++) {
      for (let j = 0; j <= Math.min(tail, tokens.length - 1 - i); j++) forms.push(tokens.slice(i, tokens.length - j).join(' '))
    }
    return forms.sort((x, y) => y.length - x.length)
  }
}

export interface Link {
  row: number
  cueId: string
  key: string
  confidence: number
  reason: string
}

export interface LinkReport {
  links: Link[]
  ambiguous: { row: number; candidates: string[] }[]
  unmatched: number[]
  needsTranscribe: string[]
}

type Index = Map<string, Set<Cue>>

const addTo = (index: Index, value: string, cue: Cue): void => {
  if (!value) return
  const set = index.get(value)
  if (set) set.add(cue)
  else index.set(value, new Set([cue]))
}

const lineKeys = (cue: Cue): string[] => [
  cue.key,
  ...Object.entries(cue.fields)
    .filter(([name]) => !IGNORED_FIELDS.has(name))
    .map(([, value]) => value),
]

export function linkByKey(cues: Cue[], keys: string[]): Omit<LinkReport, 'needsTranscribe'> {
  const rowTokens = keys.map(keyTokens)
  const cueValues = cues.map((cue) => lineKeys(cue).map((v) => v.trim()).filter(Boolean))
  const lineTokens = cueValues.map((values) => values.map(keyTokens))
  const rowForms = affixForms(rowTokens)
  const lineForms = affixForms(lineTokens.map((t) => t[0] ?? []))
  const exact: Index = new Map()
  const normalized: Index = new Map()
  const stripped: Index = new Map()
  cues.forEach((cue, i) => {
    cueValues[i].forEach((value, j) => {
      addTo(exact, value, cue)
      addTo(normalized, lineTokens[i][j].join(' '), cue)
      for (const form of lineForms(lineTokens[i][j])) addTo(stripped, form, cue)
    })
  })
  const report: Omit<LinkReport, 'needsTranscribe'> = { links: [], ambiguous: [], unmatched: [] }
  const tentative: Link[] = []
  keys.forEach((raw, row) => {
    const key = raw.trim()
    if (!key) {
      report.unmatched.push(row)
      return
    }
    const full = rowTokens[row].join(' ')
    const core = rowForms(rowTokens[row]).find((form) => stripped.get(form)?.size) ?? ''
    const numeric = /^\d+$/.test(core)
    const levels: [Set<Cue> | undefined, number, string][] = [
      [exact.get(key), KEY_EXACT, `key "${key}" equals the line key`],
      [normalized.get(full), KEY_NORMALIZED, `key "${key}" matches ignoring case, separators and zero padding`],
      [
        stripped.get(core),
        numeric ? KEY_NUMBER : KEY_AFFIX,
        numeric ? `only the number of key "${key}" matches` : `key "${key}" matches after dropping the prefix or suffix shared by all keys`,
      ],
    ]
    const hit = levels.find(([set]) => set && set.size > 0)
    if (!hit) {
      report.unmatched.push(row)
      return
    }
    const [set, confidence, reason] = hit as [Set<Cue>, number, string]
    if (set.size > 1) {
      report.ambiguous.push({ row, candidates: [...set].map((cue) => cue.key) })
      return
    }
    const cue = [...set][0]
    tentative.push({ row, cueId: cue.id, key: cue.key, confidence, reason })
  })
  const claimed = new Set<string>()
  for (const link of [...tentative].sort((a, b) => b.confidence - a.confidence || a.row - b.row)) {
    if (claimed.has(link.cueId)) {
      report.ambiguous.push({ row: link.row, candidates: [link.key] })
      continue
    }
    claimed.add(link.cueId)
    report.links.push(link)
  }
  report.links.sort((a, b) => a.row - b.row)
  report.ambiguous.sort((a, b) => a.row - b.row)
  return report
}

export type LinkStrategy = 'key' | 'text' | 'auto'

export function linkRows(
  cues: Cue[],
  rows: string[][],
  columns: { key?: number; text?: number },
  strategy: LinkStrategy
): LinkReport {
  const useKey = strategy !== 'text' && columns.key !== undefined
  const useText = strategy !== 'key' && columns.text !== undefined
  if (strategy === 'key' && !useKey) throw new Error('Linking by key needs a key column; pass mapping.key.')
  if (strategy === 'text' && !useText) throw new Error('Linking by text needs a text column; pass mapping.text.')
  if (!useKey && !useText) throw new Error('The asset has no key or text column to link by; pass mapping.')
  const report: LinkReport = { links: [], ambiguous: [], unmatched: [], needsTranscribe: [] }
  let pendingRows = rows.map((_, row) => row)
  let pendingCues = cues
  const keyAmbiguous = new Map<number, LinkReport['ambiguous'][number]>()
  if (useKey) {
    const byKey = linkByKey(cues, rows.map((cells) => cells[columns.key as number] ?? ''))
    report.links.push(...byKey.links)
    if (!useText) {
      report.ambiguous = byKey.ambiguous
      report.unmatched = byKey.unmatched
      return report
    }
    const linked = new Set(byKey.links.map((link) => link.cueId))
    const done = new Set(byKey.links.map((link) => link.row))
    for (const entry of byKey.ambiguous) keyAmbiguous.set(entry.row, entry)
    pendingRows = pendingRows.filter((row) => !done.has(row))
    pendingCues = cues.filter((cue) => !linked.has(cue.id))
  }
  const column = columns.text as number
  const byText = matchRowsByText(pendingCues, pendingRows.map((row) => rows[row]), column)
  for (const m of byText.matched) {
    report.links.push({ row: pendingRows[m.index], cueId: m.cueId, key: m.key, confidence: m.score, reason: `text similarity ${m.score}` })
  }
  report.ambiguous.push(...byText.ambiguous.map((a) => ({ row: pendingRows[a.index], candidates: a.candidates })))
  for (const row of byText.unmatched.map((i) => pendingRows[i])) {
    const ambiguous = keyAmbiguous.get(row)
    if (ambiguous) report.ambiguous.push(ambiguous)
    else report.unmatched.push(row)
  }
  const textLinked = new Set(byText.matched.map((m) => m.cueId))
  report.needsTranscribe = pendingCues.filter((cue) => !textLinked.has(cue.id) && !normalizeText(cue.sourceText)).map((cue) => cue.key)
  report.links.sort((a, b) => a.row - b.row)
  report.ambiguous.sort((a, b) => a.row - b.row)
  report.unmatched.sort((a, b) => a - b)
  return report
}

export interface RowColumns {
  key?: number
  text?: number
  translation?: number
  character?: number
  start?: number
  end?: number
}

export type ColumnRef = string | number
export type RowMapping = Partial<Record<keyof RowColumns, ColumnRef>>

export function rowColumns(kind: AssetKind, columns: string[], mapping?: RowMapping): RowColumns {
  if (mapping && Object.keys(mapping).length > 0) {
    const out: RowColumns = {}
    for (const [field, ref] of Object.entries(mapping) as [keyof RowColumns, ColumnRef][]) out[field] = resolveColumn(columns, ref)
    return out
  }
  if (kind === 'subtitles') {
    const at = (name: string): number => SUBTITLE_COLUMNS.indexOf(name)
    return { text: at('text'), character: at('speaker'), start: at('start'), end: at('end') }
  }
  if (columns.length === 1) return { text: 0 }
  const detected = detectMapping(columns)
  return {
    ...(detected.id === undefined ? {} : { key: detected.id }),
    ...(detected.text === undefined ? {} : { text: detected.text }),
    ...(detected.translation === undefined ? {} : { translation: detected.translation }),
    ...(detected.character === undefined ? {} : { character: detected.character }),
  }
}

const cell = (cells: string[], column: number | undefined): string => (column === undefined ? '' : (cells[column] ?? '').trim())

function speakerIds(project: Pick<Project, 'characters'>, names: string[]): { created: Character[]; ids: Map<string, string> } {
  const created = speakerCharacters(project.characters, names)
  const ids = new Map([...project.characters, ...created].map((c) => [c.name.trim().toLowerCase(), c.id]))
  return { created, ids }
}

const speakerReason = (asset: Pick<ProjectAsset, 'name'>): string => `speaker in ${asset.name}`

export interface LinkPlan {
  fields: FieldStep[]
  addCharacters: Character[]
  proposals: ProposalItem[]
  skipped: { row: number; reason: string }[]
}

export function linkPlan(
  project: Pick<Project, 'cues' | 'characters'>,
  links: Link[],
  rows: string[][],
  columns: RowColumns,
  asset: Pick<ProjectAsset, 'id' | 'name'>
): LinkPlan {
  const byId = new Map(project.cues.map((cue) => [cue.id, cue]))
  const oversized = (link: Link): boolean => textTooLong(cell(rows[link.row], columns.text), cell(rows[link.row], columns.translation))
  const kept = links.filter((link) => !oversized(link))
  const { created, ids } = speakerIds(project, kept.map((link) => cell(rows[link.row], columns.character)))
  const plan: LinkPlan = {
    fields: [],
    addCharacters: created,
    proposals: [],
    skipped: links.filter(oversized).map((link) => ({ row: link.row, reason: TEXT_TOO_LONG })),
  }
  for (const link of kept) {
    const cue = byId.get(link.cueId)
    if (!cue) continue
    const cells = rows[link.row]
    const text = cell(cells, columns.text)
    const translation = cell(cells, columns.translation)
    const pending = cue.suggestedText ?? null
    const from: FieldStep['from'] = {}
    const to: FieldStep['to'] = {}
    if (text && text !== cue.sourceText) {
      from.sourceText = cue.sourceText
      to.sourceText = text
    }
    if (translation && translation !== cue.text && translation !== pending) {
      from.suggestedText = pending
      to.suggestedText = translation
    }
    if (Object.keys(to).length > 0) plan.fields.push({ cueId: cue.id, from, to })
    const speaker = cell(cells, columns.character)
    const characterId = speaker ? ids.get(speaker.toLowerCase()) : undefined
    plan.proposals.push({
      cueId: cue.id,
      link: { assetId: asset.id, row: link.row, confidence: link.confidence, reason: link.reason },
      ...(characterId && characterId !== cue.characterId
        ? { character: { characterId, confidence: SPEAKER_CONFIDENCE, reason: speakerReason(asset) } }
        : {}),
    })
  }
  return plan
}

export interface RowLinesSummary {
  created: number
  updated: number
  unchanged: number
  skipped: number
  alreadyBuilt: number
  characterProposals: number
}

export function buildRowLines(
  project: Pick<Project, 'cues' | 'characters' | 'linesFromTable'>,
  rows: string[][],
  columns: RowColumns,
  asset: Pick<ProjectAsset, 'id' | 'name'>
): { summary: RowLinesSummary; changes: ChangeSet | null } {
  const built = new Set(project.cues.flatMap((cue) => (cue.origins ?? []).filter((o) => o.assetId === asset.id).map((o) => o.row)))
  const builtKeys = new Set(rows.filter((_, row) => built.has(row)).map((cells) => cell(cells, columns.key)).filter(Boolean))
  const pending = rows.map((cells, row) => ({ cells, row })).filter(({ cells, row }) => !built.has(row) && !builtKeys.has(cell(cells, columns.key)))
  const mapping: TableMapping = {
    ...(columns.key === undefined ? {} : { id: columns.key }),
    ...(columns.text === undefined ? {} : { text: columns.text }),
    ...(columns.translation === undefined ? {} : { translation: columns.translation }),
  }
  const committed = commitTable(project, pending.map((p) => p.cells), { mapping, rule: 'id', replaceTranslations: false, keepOriginal: false })
  const byId = new Map(project.cues.map((cue) => [cue.id, cue]))
  const touched = new Set((committed.changes?.cues ?? []).map((cue) => cue.id))
  const { created, ids } = speakerIds(project, pending.map((p) => cell(p.cells, columns.character)))
  project.characters.push(...created)
  let characterProposals = 0
  for (const { row: at, cueId } of committed.rows) {
    const cue = byId.get(cueId)
    if (!cue) continue
    const { cells, row } = pending[at]
    cue.origins = withOrigin(cue.origins, { assetId: asset.id, row })
    const start = cell(cells, columns.start)
    const end = cell(cells, columns.end)
    if (start) cue.fields = { ...cue.fields, [START_FIELD]: start }
    if (end) cue.fields = { ...cue.fields, [END_FIELD]: end }
    const speaker = cell(cells, columns.character)
    const characterId = speaker ? ids.get(speaker.toLowerCase()) : undefined
    if (characterId && characterId !== cue.characterId) {
      cue.proposals = { ...cue.proposals, character: { characterId, confidence: SPEAKER_CONFIDENCE, reason: speakerReason(asset) } }
      characterProposals++
    }
    touched.add(cue.id)
  }
  const summary: RowLinesSummary = {
    created: committed.summary.added,
    updated: committed.summary.updated + committed.summary.suggested,
    unchanged: committed.summary.unchanged,
    skipped: committed.summary.skipped,
    alreadyBuilt: rows.length - pending.length,
    characterProposals,
  }
  if (touched.size === 0 && created.length === 0) return { summary, changes: null }
  return {
    summary,
    changes: {
      cues: structuredClone([...touched].map((id) => byId.get(id) as Cue)),
      ...(created.length > 0 || committed.changes?.characters ? { characters: structuredClone(project.characters), charactersReplace: true } : {}),
      ...(project.linesFromTable ? { linesFromTable: true as const } : {}),
    },
  }
}

export interface AssetLinkCount {
  lines: number
  proposed: number
}

export function assetLinks(cues: Pick<Cue, 'origins' | 'proposals'>[]): Map<string, AssetLinkCount> {
  const counts = new Map<string, AssetLinkCount>()
  const bump = (id: string, key: keyof AssetLinkCount): void => {
    const row = counts.get(id) ?? { lines: 0, proposed: 0 }
    row[key]++
    counts.set(id, row)
  }
  for (const cue of cues) {
    for (const origin of cue.origins ?? []) bump(origin.assetId, 'lines')
    if (cue.proposals?.link) bump(cue.proposals.link.assetId, 'proposed')
  }
  return counts
}

export const isUnlinked = (links: AssetLinkCount | undefined): boolean => (links?.lines ?? 0) === 0

const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? word : `${word}s`}`

export function linkLabel(links: AssetLinkCount | undefined): string {
  const parts = [
    ...(links && links.lines > 0 ? [plural(links.lines, 'line')] : []),
    ...(links && links.proposed > 0 ? [`${links.proposed.toLocaleString('en-US')} proposed`] : []),
  ]
  return parts.length > 0 ? parts.join(' · ') : 'Unlinked'
}

export function unlinkedAssets<T extends Pick<ProjectAsset, 'id'>>(assets: T[], links: Map<string, AssetLinkCount>): T[] {
  return assets.filter((asset) => isUnlinked(links.get(asset.id)))
}

export function looseAudioCues<T extends Pick<Cue, 'origins'>>(cues: T[], assets: Pick<ProjectAsset, 'id' | 'kind'>[] = []): T[] {
  const media = new Set(assets.filter((asset) => inPlaceKind(asset.kind)).map((asset) => asset.id))
  if (media.size === 0) return cues
  return cues.filter((cue) => !cue.origins?.some((origin) => media.has(origin.assetId)))
}

export const LINE_PROPOSAL_KINDS = ['character', 'link'] as const

export function proposalRefs(cues: Pick<Cue, 'id' | 'proposals'>[]): ProposalRef[] {
  return cues.flatMap((cue) => LINE_PROPOSAL_KINDS.filter((kind) => cue.proposals?.[kind]).map((kind) => ({ cueId: cue.id, kind })))
}

export type ProposalListKind = ProposalKind | 'term'

export interface ProposalEntry {
  kind: ProposalListKind
  cue?: Cue
  term?: Term
  confidence?: number
  reason?: string
}

export function listProposals(project: Pick<Project, 'cues' | 'terms'>, kind?: ProposalListKind, minConfidence?: number): ProposalEntry[] {
  const out: ProposalEntry[] = []
  const wanted = (k: ProposalListKind, confidence?: number): boolean =>
    (kind === undefined || kind === k) && (minConfidence === undefined || (confidence !== undefined && confidence >= minConfidence))
  for (const cue of project.cues) {
    const { character, link } = cue.proposals ?? {}
    if (character && wanted('character', character.confidence)) out.push({ kind: 'character', cue, confidence: character.confidence, reason: character.reason })
    if (link && wanted('link', link.confidence)) out.push({ kind: 'link', cue, confidence: link.confidence, reason: link.reason })
    if (cue.suggestedText !== undefined && wanted('text')) out.push({ kind: 'text', cue })
  }
  for (const term of project.terms ?? []) if (term.proposed && wanted('term')) out.push({ kind: 'term', term })
  return out
}
