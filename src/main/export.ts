import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type { BatchExportRequest, ExportCompClip, ExportJob, ExportPlan, ExportResult } from '@shared/ipc'
import {
  containerOf,
  exportName,
  findCollisions,
  hasEdits,
  isFastPath,
  outputTakeOf,
  planBatch,
  resolvePlan,
  type PlannedTake,
} from '@shared/export-plan'
import { isEmptyComp } from '@shared/comp'
import { usesCompOutput } from '@shared/approval'
import type { Cue, Project } from '@shared/domain'
import * as store from './project-store'
import { runFfmpeg } from './ffmpeg'

const MAX_ENCODE_BYTES = 600 * 1024 * 1024

function ctx(): { project: Project; dir: string } {
  const project = store.getProject()
  const dir = store.getProjectDir()
  if (!project || !dir) throw new Error('No project is open')
  return { project, dir }
}

let planned = new Map<string, ExportJob>()

function compJobClips(cue: Cue): ExportCompClip[] | undefined {
  if (!usesCompOutput(cue)) return undefined
  if (isEmptyComp(cue.comp)) return undefined
  return cue.comp!.clips.map((c) => {
    const take = cue.takes.find((t) => t.id === c.sourceTakeId)
    if (!take) {
      throw new Error(`Cue "${cue.key}": composition clip "${c.id}" points at a missing take`)
    }
    return {
      srcPath: take.file.relPath,
      srcIn: c.srcIn,
      srcOut: c.srcOut,
      start: c.start,
      edits: c.edits,
      ...(c.crossfade === undefined ? {} : { crossfade: c.crossfade }),
    }
  })
}

function toJobs(items: PlannedTake[], outDir: string): ExportJob[] {
  return items.map((p) => {
    const outPath = path.join(outDir, p.name)
    const format = containerOf(p.name)
    if (!format) throw new Error(`Unsupported export container for "${p.name}" (mp3/wav/ogg only)`)
    const comp = compJobClips(p.cue)
    const region = comp ? p.cue.comp?.region : undefined
    return {
      cueId: p.cue.id,
      cueKey: p.cue.key,
      takeId: p.take.id,
      name: p.name,
      outPath,
      srcPath: p.take.file.relPath,
      format,
      fastPath: isFastPath(p.take, p.name, comp ? p.cue.comp : undefined),
      hasEdits: hasEdits(p.take.edits),
      edits: p.take.edits,
      ...(comp ? { comp } : {}),
      ...(region ? { compRegion: { in: region.in, out: region.out } } : {}),
    }
  })
}

function publish(jobs: ExportJob[], skipped: number, outDir: string, collisions: ExportPlan['collisions']): ExportPlan {
  planned = new Map(jobs.map((j) => [j.outPath, j]))
  return { jobs, skipped, outDir, collisions }
}

export function planCueExport(cueId: string): ExportPlan {
  const { project, dir } = ctx()
  const cue = project.cues.find((c) => c.id === cueId)
  if (!cue) throw new Error('Cue not found')
  const take = outputTakeOf(cue)
  if (!take) throw new Error('No voiced output')
  const outDir = path.join(dir, 'exports')
  return publish(toJobs([{ cue, take, name: exportName(project, cue, take) }], outDir), 0, outDir, [])
}

export function planBatchExport(req: BatchExportRequest): ExportPlan {
  const { project, dir } = ctx()
  const outDir = req.outDir || path.join(dir, 'exports')
  const items = planBatch(project, req.scope)
  const resolved = resolvePlan(items, req.collisionStrategy ?? {})
  if (resolved.uncovered.length > 0) return publish([], 0, outDir, findCollisions(items))
  return publish(toJobs(resolved.jobs, outDir), resolved.skipped, outDir, [])
}

function jobFor(outPath: string): ExportJob {
  const job = planned.get(outPath)
  if (!job) throw new Error(`"${outPath}" is not part of the current export plan`)
  return job
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function copyJob(outPath: string): Promise<ExportResult> {
  const job = jobFor(outPath)
  if (!job.fastPath) {
    throw new Error(`"${job.name}" has edits — it must be rendered, not copied`)
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.copyFile(job.srcPath, outPath)
  const src = await fs.readFile(job.srcPath)
  const out = await fs.readFile(outPath)
  const srcHash = sha256(src)
  const outHash = sha256(out)
  if (srcHash !== outHash) throw new Error('Parity fail: export ≠ preview')
  return { outPath, bytes: out.length, parityHash: outHash }
}

function codecArgs(format: ExportJob['format']): string[] {
  if (format === 'mp3') return ['-c:a', 'libmp3lame', '-b:a', '192k']
  if (format === 'ogg') return ['-c:a', 'libvorbis', '-q:a', '6']
  return ['-c:a', 'pcm_s24le']
}

function toBuffer(wav: unknown): Buffer {
  if (wav instanceof ArrayBuffer) return Buffer.from(wav)
  if (ArrayBuffer.isView(wav)) {
    const v = wav as ArrayBufferView
    return Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength)
  }
  throw new Error('Expected an ArrayBuffer with rendered WAV data')
}

export async function encodeJob(outPath: string, wav: unknown): Promise<ExportResult> {
  const job = jobFor(outPath)
  const bytes = toBuffer(wav)
  if (bytes.length === 0) throw new Error('Rendered audio is empty')
  if (bytes.length > MAX_ENCODE_BYTES) {
    throw new Error(`Rendered audio is too large: ${(bytes.length / 1024 / 1024).toFixed(1)} MB`)
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true })
  const tmp = path.join(os.tmpdir(), `vostudio-export-${randomUUID()}.wav`)
  try {
    await fs.writeFile(tmp, bytes)
    await runFfmpeg(['-i', tmp, ...codecArgs(job.format), outPath])
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
  const out = await fs.readFile(outPath)
  return { outPath, bytes: out.length, parityHash: sha256(out) }
}
