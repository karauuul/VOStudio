import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseCsv, serializeCell } from '../src/shared/csv.ts'

export const TEMPLATE_SUFFIX = '.vostudio-src'
export const INDEX_HEADER = [
  'cueId',
  'character',
  'sourceText',
  'translation',
  'refAudio',
  'exportName',
  'status',
  'durationHint',
  'note',
  'EventName',
]
const TERMS_HEADER = ['term', 'translation', 'note']

const COLUMNS = {
  cueId: 'WemId',
  eventName: 'EventName',
  sourceText: 'Transcript',
  translation: 'UkrText',
  status: 'Status',
  duration: 'AudioDuration',
  note: 'Notes',
}
const EXCLUDED_STATUS = 'no_match'

export interface ConvertOptions {
  csv: string
  audio: string
  out: string
  sourceLang?: string
  targetLang?: string
}

export interface ConvertResult {
  out: string
  name: string
  cues: number
  withAudio: number
  missingAudio: number
  skipped: number
}

export function characterFromEventName(eventName: string): string {
  if (eventName.includes('ADA')) return 'ADA'
  if (/Alien|SamOre|Whisper/i.test(eventName)) return 'Alien'
  return 'ADA'
}

export async function buildReferenceIndex(audioDir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  let entries: string[]
  try {
    entries = await fs.readdir(audioDir)
  } catch {
    return index
  }
  for (const entry of entries) {
    const match = /__(\d+)\.(wav|mp3|ogg)$/i.exec(entry)
    if (match) index.set(match[1], entry)
  }
  return index
}

const csvLine = (cells: string[]): string => cells.map(serializeCell).join(',')

export async function convert(options: ConvertOptions): Promise<ConvertResult> {
  const outDir = path.resolve(options.out)
  const folder = path.basename(outDir)
  if (!folder.toLowerCase().endsWith(TEMPLATE_SUFFIX)) {
    throw new Error(`--out must end with a folder named <name>${TEMPLATE_SUFFIX}`)
  }
  const name = folder.slice(0, -TEMPLATE_SUFFIX.length)
  if (!name) throw new Error(`--out must end with a folder named <name>${TEMPLATE_SUFFIX}`)

  const csv = parseCsv(await fs.readFile(path.resolve(options.csv), 'utf-8'))
  for (const column of Object.values(COLUMNS)) {
    if (!csv.headers.includes(column)) throw new Error(`Column ${column} is missing from ${options.csv}`)
  }
  const columnIndex = (column: string): number => csv.headers.indexOf(column)
  const references = await buildReferenceIndex(path.resolve(options.audio))

  const audioOut = path.join(outDir, 'audio')
  await fs.mkdir(audioOut, { recursive: true })

  const lines = [csvLine(INDEX_HEADER)]
  const seen = new Set<string>()
  let withAudio = 0
  let missingAudio = 0
  let skipped = 0

  for (const row of csv.rows) {
    const cell = (column: string): string => (row[columnIndex(column)] ?? '').trim()
    const cueId = cell(COLUMNS.cueId)
    const eventName = cell(COLUMNS.eventName)
    const sourceText = cell(COLUMNS.sourceText)
    if (!cueId || !eventName || !sourceText || seen.has(cueId)) {
      if (row.some((value) => value.trim() !== '')) skipped++
      continue
    }
    seen.add(cueId)

    const reference = references.get(cueId)
    if (reference) {
      await fs.copyFile(path.join(path.resolve(options.audio), reference), path.join(audioOut, reference))
      withAudio++
    } else {
      missingAudio++
    }

    lines.push(
      csvLine([
        cueId,
        characterFromEventName(eventName),
        sourceText,
        cell(COLUMNS.translation),
        reference ?? '',
        `${eventName}__${cueId}`,
        cell(COLUMNS.status) === EXCLUDED_STATUS ? 'excluded' : '',
        cell(COLUMNS.duration),
        cell(COLUMNS.note),
        eventName,
      ])
    )
  }

  await fs.writeFile(
    path.join(outDir, 'project-meta.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        name,
        sourceLang: options.sourceLang ?? 'en',
        targetLang: options.targetLang ?? 'uk',
      },
      null,
      2
    ) + '\n'
  )
  await fs.writeFile(path.join(outDir, 'index.csv'), lines.join('\r\n') + '\r\n')
  await fs.writeFile(path.join(outDir, 'terms.csv'), csvLine(TERMS_HEADER) + '\r\n')

  return { out: outDir, name, cues: lines.length - 1, withAudio, missingAudio, skipped }
}

const USAGE = `Usage: node scripts/convert-satisfactory.ts --csv <master_vo_table.csv> --audio <original_audio dir> --out <name.vostudio-src> [--source-lang en] [--target-lang uk]`

function parseArgs(argv: string[]): ConvertOptions {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(USAGE)
    flags.set(argv[i].slice(2), argv[i + 1])
  }
  const csv = flags.get('csv')
  const audio = flags.get('audio')
  const out = flags.get('out')
  if (!csv || !audio || !out) throw new Error(USAGE)
  const options: ConvertOptions = { csv, audio, out }
  const sourceLang = flags.get('source-lang')
  const targetLang = flags.get('target-lang')
  if (sourceLang) options.sourceLang = sourceLang
  if (targetLang) options.targetLang = targetLang
  return options
}

async function main(): Promise<void> {
  const result = await convert(parseArgs(process.argv.slice(2)))
  console.log(
    `${result.out}\n  name: ${result.name}\n  cues: ${result.cues}\n  with reference audio: ${result.withAudio}\n  without reference audio: ${result.missingAudio}\n  skipped rows: ${result.skipped}`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(1)
  })
}
