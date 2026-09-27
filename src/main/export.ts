import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type {
  BatchExportRequest,
  DeliverPaths,
  ExportInfo,
  ExportJob,
  ExportPlan,
  ExportResult,
  ExportSummary,
  LastExport,
  VideoExportPlan,
} from '@shared/ipc'
import {
  compPlanFor,
  containerOf,
  findCollisions,
  hasEdits,
  isFastPath,
  planBatch,
  type PlannedTake,
  videoLines,
} from '@shared/export-plan'
import {
  buildReport,
  buildUpdatedIndex,
  exportedLines,
  indexBound,
  mergeExported,
  supersededFiles,
  type DeliverExported,
  type DeliverReport,
  type DeliverSummary,
} from '@shared/deliver'
import {
  exportSignature,
  formatSpec,
  loudnessGainDb,
  loudnessMode,
  mp3Rate,
  loudnessTarget,
  parseEbur128,
  parseSamplePeak,
  targetGainDb,
  videoMode,
  videoName,
  type LoudnessMeasure,
} from '@shared/export-settings'
import { renderChunks, videoTimelinePlan } from '@shared/sources'
import { sanitizeRevision } from '@shared/approval'
import { isInsideDir } from '@shared/project-summary'
import type { Project } from '@shared/domain'
import * as store from './project-store'
import { ffmpegStderr, runFfmpeg } from './ffmpeg'
import { muxVideo } from './sources'

const MAX_ENCODE_BYTES = 600 * 1024 * 1024
const PROJECT_CHANGED = 'Export cancelled: the project changed'
const VIDEO_CHUNK_SECONDS = 60

function ctx(): { project: Project; dir: string } {
  const project = store.getProject()
  const dir = store.getProjectDir()
  if (!project || !dir) throw new Error('No project is open')
  return { project, dir }
}

export function exportDir(project: Project, projectDir: string): string {
  const chosen = project.export?.outDir
  return chosen && path.isAbsolute(chosen) ? path.resolve(chosen) : path.join(projectDir, 'export')
}

let planned = new Map<string, ExportJob>()

interface BatchPlan {
  token: string
  project: Project
  outDir: string
  stagingDir: string
  live: boolean
}

let batchPlan: BatchPlan | null = null
const STAGING_DIR = 'export.staging'

function toJobs(items: PlannedTake[], outDir: string, project: Project): ExportJob[] {
  const spec = formatSpec(project.export?.format)
  const matchLoudness = loudnessMode(project.export) === 'match'
  const target = loudnessTarget(project.export)
  return items.map((p) => {
    const outPath = path.join(outDir, p.name)
    const format = containerOf(p.name)
    if (!format) throw new Error(`Unsupported export container for "${p.name}" (mp3/wav/ogg only)`)
    const plan = compPlanFor(p.cue, p.take, project)
    const ref = p.cue.referenceAudio?.relPath
    return {
      cueId: p.cue.id,
      cueKey: p.cue.key,
      takeId: p.take.id,
      name: p.name,
      outPath,
      srcPath: p.take.file.relPath,
      format,
      formatArgs: spec.args,
      ...(spec.rate ? { sampleRate: spec.rate } : {}),
      fastPath: isFastPath(p.take, p.name, plan ? p.cue.comp : undefined, project.export, p.cue),
      hasEdits: hasEdits(p.take.edits),
      edits: p.take.edits,
      ...(matchLoudness && ref ? { matchLoudnessRef: ref } : {}),
      ...(target ? { loudnessTarget: target } : {}),
      ...(plan ? { compPlan: plan } : {}),
    }
  })
}

async function readReport(outDir: string): Promise<DeliverReport | null> {
  try {
    const raw = await fs.readFile(path.join(outDir, 'report.json'), 'utf8')
    return JSON.parse(raw) as DeliverReport
  } catch {
    return null
  }
}

function toLastExport(report: DeliverReport | null): LastExport | null {
  if (!report) return null
  return {
    createdAt: typeof report.createdAt === 'string' ? report.createdAt : '',
    ...(typeof report.version === 'number' ? { version: report.version } : {}),
    exported: report.exported?.length ?? 0,
    failed: report.failed?.length ?? 0,
    cueIds: (report.exported ?? []).map((e) => e.cueId).filter((id) => typeof id === 'string'),
    lines: exportedLines(report),
  }
}

export async function exportInfo(): Promise<ExportInfo> {
  const { project, dir } = ctx()
  const outDir = exportDir(project, dir)
  return {
    outDir,
    writesIndex: indexBound(project),
    last: toLastExport(await readReport(outDir)),
  }
}

export async function planBatchExport(req: BatchExportRequest): Promise<ExportPlan> {
  const { project, dir } = ctx()
  const outDir = exportDir(project, dir)
  const wanted = new Set(req.cueIds)
  const items = planBatch(project).filter((p) => wanted.has(p.cue.id))
  const collisions = findCollisions(items)
  if (collisions.length > 0) {
    throw new Error(`Name collision: ${collisions.map((c) => c.name).join(', ')}`)
  }
  batchPlan = null
  const token = randomUUID()
  const stagingDir = path.join(dir, STAGING_DIR)
  const jobs = toJobs(items, path.join(stagingDir, 'audio'), project)
  batchPlan = { token, project: structuredClone(project), outDir, stagingDir, live: true }
  planned = new Map(jobs.map((j) => [j.outPath, j]))
  await fs.rm(stagingDir, { recursive: true, force: true })
  return { token, jobs, outDir }
}

function jobFor(outPath: string): ExportJob {
  const job = planned.get(outPath)
  if (!job) throw new Error(`"${outPath}" is not part of the current export plan`)
  if (!batchPlan?.live) throw new Error(PROJECT_CHANGED)
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

function toBuffer(wav: unknown): Buffer {
  if (wav instanceof ArrayBuffer) return Buffer.from(wav)
  if (ArrayBuffer.isView(wav)) {
    const v = wav as ArrayBufferView
    return Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength)
  }
  throw new Error('Expected an ArrayBuffer with rendered WAV data')
}

const WAV_RATE_OFFSET = 24

async function measureLoudness(file: string, rate?: number): Promise<LoudnessMeasure> {
  try {
    const filter = `${rate ? `aresample=${rate},` : ''}ebur128=peak=sample,astats=measure_perchannel=none`
    const stderr = await ffmpegStderr(['-i', file, '-af', filter, '-f', 'null', '-'])
    return { lufs: parseEbur128(stderr), peak: parseSamplePeak(stderr) }
  } catch {
    return { lufs: null, peak: null }
  }
}

async function postGainDb(job: ExportJob, rendered: string, rate: number): Promise<number> {
  if (job.loudnessTarget) {
    const measured = await measureLoudness(rendered, rate)
    return targetGainDb(job.loudnessTarget, measured, job.format !== 'wav')
  }
  if (!job.matchLoudnessRef) return 0
  const [reference, actual] = await Promise.all([
    measureLoudness(job.matchLoudnessRef),
    measureLoudness(rendered, rate),
  ])
  return loudnessGainDb(reference.lufs, actual.lufs)
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
    const renderedRate = bytes.readUInt32LE(WAV_RATE_OFFSET)
    const rate = job.sampleRate ?? (job.format === 'mp3' ? mp3Rate(renderedRate) : renderedRate)
    const gain = await postGainDb(job, tmp, rate)
    await runFfmpeg([
      '-i',
      tmp,
      ...(gain === 0 ? [] : ['-af', `volume=${gain}dB`]),
      ...job.formatArgs,
      ...(job.sampleRate === undefined && rate !== renderedRate ? ['-ar', String(rate)] : []),
      outPath,
    ])
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
  const out = await fs.readFile(outPath)
  return { outPath, bytes: out.length, parityHash: sha256(out) }
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) await copyTree(src, dst)
    else await fs.copyFile(src, dst)
  }
}

export async function removeSuperseded(outDir: string, files: string[]): Promise<void> {
  const audioRoot = await fs.realpath(path.join(outDir, 'audio')).catch(() => null)
  if (!audioRoot) return
  for (const file of files) {
    const target = path.join(outDir, file)
    const folder = await fs.realpath(path.dirname(target)).catch(() => null)
    if (!folder || (folder !== audioRoot && !isInsideDir(folder, audioRoot))) continue
    await fs.rm(path.join(folder, path.basename(target)), { force: true })
  }
}

export async function finishExport(
  token: string,
  summary: ExportSummary,
  stamp: () => Promise<number | undefined>
): Promise<DeliverPaths> {
  if (!batchPlan || token !== batchPlan.token) throw new Error('This batch export plan is no longer current')
  if (!batchPlan.live) throw new Error(PROJECT_CHANGED)
  if (ctx().project.id !== batchPlan.project.id) throw new Error('The exported project is no longer open')
  const version = await stamp()
  const { project, outDir, stagingDir } = batchPlan
  for (const f of summary.failed) {
    const outPath = path.join(stagingDir, 'audio', f.name)
    if (planned.has(outPath)) await fs.rm(outPath, { force: true })
  }
  const revisions = new Map(project.cues.map((c) => [c.key, sanitizeRevision(c.output?.revision)]))
  const signature = exportSignature(project.export, project.exportTemplate)
  const exported: DeliverExported[] = summary.exported.map((e) => ({
    cueId: e.cueKey,
    exportName: path.parse(e.name).name,
    file: `audio/${e.name}`,
    bytes: e.bytes,
    sha256: e.sha256,
    revision: revisions.get(e.cueKey) ?? 0,
    ...(version === undefined ? {} : { version }),
    signature,
  }))
  const previous = await readReport(outDir)
  const deliver: DeliverSummary = {
    exported: mergeExported(previous?.exported ?? [], exported),
    failed: summary.failed.map((f) => ({
      cueId: f.cueKey,
      exportName: path.parse(f.name).name,
      file: `audio/${f.name}`,
      reason: f.reason,
    })),
    skipped: [],
  }

  await fs.mkdir(path.join(stagingDir, 'audio'), { recursive: true })
  const index = buildUpdatedIndex(project)
  if (index !== null) await fs.writeFile(path.join(stagingDir, 'index.updated.csv'), index)
  const report = buildReport(project.name, deliver, version)
  await fs.writeFile(path.join(stagingDir, 'report.json'), JSON.stringify(report, null, 2))
  await copyTree(stagingDir, outDir)
  await fs.rm(stagingDir, { recursive: true, force: true })
  await removeSuperseded(outDir, supersededFiles(previous?.exported ?? [], exported))
  return {
    ...(index === null ? {} : { indexPath: path.join(outDir, 'index.updated.csv') }),
    reportPath: path.join(outDir, 'report.json'),
    ...(version === undefined ? {} : { version }),
  }
}

interface VideoRun {
  token: string
  outPath: string
  videoPath: string | null
  raw: string
  handle: FileHandle | null
  sampleRate: number
  channels: number
  live: boolean
}

let videoRun: VideoRun | null = null
const VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024

export async function planVideoExport(sourceId: string): Promise<VideoExportPlan | null> {
  const { project, dir } = ctx()
  const source = project.sources?.find((s) => s.id === sourceId)
  if (!source) throw new Error('Source not found')
  const lines = videoLines(project, sourceId)
  if (lines.length === 0) return null
  const mode = videoMode(project.export)
  const name = videoName(project.export, source.name, project.languages?.target ?? '', mode)
  const plan = videoTimelinePlan(source.file.relPath, source.duration, lines)
  const previous = videoRun
  const token = randomUUID()
  const raw = path.join(os.tmpdir(), `vostudio-video-${token}.f32`)
  videoRun = {
    token,
    outPath: path.join(exportDir(project, dir), name),
    videoPath: mode === 'copy' && source.media ? source.media : null,
    raw,
    handle: null,
    sampleRate: 0,
    channels: 0,
    live: true,
  }
  if (previous) await releaseVideoRun(previous)
  return {
    token,
    sourceId,
    name,
    outPath: videoRun.outPath,
    duration: source.duration,
    chunks: renderChunks(source.duration, VIDEO_CHUNK_SECONDS, lines.map((l) => ({ start: l.in, end: l.out }))).map(
      (c) => ({ in: c.start, out: c.end })
    ),
    clips: plan.clips,
    tracks: plan.tracks,
  }
}

async function releaseVideoRun(run: VideoRun): Promise<void> {
  const handle = run.handle
  run.handle = null
  await handle?.close().catch(() => undefined)
  await fs.rm(run.raw, { force: true }).catch(() => undefined)
}

async function closeVideoRun(): Promise<void> {
  const run = videoRun
  videoRun = null
  if (run) await releaseVideoRun(run)
}

export function cancelExports(): void {
  if (batchPlan) batchPlan.live = false
  if (!videoRun?.live) return
  videoRun.live = false
  void releaseVideoRun(videoRun)
}

function videoFor(token: string): VideoRun {
  if (!videoRun || videoRun.token !== token) throw new Error('This video export is no longer current')
  if (!videoRun.live) throw new Error(PROJECT_CHANGED)
  return videoRun
}

export async function appendVideoChunk(
  token: string,
  pcm: unknown,
  sampleRate: number,
  channels: number
): Promise<void> {
  const run = videoFor(token)
  const bytes = toBuffer(pcm)
  if (run.handle === null) {
    run.sampleRate = sampleRate
    run.channels = channels
    run.handle = await fs.open(run.raw, 'w')
  } else if (run.sampleRate !== sampleRate || run.channels !== channels) {
    throw new Error('Rendered chunks disagree on sample rate or channel count')
  }
  const { size } = await run.handle.stat()
  if (size + bytes.length > VIDEO_MAX_BYTES) throw new Error('Rendered video audio is too large')
  await run.handle.write(bytes)
}

export async function abortVideoExport(token: string): Promise<void> {
  if (videoRun && videoRun.token === token) await closeVideoRun()
}

export async function finishVideoExport(token: string): Promise<ExportResult> {
  const run = videoFor(token)
  if (!run.handle) throw new Error('No audio was rendered for the video')
  await run.handle.close()
  run.handle = null
  try {
    await muxVideo(run.outPath, run.videoPath, run.raw, run.sampleRate, run.channels)
    const out = await fs.readFile(run.outPath)
    return { outPath: run.outPath, bytes: out.length, parityHash: sha256(out) }
  } finally {
    await closeVideoRun()
  }
}
