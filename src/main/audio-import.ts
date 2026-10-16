import { createReadStream, promises as fs } from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { attachesOnly, matchAudioFiles, type MatchRule } from '@shared/import-table'
import { safeRelPath, withOrigin, type AudioRef, type Cue, type Project } from '@shared/domain'
import { PATH_FIELD } from '@shared/export-plan'
import type { CommandResult } from '@shared/project-commands'
import { pendingTakeDurations, type TakeDurationEntry } from '@shared/library'
import type { AudioImportResult } from '@shared/ipc'
import { isInsideDir } from '@shared/project-summary'
import { takeFileKind } from '@shared/take-import'
import { MAX_PICKED_FILES } from '@shared/asset-readers'
import { probeMedia, transcodeToWav } from './ffmpeg'
import { linkNew } from './project-store'
import type { SerialProjectRepository } from './project-repository'

const CONCURRENCY = 8

export async function probeDuration(file: string): Promise<number | undefined> {
  try {
    return (await probeMedia(file)).duration
  } catch {
    return undefined
  }
}

async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))))
  }
  return out
}

export async function probeTakeDurations(project: Project): Promise<TakeDurationEntry[]> {
  const pending = pendingTakeDurations(project)
  if (pending.length === 0) return []
  const probed = await mapLimited(pending, async (item) => ({
    cueId: item.cueId,
    takeId: item.takeId,
    duration: await probeDuration(item.file),
  }))
  return probed.filter((row): row is TakeDurationEntry => (row.duration ?? 0) > 0)
}

export interface PickedFile {
  src: string
  rel: string
  dir: string
}

export interface PickedAudio extends PickedFile {
  name: string
  format: AudioRef['format']
  assetId?: string
}

export interface CollectedFiles {
  files: PickedFile[]
  truncated: number
}

async function walk(dir: string, root: string, out: CollectedFiles, accept: (abs: string) => boolean): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(abs, root, out, accept)
      continue
    }
    if (!entry.isFile()) continue
    push(out, abs, path.join(path.basename(root), path.relative(root, abs)), accept, path.relative(root, dir))
  }
}

function push(out: CollectedFiles, abs: string, rel: string, accept: (abs: string) => boolean, dir = ''): void {
  if (!accept(abs)) return
  if (out.files.length >= MAX_PICKED_FILES) out.truncated++
  else out.files.push({ rel: rel.replace(/\\/g, '/'), dir: dir.replace(/\\/g, '/'), src: abs })
}

export async function collectFiles(paths: string[], accept: (abs: string) => boolean): Promise<CollectedFiles> {
  const out: CollectedFiles = { files: [], truncated: 0 }
  for (const target of paths) {
    const stat = await fs.stat(target).catch(() => null)
    if (!stat) continue
    if (stat.isDirectory()) await walk(target, target, out, accept)
    else push(out, target, path.basename(target), accept)
  }
  return out
}

export function audioFormat(file: string): AudioRef['format'] | undefined {
  const kind = takeFileKind(file)
  if (kind === 'transcode') return 'wav'
  return kind === 'keep' ? (path.extname(file).slice(1).toLowerCase() as AudioRef['format']) : undefined
}

const referenceRel = (file: PickedAudio): string =>
  takeFileKind(file.src) === 'transcode' ? `${file.rel.slice(0, file.rel.length - path.extname(file.rel).length)}.wav` : file.rel

export function pickedAudio(file: PickedFile): PickedAudio | null {
  const format = audioFormat(file.src)
  return format ? { ...file, name: path.basename(file.src, path.extname(file.src)), format } : null
}

export async function collectAudio(paths: string[]): Promise<{ files: PickedAudio[]; truncated: number }> {
  const { files, truncated } = await collectFiles(paths, (abs) => audioFormat(abs) !== undefined)
  return { files: files.flatMap((file) => pickedAudio(file) ?? []), truncated }
}

function buildCue(file: PickedAudio, abs: string, duration: number | undefined): Cue {
  const cue: Cue = {
    id: randomUUID(),
    characterId: '',
    key: file.name,
    fields: { EventName: file.name, ...(file.dir ? { [PATH_FIELD]: file.dir } : {}) },
    sourceText: '',
    text: '',
    status: 'empty',
    notes: '',
    takes: [],
    referenceAudio: { fileId: file.name, relPath: abs, format: file.format },
  }
  if (duration !== undefined) cue.referenceDuration = duration
  if (file.assetId) cue.origins = [{ assetId: file.assetId }]
  return cue
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function keepReference(part: string, abs: string, current = abs): Promise<string> {
  try {
    await linkNew(part, abs)
    return abs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const size = (await fs.stat(part)).size
  let digest: string | undefined
  for (const existing of new Set([abs, current])) {
    if ((await fs.stat(existing).catch(() => null))?.size !== size) continue
    if ((await fileDigest(existing).catch(() => '')) === (digest ??= await fileDigest(part))) return existing
  }
  const ext = path.extname(abs)
  const revision = `${abs.slice(0, abs.length - ext.length)}_${randomUUID().slice(0, 8)}${ext}`
  await linkNew(part, revision)
  return revision
}

export interface AudioImported {
  result: AudioImportResult
  published: CommandResult | null
}

export async function importAudio(
  repository: SerialProjectRepository,
  projectDir: string,
  paths: string[],
  rule: MatchRule
): Promise<AudioImported> {
  const { files, truncated } = await collectAudio(paths)
  const imported = await importPickedAudio(repository, projectDir, files, rule)
  return truncated > 0 ? { ...imported, result: { ...imported.result, truncated } } : imported
}

export async function importPickedAudio(
  repository: SerialProjectRepository,
  projectDir: string,
  files: PickedAudio[],
  rule: MatchRule
): Promise<AudioImported> {
  const project = repository.projectForMain()
  const referenceRoot = path.join(projectDir, 'audio', 'reference')
  const failed: NonNullable<AudioImportResult['failed']> = []
  const contained = files.filter((file) => {
    const inside = safeRelPath(file.rel) === file.rel && isInsideDir(path.resolve(referenceRoot, referenceRel(file)), referenceRoot)
    if (!inside) failed.push({ name: file.rel, reason: 'unsafe file name' })
    return inside
  })
  const { update, create, duplicates } = matchAudioFiles(project.cues, contained, rule)
  const attach = attachesOnly(project)
  const kept = [...update.map(({ file }) => file), ...(attach ? [] : create)]
  const currentReference = new Map(update.map(({ cue, file }) => [file, cue.referenceAudio?.relPath]))

  for (const dir of new Set(kept.map((f) => path.dirname(path.join(referenceRoot, referenceRel(f)))))) {
    await fs.mkdir(dir, { recursive: true })
  }

  const probed = await mapLimited(kept, async (file) => {
    let abs = path.join(referenceRoot, referenceRel(file))
    const transcode = takeFileKind(file.src) === 'transcode'
    if (transcode || path.resolve(abs).toLowerCase() !== path.resolve(file.src).toLowerCase()) {
      const part = path.join(path.dirname(abs), `.part-${randomUUID()}-${path.basename(abs)}`)
      try {
        await (transcode ? transcodeToWav(file.src, part) : fs.copyFile(file.src, part))
        abs = await keepReference(part, abs, currentReference.get(file))
      } catch {
        failed.push({ name: file.rel, reason: transcode ? 'could not be converted to wav' : 'could not be read' })
        return null
      } finally {
        await fs.rm(part, { force: true }).catch(() => undefined)
      }
    }
    return { file, abs, duration: await probeDuration(abs) }
  })
  const byFile = new Map(probed.flatMap((row) => (row ? [[row.file, row] as const] : [])))

  const changed: Cue[] = []
  const added: Cue[] = []
  const published = await repository.mutate((current) => {
    for (const { cue: matched, file } of update) {
      const row = byFile.get(file)
      const cue = row && current.cues.find((c) => c.id === matched.id)
      if (!row || !cue) continue
      cue.referenceAudio = { fileId: cue.key, relPath: row.abs, format: file.format }
      if (row.duration !== undefined) cue.referenceDuration = row.duration
      if (file.assetId) cue.origins = withOrigin(cue.origins, { assetId: file.assetId })
      if (!attach && file.rel.includes('/') && (cue.fields[PATH_FIELD] ?? '') !== file.dir) {
        const { [PATH_FIELD]: _moved, ...fields } = cue.fields
        cue.fields = file.dir ? { ...fields, [PATH_FIELD]: file.dir } : fields
      }
      changed.push(cue)
    }
    for (const file of attach ? [] : create) {
      const row = byFile.get(file)
      if (!row) continue
      const cue = buildCue(file, row.abs, row.duration)
      current.cues.push(cue)
      added.push(cue)
    }
    return { cues: [...changed, ...added] }
  })

  return {
    result: {
      added: added.length,
      updated: changed.length,
      files: files.length,
      ...(attach ? { unmatched: create.length } : {}),
      ...(duplicates.length > 0 ? { duplicates: duplicates.map((file) => file.rel) } : {}),
      ...(failed.length > 0 ? { failed } : {}),
    },
    published,
  }
}
