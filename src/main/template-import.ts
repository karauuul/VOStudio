import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { parseCsv } from '@shared/csv'
import {
  CHARACTER_COLORS,
  DEFAULT_VOICE_SETTINGS,
  ELEVENLABS_STS_MODEL,
  ELEVENLABS_TTS_MODEL,
  sanitizeTerms,
  type AudioRef,
  type Character,
  type Cue,
  type Project,
  type Term,
} from '@shared/domain'
import type { TemplateIssue, TemplateMeta, TemplatePreview } from '@shared/ipc'
import { isSafeFileName, PROJECT_SUFFIX } from '@shared/project-summary'
import { projectNameSchema, templateMetaSchema } from './schemas'
import * as store from './project-store'

const REQUIRED_COLUMNS = ['cueId', 'character', 'sourceText', 'refAudio', 'exportName'] as const
const MAX_ID_LENGTH = 200
const REF_FORMATS: Record<string, AudioRef['format']> = {
  '.wav': 'wav',
  '.mp3': 'mp3',
  '.ogg': 'ogg',
}
const PREVIEW_ROWS = 10
const COPY_CONCURRENCY = 8

export interface TemplateRow {
  row: number
  cueId: string
  character: string
  sourceText: string
  translation: string
  refAudio: string
  refRel: string
  exportName: string
  status: string
  durationHint: string
  note: string
  fields: Record<string, string>
  refFormat?: AudioRef['format']
  missingAudio: boolean
}

export interface TemplateValidation {
  dir: string
  meta: TemplateMeta | null
  rows: TemplateRow[]
  terms: Term[] | undefined
  characters: string[]
  warnings: TemplateIssue[]
  fatalErrors: TemplateIssue[]
}

const readText = async (file: string): Promise<string | null> => {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
}

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false)

const realpath = (file: string): Promise<string | null> => fs.realpath(file).then((p) => p, () => null)

function isUnder(root: string, candidate: string): boolean {
  const a = path.resolve(root).toLowerCase()
  const b = path.resolve(candidate).toLowerCase()
  return b === a || b.startsWith(a + path.sep)
}

export function relUnderAudio(audioDir: string, refAudio: string): string | null {
  const cleaned = refAudio.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned) return null
  const root = path.resolve(audioDir)
  const abs = path.resolve(root, cleaned)
  if (!isUnder(root, abs)) return null
  const rel = path.relative(root, abs).replace(/\\/g, '/')
  return rel === '' ? null : rel
}

async function readMeta(dir: string, fatal: TemplateIssue[]): Promise<TemplateMeta | null> {
  const raw = await readText(path.join(dir, 'project-meta.json'))
  if (raw === null) {
    fatal.push({ row: null, reason: 'project-meta.json is missing' })
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fatal.push({ row: null, reason: 'project-meta.json is not valid JSON' })
    return null
  }
  const result = templateMetaSchema.safeParse(parsed)
  if (!result.success) {
    for (const issue of result.error.issues) {
      fatal.push({ row: null, reason: `project-meta.json: ${issue.path.join('.') || 'root'} — ${issue.message}` })
    }
    return null
  }
  const name = projectNameSchema.safeParse(result.data.name)
  if (!name.success) {
    fatal.push({ row: null, reason: `project-meta.json: name "${result.data.name}" is not a valid folder name` })
    return null
  }
  if (await exists(projectDirFor(name.data))) {
    fatal.push({ row: null, reason: `Project "${name.data}" already exists` })
  }
  return { ...result.data, name: name.data }
}

async function readTerms(dir: string, warnings: TemplateIssue[]): Promise<Term[] | undefined> {
  const raw = await readText(path.join(dir, 'terms.csv'))
  if (raw === null) {
    warnings.push({ row: null, reason: 'terms.csv is missing' })
    return undefined
  }
  let csv
  try {
    csv = parseCsv(raw)
  } catch (error) {
    warnings.push({ row: null, reason: `terms.csv is malformed (${String(error)})` })
    return undefined
  }
  const termI = csv.headers.indexOf('term')
  const translationI = csv.headers.indexOf('translation')
  if (termI < 0 || translationI < 0) {
    warnings.push({ row: null, reason: 'terms.csv has no term/translation columns' })
    return undefined
  }
  const noteI = csv.headers.indexOf('note')
  return sanitizeTerms(
    csv.rows.map((row) => ({
      term: row[termI] ?? '',
      translation: row[translationI] ?? '',
      note: noteI >= 0 ? (row[noteI] ?? '') : '',
    }))
  )
}

export async function validateTemplate(dir: string): Promise<TemplateValidation> {
  const warnings: TemplateIssue[] = []
  const fatalErrors: TemplateIssue[] = []
  const meta = await readMeta(dir, fatalErrors)
  const terms = await readTerms(dir, warnings)
  const audioDir = path.join(dir, 'audio')
  const audioRoot = await realpath(audioDir)
  const rows: TemplateRow[] = []
  const characters: string[] = []

  const raw = await readText(path.join(dir, 'index.csv'))
  if (raw === null) {
    fatalErrors.push({ row: null, reason: 'index.csv is missing' })
    return { dir, meta, rows, terms, characters, warnings, fatalErrors }
  }

  let csv
  try {
    csv = parseCsv(raw)
  } catch (error) {
    fatalErrors.push({ row: null, reason: `index.csv is malformed: ${String(error)}` })
    return { dir, meta, rows, terms, characters, warnings, fatalErrors }
  }

  const missingColumns = REQUIRED_COLUMNS.filter((c) => !csv.headers.includes(c))
  if (missingColumns.length > 0) {
    fatalErrors.push({ row: 1, reason: `index.csv is missing columns: ${missingColumns.join(', ')}` })
    return { dir, meta, rows, terms, characters, warnings, fatalErrors }
  }
  const numericColumns = csv.headers.filter((h) => /^\d+$/.test(h))
  if (numericColumns.length > 0) {
    fatalErrors.push({ row: 1, reason: `index.csv has numeric column names: ${numericColumns.join(', ')}` })
    return { dir, meta, rows, terms, characters, warnings, fatalErrors }
  }
  const duplicateColumns = csv.headers.filter((h, i) => csv.headers.indexOf(h) !== i)
  if (duplicateColumns.length > 0) {
    fatalErrors.push({ row: 1, reason: `index.csv has duplicate column names: ${duplicateColumns.join(', ')}` })
    return { dir, meta, rows, terms, characters, warnings, fatalErrors }
  }
  const reservedColumns = csv.headers.filter((h) => h in Object.prototype)
  if (reservedColumns.length > 0) {
    fatalErrors.push({ row: 1, reason: `index.csv has reserved column names: ${reservedColumns.join(', ')}` })
    return { dir, meta, rows, terms, characters, warnings, fatalErrors }
  }

  if (audioRoot === null) warnings.push({ row: null, reason: 'audio/ directory is missing' })

  const seenCueIds = new Map<string, number>()
  const seenExportNames = new Map<string, number>()

  for (let i = 0; i < csv.rows.length; i++) {
    const cells = csv.rows[i]
    if (cells.every((cell) => cell.trim() === '')) continue
    const row = i + 2
    if (cells.length !== csv.headers.length) {
      fatalErrors.push({
        row,
        reason: `row has ${cells.length} cells, header has ${csv.headers.length}`,
      })
      continue
    }
    const fields: Record<string, string> = {}
    csv.headers.forEach((header, index) => (fields[header] = cells[index] ?? ''))
    const value = (name: string): string => (fields[name] ?? '').trim()

    const cueId = value('cueId')
    const character = value('character')
    const sourceText = fields['sourceText'] ?? ''
    const translation = fields['translation'] ?? ''
    const refAudio = value('refAudio')
    const exportName = value('exportName')
    const status = value('status')
    const durationHint = value('durationHint')
    const note = fields['note'] ?? ''
    fields['exportName'] = exportName

    if (!cueId) fatalErrors.push({ row, reason: 'cueId is empty' })
    else if (cueId.length > MAX_ID_LENGTH) fatalErrors.push({ row, reason: `cueId is longer than ${MAX_ID_LENGTH}` })
    else if (seenCueIds.has(cueId)) {
      fatalErrors.push({ row, reason: `duplicate cueId "${cueId}" (first seen in row ${seenCueIds.get(cueId)})` })
    } else seenCueIds.set(cueId, row)

    if (!exportName) fatalErrors.push({ row, reason: 'exportName is empty' })
    else if (exportName.length > MAX_ID_LENGTH) {
      fatalErrors.push({ row, reason: `exportName is longer than ${MAX_ID_LENGTH}` })
    } else if (!isSafeFileName(exportName)) {
      fatalErrors.push({ row, reason: `exportName "${exportName}" is not a safe file name` })
    } else if (seenExportNames.has(exportName.toLowerCase())) {
      fatalErrors.push({
        row,
        reason: `duplicate exportName "${exportName}" (first seen in row ${seenExportNames.get(exportName.toLowerCase())})`,
      })
    } else seenExportNames.set(exportName.toLowerCase(), row)

    if (!sourceText.trim()) fatalErrors.push({ row, reason: 'sourceText is empty' })
    if (!character) warnings.push({ row, reason: 'character is empty' })

    if (status !== '' && status !== 'excluded') {
      fatalErrors.push({ row, reason: `status "${status}" is not allowed (empty or "excluded")` })
    }
    if (durationHint && !Number.isFinite(Number(durationHint))) {
      warnings.push({ row, reason: `durationHint "${durationHint}" is not a number` })
    }

    let refRel = ''
    let refFormat: AudioRef['format'] | undefined
    let missingAudio = false
    if (refAudio) {
      const rel = relUnderAudio(audioDir, refAudio)
      if (rel === null) {
        fatalErrors.push({ row, reason: `refAudio "${refAudio}" points outside audio/` })
      } else {
        refRel = rel
        refFormat = REF_FORMATS[path.extname(rel).toLowerCase()]
        if (!refFormat) {
          fatalErrors.push({ row, reason: `refAudio "${refAudio}" has an unsupported format (wav/mp3/ogg)` })
        } else if (audioRoot === null) {
          missingAudio = true
          warnings.push({ row, reason: `refAudio "${refAudio}" not found under audio/` })
        } else {
          const real = await realpath(path.join(audioRoot, rel))
          if (real === null) {
            missingAudio = true
            warnings.push({ row, reason: `refAudio "${refAudio}" not found under audio/` })
          } else if (!isUnder(audioRoot, real)) {
            fatalErrors.push({ row, reason: `refAudio "${refAudio}" resolves through a link outside audio/` })
          }
        }
      }
    }

    if (character && !characters.includes(character)) characters.push(character)
    rows.push({
      row,
      cueId,
      character,
      sourceText,
      translation,
      refAudio,
      refRel,
      exportName,
      status,
      durationHint,
      note,
      fields,
      refFormat,
      missingAudio,
    })
  }

  if (rows.length === 0 && fatalErrors.every((e) => e.row === null)) {
    fatalErrors.push({ row: null, reason: 'index.csv has no data rows' })
  }
  return { dir, meta, rows, terms, characters, warnings, fatalErrors }
}

export function toPreview(validation: TemplateValidation): TemplatePreview {
  return {
    dir: validation.dir,
    meta: validation.meta,
    firstRows: validation.rows.slice(0, PREVIEW_ROWS).map((r) => ({
      cueId: r.cueId,
      character: r.character,
      sourceText: r.sourceText,
      translation: r.translation,
      refAudio: r.refAudio,
      exportName: r.exportName,
      status: r.status,
      missingAudio: r.missingAudio,
    })),
    totalCues: validation.rows.length,
    characters: validation.characters,
    terms: validation.terms?.length ?? 0,
    warnings: validation.warnings,
    fatalErrors: validation.fatalErrors,
  }
}

function buildCharacters(names: string[]): Character[] {
  return names.map((name, index) => ({
    id: name,
    name,
    color: CHARACTER_COLORS[index % CHARACTER_COLORS.length],
    provider: {
      providerId: 'elevenlabs' as const,
      voiceId: '',
      ttsModel: ELEVENLABS_TTS_MODEL,
      stsModel: ELEVENLABS_STS_MODEL,
    },
    voiceSettings: { ...DEFAULT_VOICE_SETTINGS },
  }))
}

function buildCue(row: TemplateRow, referenceRoot: string): Cue {
  const duration = Number(row.durationHint)
  const notes = [row.missingAudio ? `Missing reference audio: ${row.refAudio}` : '', row.note]
    .filter(Boolean)
    .join('\n')
  const cue: Cue = {
    id: randomUUID(),
    characterId: row.character,
    key: row.cueId,
    fields: row.fields,
    sourceText: row.sourceText,
    text: row.translation,
    status: row.status === 'excluded' ? 'excluded' : row.translation.trim() ? 'translated' : 'empty',
    notes,
    takes: [],
  }
  if (row.refRel && row.refFormat && !row.missingAudio) {
    cue.referenceAudio = {
      fileId: row.cueId,
      relPath: path.join(referenceRoot, row.refRel),
      format: row.refFormat,
    }
  }
  if (row.durationHint && Number.isFinite(duration) && duration > 0) cue.referenceDuration = duration
  return cue
}

export function buildProjectBase(
  validation: TemplateValidation,
  referenceRoot: string
): Omit<Project, 'id' | 'schemaVersion' | 'createdAt'> {
  const base: Omit<Project, 'id' | 'schemaVersion' | 'createdAt'> = {
    name: validation.meta?.name ?? '',
    media: { referenceDir: referenceRoot, referencePattern: '' },
    characters: buildCharacters(validation.characters),
    cues: validation.rows.map((row) => buildCue(row, referenceRoot)),
    sessions: [],
    pronunciationRules: '',
    exportTemplate: '{exportName}.{ext}',
    ui: { filter: '', search: '' },
  }
  if (validation.terms) base.terms = validation.terms
  return base
}

async function copyReferenceAudio(validation: TemplateValidation, referenceRoot: string): Promise<void> {
  const audioDir = path.join(validation.dir, 'audio')
  const wanted = [
    ...new Set(
      validation.rows
        .filter((row) => row.refRel && row.refFormat && !row.missingAudio)
        .map((row) => row.refRel)
    ),
  ]
  for (const dir of new Set(wanted.map((rel) => path.dirname(path.join(referenceRoot, rel))))) {
    await fs.mkdir(dir, { recursive: true })
  }
  for (let i = 0; i < wanted.length; i += COPY_CONCURRENCY) {
    await Promise.all(
      wanted
        .slice(i, i + COPY_CONCURRENCY)
        .map((rel) => fs.copyFile(path.join(audioDir, rel), path.join(referenceRoot, rel)))
    )
  }
}

function projectDirFor(name: string): string {
  return path.join(store.defaultProjectsRoot(), `${name}${PROJECT_SUFFIX}`)
}

export async function createProjectFromTemplate(validation: TemplateValidation): Promise<Project> {
  if (validation.fatalErrors.length > 0 || !validation.meta) {
    throw new Error(`Template has ${validation.fatalErrors.length} fatal error(s) — import blocked`)
  }
  const name = projectNameSchema.parse(validation.meta.name)
  const projectDir = projectDirFor(name)
  if (await exists(projectDir)) throw new Error(`Project "${name}" already exists`)
  const previousProject = store.getProject()
  const previousDir = store.getProjectDir()
  const referenceRoot = path.join(projectDir, 'audio', 'reference')
  const project = await store.createProject(name, buildProjectBase(validation, referenceRoot))
  try {
    await copyReferenceAudio(validation, referenceRoot)
  } catch (error) {
    store.closeProject()
    try {
      await fs.rm(projectDir, { recursive: true, force: true })
    } catch (rmError) {
      throw new Error(
        `Import failed (${String(error)}); the partial project folder could not be removed: ${projectDir} (${String(rmError)})`
      )
    }
    if (previousProject && previousDir) store.adoptProject(previousProject, previousDir)
    throw error
  }
  return project
}
