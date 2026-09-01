import type {
  BatchExportFailure,
  BatchExportRequest,
  BatchExportResult,
  ExportJob,
  ExportPlan,
  ExportResult,
} from '@shared/ipc'
import { api, audioUrl } from '../api'
import type { ResolvedComp } from '../audio/comp-source'
import { renderClipToWav, renderCompToWav } from '../audio/offline-render'

export interface ExportProgress {
  done: number
  total: number
  current: string
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

function resolveJobComp(job: ExportJob): ResolvedComp {
  const clips = (job.comp ?? []).map((c, i) => ({
    clip: {
      id: `${job.cueId}#${i}`,
      sourceTakeId: '',
      srcIn: c.srcIn,
      srcOut: c.srcOut,
      start: c.start,
      edits: c.edits,
      ...(c.crossfade === undefined ? {} : { crossfade: c.crossfade }),
    },
    url: audioUrl(c.srcPath),
  }))
  return job.compRegion ? { clips, region: job.compRegion } : { clips }
}

export async function runJob(job: ExportJob): Promise<ExportResult> {
  if (job.comp && job.comp.length > 0) {
    const { wav } = await renderCompToWav(resolveJobComp(job))
    return api['export:encode'](job.outPath, wav)
  }
  if (job.fastPath) return api['export:copy'](job.outPath)
  const { wav } = await renderClipToWav(audioUrl(job.srcPath), job.edits)
  return api['export:encode'](job.outPath, wav)
}

export async function runPlan(
  plan: ExportPlan,
  onProgress?: (p: ExportProgress) => void
): Promise<BatchExportResult> {
  const failed: BatchExportFailure[] = []
  let written = 0
  for (let i = 0; i < plan.jobs.length; i++) {
    const job = plan.jobs[i]
    onProgress?.({ done: i, total: plan.jobs.length, current: job.name })
    try {
      await runJob(job)
      written++
    } catch (e) {
      failed.push({ cueKey: job.cueKey, name: job.name, error: message(e) })
    }
  }
  onProgress?.({ done: plan.jobs.length, total: plan.jobs.length, current: '' })
  return { written, skipped: plan.skipped, failed, collisions: [], outDir: plan.outDir }
}

export async function exportBatch(
  req: BatchExportRequest,
  onProgress?: (p: ExportProgress) => void
): Promise<BatchExportResult> {
  const plan = await api['export:planBatch'](req)
  if (plan.collisions.length > 0) {
    return { written: 0, skipped: 0, failed: [], collisions: plan.collisions, outDir: plan.outDir }
  }
  return runPlan(plan, onProgress)
}

export async function exportCue(cueId: string): Promise<ExportResult> {
  const plan = await api['export:planCue'](cueId)
  const job = plan.jobs[0]
  if (!job) throw new Error('Nothing to export for this cue')
  return runJob(job)
}
