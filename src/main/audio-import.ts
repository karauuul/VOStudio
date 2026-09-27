import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { attachesOnly, matchAudioFiles, type MatchRule } from '@shared/import-table'
import type { AudioRef, Cue, Project } from '@shared/domain'
import { PATH_FIELD } from '@shared/export-plan'
import type { ChangeSet } from '@shared/project-commands'
import { pendingTakeDurations, type TakeDurationEntry } from '@shared/library'
import type { AudioImportResult } from '@shared/ipc'
import { probeMedia } from './ffmpeg'

const FORMATS: Record<string, AudioRef['format']> = {
  '.wav': 'wav',
  '.mp3': 'mp3',
  '.ogg': 'ogg',
}

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

export interface PickedAudio {
  name: string
  rel: string
  dir: string
  src: string
  format: AudioRef['format']
}

async function walk(dir: string, root: string, out: PickedAudio[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(abs, root, out)
      continue
    }
    if (!entry.isFile()) continue
    push(out, abs, path.join(path.basename(root), path.relative(root, abs)), path.relative(root, dir))
  }
}

function push(out: PickedAudio[], abs: string, rel: string, dir = ''): void {
  const format = FORMATS[path.extname(abs).toLowerCase()]
  if (!format || out.length >= MAX_FILES) return
  out.push({
    name: path.basename(abs, path.extname(abs)),
    rel: rel.replace(/\\/g, '/'),
    dir: dir.replace(/\\/g, '/'),
    src: abs,
    format,
  })
}

export async function collectAudio(paths: string[]): Promise<PickedAudio[]> {
  const out: PickedAudio[] = []
  for (const target of paths) {
    const stat = await fs.stat(target).catch(() => null)
    if (!stat) continue
    if (stat.isDirectory()) await walk(target, target, out)
    else push(out, target, path.basename(target))
  }
  return out
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
  return cue
}

export async function importAudio(
  project: Project,
  projectDir: string,
  paths: string[],
  rule: MatchRule
): Promise<{ result: AudioImportResult; changes: ChangeSet }> {
  const files = await collectAudio(paths)
  const referenceRoot = path.join(projectDir, 'audio', 'reference')
  const { update, create, duplicates } = matchAudioFiles(project.cues, files, rule)
  const attach = attachesOnly(project)
  const kept = [...update.map(({ file }) => file), ...(attach ? [] : create)]

  for (const dir of new Set(kept.map((f) => path.dirname(path.join(referenceRoot, f.rel))))) {
    await fs.mkdir(dir, { recursive: true })
  }

  const probed = await mapLimited(kept, async (file) => {
    const abs = path.join(referenceRoot, file.rel)
    if (path.resolve(abs).toLowerCase() !== path.resolve(file.src).toLowerCase()) {
      await fs.copyFile(file.src, abs)
    }
    return { file, abs, duration: await probeDuration(abs) }
  })
  const byFile = new Map(probed.map((row) => [row.file, row]))

  const changed: Cue[] = []
  for (const { cue, file } of update) {
    const row = byFile.get(file)
    if (!row) continue
    cue.referenceAudio = { fileId: cue.key, relPath: row.abs, format: file.format }
    if (row.duration !== undefined) cue.referenceDuration = row.duration
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
    },
    changes: { cues: structuredClone([...changed, ...added]) },
  }
}
