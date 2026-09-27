import { promises as fs } from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type { Project, ProjectAsset } from '@shared/domain'
import { DEFAULT_MATCH_RULE } from '@shared/import-table'
import type { ChangeSet } from '@shared/project-commands'
import {
  assetKind,
  extensionOf,
  inPlaceKind,
  jsonRecords,
  parseSubtitles,
  subtitleTable,
  textLines,
  textTable,
  type AssetTable,
  type AssetText,
} from '@shared/asset-readers'
import type { AssetAddResult, AssetPage, AudioImportResult } from '@shared/ipc'
import { collectFiles, importPickedAudio, pickedAudio, probeDuration, type PickedAudio } from './audio-import'
import { readTable } from './table-import'

const ASSET_COPY_MAX_BYTES = 64 * 1024 * 1024
const RAW_READ_MAX_BYTES = 8 * 1024 * 1024

export interface AssetReadOptions {
  jsonPath?: string
  fields?: string[]
}

export type AssetContent = AssetTable | AssetText | { format: 'audio' | 'video'; duration: number | null }

export const isTable = (content: AssetContent): content is AssetTable => 'columns' in content

const sameFile = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

const displayName = (rel: string): string => rel.replace(/\\/g, '/')

const baseName = (name: string): string => name.slice(name.lastIndexOf('/') + 1).toLowerCase()

async function contentHash(file: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await fs.readFile(file)).digest('hex')
  } catch {
    return null
  }
}

async function copyUnique(src: string, dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const ext = path.extname(src)
  const base = path.basename(src, ext)
  for (let n = 1; ; n++) {
    const target = path.join(dir, n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`)
    try {
      await fs.copyFile(src, target, fs.constants.COPYFILE_EXCL)
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

async function rowCount(asset: ProjectAsset): Promise<number | undefined> {
  if (asset.kind !== 'table' && asset.kind !== 'subtitles' && asset.kind !== 'text') return undefined
  try {
    const content = await loadAsset(asset, {})
    return isTable(content) ? content.rows.length : undefined
  } catch {
    return undefined
  }
}

export async function addAssets(
  existing: ProjectAsset[],
  projectDir: string,
  paths: string[],
  skipMedia = false
): Promise<AssetAddResult> {
  const files = await collectFiles(
    paths,
    (abs) => !path.basename(abs).startsWith('.') && !(skipMedia && inPlaceKind(assetKind(abs)))
  )
  const known = [...existing]
  const added: ProjectAsset[] = []
  const skipped: AssetAddResult['skipped'] = []
  const hashes = new Map<string, Promise<string | null>>()
  const hashOf = (file: string): Promise<string | null> => {
    const hit = hashes.get(file) ?? contentHash(file)
    hashes.set(file, hit)
    return hit
  }
  const sameContent = async (asset: ProjectAsset, src: string, size: number): Promise<boolean> => {
    if (asset.size !== size) return false
    const [a, b] = await Promise.all([hashOf(asset.file.relPath), hashOf(src)])
    return a !== null && a === b
  }
  for (const file of files) {
    const name = displayName(file.rel)
    const kind = assetKind(name)
    const stat = await fs.stat(file.src).catch(() => null)
    if (!stat?.isFile()) {
      skipped.push({ name, reason: 'not readable' })
      continue
    }
    let duplicate = false
    for (const asset of known) {
      duplicate = inPlaceKind(kind)
        ? sameFile(asset.file.relPath, file.src)
        : baseName(asset.name) === baseName(name) && (await sameContent(asset, file.src, stat.size))
      if (duplicate) break
    }
    if (duplicate) {
      skipped.push({ name, reason: 'already in the bin' })
      continue
    }
    if (!inPlaceKind(kind) && stat.size > ASSET_COPY_MAX_BYTES) {
      skipped.push({ name, reason: `larger than ${ASSET_COPY_MAX_BYTES / 1024 / 1024} MB` })
      continue
    }
    const stored = inPlaceKind(kind) ? file.src : await copyUnique(file.src, path.join(projectDir, 'assets'))
    const asset: ProjectAsset = {
      id: randomUUID(),
      name,
      kind,
      file: { fileId: path.basename(stored), relPath: stored },
      size: stat.size,
      addedAt: new Date().toISOString(),
    }
    const duration = inPlaceKind(kind) ? await probeDuration(stored) : undefined
    if (duration !== undefined && duration > 0) asset.duration = duration
    const rows = await rowCount(asset)
    if (rows !== undefined) asset.rows = rows
    known.push(asset)
    added.push(asset)
  }
  return { added, skipped }
}

async function readText(file: string, cap: number): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.min(size, cap))
    await handle.read(buffer, 0, buffer.length, 0)
    return buffer.toString('utf-8')
  } finally {
    await handle.close()
  }
}

export async function loadAsset(asset: ProjectAsset, options: AssetReadOptions): Promise<AssetContent> {
  const file = asset.file.relPath
  const ext = extensionOf(asset.name)
  if (asset.kind === 'audio' || asset.kind === 'video') return { format: asset.kind, duration: asset.duration ?? null }
  if (asset.kind === 'table') {
    const table = await readTable(file)
    return { format: ext, columns: table.headers, rows: table.rows }
  }
  if (asset.kind === 'subtitles') return subtitleTable(ext, parseSubtitles(await readText(file, ASSET_COPY_MAX_BYTES)))
  if (asset.kind === 'text') return textTable(asset.name, await readText(file, ASSET_COPY_MAX_BYTES))
  const raw = await readText(file, asset.kind === 'data' ? ASSET_COPY_MAX_BYTES : RAW_READ_MAX_BYTES)
  if (ext !== 'json') {
    if (options.jsonPath !== undefined) throw new Error(`jsonPath only applies to JSON assets; ${asset.name} is read as text.`)
    return { format: ext || 'raw', lines: textLines(raw) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (error) {
    if (options.jsonPath !== undefined) throw new Error(`${asset.name} is not valid JSON: ${(error as Error).message}.`)
    return { format: 'json (invalid, read as text)', lines: textLines(raw) }
  }
  if (options.jsonPath !== undefined) return jsonRecords(parsed, options.jsonPath, options.fields)
  return { format: 'json', lines: JSON.stringify(parsed, null, 2).split('\n') }
}

const PAGE_CELL_MAX = 1000

export function assetPage(content: AssetContent, from: number, count: number): AssetPage {
  if ('duration' in content) return { format: content.format, total: 0, columns: [], rows: [] }
  const rows = isTable(content) ? content.rows : content.lines.map((line) => [line])
  return {
    format: content.format,
    total: rows.length,
    columns: isTable(content) ? content.columns : [],
    rows: rows.slice(from, from + count).map((cells) => cells.map((cell) => cell.slice(0, PAGE_CELL_MAX))),
  }
}

export interface AudioLinesResult extends AudioImportResult {
  skipped: { asset: string; reason: string }[]
}

export async function assetAudioLines(
  project: Project,
  projectDir: string,
  assetIds: string[]
): Promise<{ result: AudioLinesResult; changes: ChangeSet }> {
  const files: PickedAudio[] = []
  const skipped: AudioLinesResult['skipped'] = []
  for (const id of new Set(assetIds)) {
    const asset = project.assets?.find((a) => a.id === id)
    if (!asset || asset.kind !== 'audio') {
      skipped.push({ asset: asset?.name ?? id, reason: asset ? `a ${asset.kind} asset, not audio` : 'not in the bin' })
      continue
    }
    const parts = asset.name.split('/')
    const picked = pickedAudio({ src: asset.file.relPath, rel: asset.name, dir: parts.slice(1, -1).join('/') })
    if (picked) files.push({ ...picked, assetId: asset.id })
    else skipped.push({ asset: asset.name, reason: 'not an audio file' })
  }
  const { result, changes } = await importPickedAudio(project, projectDir, files, DEFAULT_MATCH_RULE)
  const { failed = [], ...imported } = result
  return { result: { ...imported, skipped: [...skipped, ...failed.map(({ name, reason }) => ({ asset: name, reason }))] }, changes }
}
