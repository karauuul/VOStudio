import type {
  BatchExportFailure,
  BatchExportResult,
  ExportJob,
  ExportPlan,
  ExportResult,
  ExportSummary,
  VideoExportPlan,
} from '@shared/ipc'
import type { CompPlan } from '@shared/export-plan'
import { api, audioUrl } from '../api'
import type { ResolvedComp } from '../audio/comp-source'
import {
  channelsOf,
  renderClipToWav,
  renderCompOffline,
  renderCompToWav,
} from '../audio/offline-render'
import { loadCompSources, release } from '../audio/transport'
import { interleave } from '../audio/wav'

export interface ExportProgress {
  done: number
  total: number
  current: string
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

function resolveJobComp(job: ExportJob, plan: CompPlan): ResolvedComp {
  return {
    clips: plan.clips.map((c, i) => ({
      clip: {
        id: `${job.cueId}#${i}`,
        sourceTakeId: '',
        srcIn: c.srcIn,
        srcOut: c.srcOut,
        start: c.start,
        edits: c.edits,
        ...(c.crossfade === undefined ? {} : { crossfade: c.crossfade }),
        ...(c.trackId === undefined ? {} : { trackId: c.trackId }),
      },
      url: audioUrl(c.srcPath),
    })),
    ...(plan.region ? { region: plan.region } : {}),
    ...(plan.tracks ? { tracks: plan.tracks } : {}),
    ...(plan.originals && plan.originals.length > 0
      ? {
          originals: plan.originals.map((o) => ({
            url: audioUrl(o.srcPath),
            gainDb: o.gainDb,
            offset: o.offset,
            duration: o.duration,
            ...(o.duckDb === undefined ? {} : { duckDb: o.duckDb }),
          })),
        }
      : {}),
  }
}

export async function runJob(job: ExportJob): Promise<ExportResult> {
  const plan = job.compPlan
  if (plan && plan.clips.length > 0) {
    const { wav } = await renderCompToWav(resolveJobComp(job, plan))
    return api['export:encode'](job.outPath, wav)
  }
  if (job.fastPath) return api['export:copy'](job.outPath)
  const { wav } = await renderClipToWav(audioUrl(job.srcPath), job.edits)
  return api['export:encode'](job.outPath, wav)
}

export async function runVideo(
  plan: VideoExportPlan,
  onProgress?: (p: ExportProgress) => void
): Promise<ExportResult> {
  const resolved: ResolvedComp = {
    clips: plan.clips.map((c, i) => ({
      clip: {
        id: `${plan.sourceId}#${i}`,
        sourceTakeId: '',
        srcIn: c.srcIn,
        srcOut: c.srcOut,
        start: c.start,
        edits: c.edits,
        ...(c.crossfade === undefined ? {} : { crossfade: c.crossfade }),
        ...(c.trackId === undefined ? {} : { trackId: c.trackId }),
      },
      url: audioUrl(c.srcPath),
    })),
    tracks: plan.tracks,
  }
  const sources = await loadCompSources(resolved)
  let done = false
  try {
    for (let i = 0; i < plan.chunks.length; i++) {
      const chunk = plan.chunks[i]
      onProgress?.({ done: i, total: plan.chunks.length, current: plan.name })
      const rendered = await renderCompOffline(sources, chunk, plan.tracks)
      const pcm = interleave(channelsOf(rendered))
      await api['export:videoChunk'](
        plan.token,
        pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
        rendered.sampleRate,
        rendered.numberOfChannels
      )
    }
    const result = await api['export:videoFinish'](plan.token)
    done = true
    return result
  } finally {
    if (!done) await api['export:videoAbort'](plan.token).catch(() => undefined)
    for (const url of new Set(resolved.clips.map((c) => c.url))) release(url)
  }
}

export async function runPlan(
  plan: ExportPlan,
  onProgress?: (p: ExportProgress) => void
): Promise<BatchExportResult> {
  const failed: BatchExportFailure[] = []
  const summary: ExportSummary = { exported: [], failed: [] }
  for (let i = 0; i < plan.jobs.length; i++) {
    const job = plan.jobs[i]
    onProgress?.({ done: i, total: plan.jobs.length, current: job.name })
    try {
      const result = await runJob(job)
      summary.exported.push({
        cueKey: job.cueKey,
        name: job.name,
        bytes: result.bytes,
        sha256: result.parityHash,
      })
    } catch (e) {
      failed.push({ cueKey: job.cueKey, name: job.name, error: message(e) })
      summary.failed.push({ cueKey: job.cueKey, name: job.name, reason: message(e) })
    }
  }
  onProgress?.({ done: plan.jobs.length, total: plan.jobs.length, current: '' })
  const paths = await api['export:finish'](plan.token, summary)
  return { written: summary.exported.length, failed, outDir: plan.outDir, ...paths }
}
