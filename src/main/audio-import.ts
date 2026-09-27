import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { attachesOnly, matchAudioFiles, type MatchRule } from '@shared/import-table'
import { safeRelPath, withOrigin, type AudioRef, type Cue, type Project } from '@shared/domain'
import { PATH_FIELD } from '@shared/export-plan'
import type { ChangeSet } from '@shared/project-commands'
import { pendingTakeDurations, type TakeDurationEntry } from '@shared/library'
import type { AudioImportResult } from '@shared/ipc'
import { isInsideDir } from '@shared/project-summary'
import { takeFileKind } from '@shared/take-import'
import { probeMedia, transcodeToWav } from './ffmpeg'

const CONCURRENCY = 8
const MAX_FILES = 20_000

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

async function walk(dir: string, root: string, out: PickedFile[], accept: (abs: string) => boolean): Promise<void> {
  if (out.length >= MAX_FILES) return
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

function push(out: PickedFile[], abs: string, rel: string, accept: (abs: string) => boolean, dir = ''): void {
  if (!accept(abs) || out.length >= MAX_FILES) return
  out.push({ rel: rel.replace(/\\/g, '/'), dir: dir.replace(/\\/g, '/'), src: abs })
}

export async function collectFiles(paths: string[], accept: (abs: string) => boolean): Promise<PickedFile[]> {
  const out: PickedFile[] = []
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

export async function collectAudio(paths: string[]): Promise<PickedAudio[]> {
  return (await collectFiles(paths, (abs) => audioFormat(abs) !== undefined)).flatMap((file) => pickedAudio(file) ?? [])
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

export async function importAudio(
  project: Project,
  projectDir: string,
  paths: string[],
  rule: MatchRule
): Promise<{ result: AudioImportResult; changes: ChangeSet }> {
  return importPickedAudio(project, projectDir, await collectAudio(paths), rule)
}

export async function importPickedAudio(
  project: Project,
  projectDir: string,
  files: PickedAudio[],
  rule: MatchRule
): Promise<{ result: AudioImportResult; changes: ChangeSet }> {
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

  for (const dir of new Set(kept.map((f) => path.dirname(path.join(referenceRoot, referenceRel(f)))))) {
    await fs.mkdir(dir, { recursive: true })
  }

  const probed = await mapLimited(kept, async (file) => {
    const abs = path.join(referenceRoot, referenceRel(file))
    if (takeFileKind(file.src) === 'transcode') {
      const part = path.join(path.dirname(abs), `.part-${randomUUID()}-${path.basename(abs)}`)
      try {
        await transcodeToWav(file.src, part)
        await fs.rename(part, abs)
      } catch {
        await fs.rm(part, { force: true }).catch(() => undefined)
        failed.push({ name: file.rel, reason: 'could not be converted to wav' })
        return null
      }
    } else if (path.resolve(abs).toLowerCase() !== path.resolve(file.src).toLowerCase()) {
      await fs.copyFile(file.src, abs)
    }
    return { file, abs, duration: await probeDuration(abs) }
  })
  const byFile = new Map(probed.flatMap((row) => (row ? [[row.file, row] as const] : [])))

  const changed: Cue[] = []
  for (const { cue, file } of update) {
    const row = byFile.get(file)
    if (!row) continue
    cue.referenceAudio = { fileId: cue.key, relPath: row.abs, format: file.format }
    if (row.duration !== undefined) cue.referenceDuration = row.duration
    if (file.assetId) cue.origins = withOrigin(cue.origins, { assetId: file.assetId })
    if (!attach && file.rel.includes('/') && (cue.fields[PATH_FIELD] ?? '') !== file.dir) {
      const { [PATH_FIELD]: _moved, ...fields } = cue.fields
      cue.fields = file.dir ? { ...fields, [PATH_FIELD]: file.dir } : fields
    }
    changed.push(cue)
  }
  const added: Cue[] = []
  for (const file of attach ? [] : create) {
    const row = byFile.get(file)
    if (!row) continue
    const cue = buildCue(file, row.abs, row.duration)
    project.cues.push(cue)
    added.push(cue)
  }

  return {
    result: {
      added: added.length,
      updated: changed.length,
      files: files.length,
      ...(attach ? { unmatched: create.length } : {}),
      ...(duplicates.length > 0 ? { duplicates: duplicates.map((file) => file.rel) } : {}),
      ...(failed.length > 0 ? { failed } : {}),
    },
    changes: { cues: structuredClone([...changed, ...added]) },
  }
}
