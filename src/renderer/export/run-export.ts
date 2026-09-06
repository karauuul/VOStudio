import type {
  BatchExportFailure,
  BatchExportResult,
  ExportJob,
  ExportPlan,
  ExportResult,
  ExportSummary,
} from '@shared/ipc'
import type { CompPlan } from '@shared/export-plan'
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
    ...(plan.original
      ? { original: { url: audioUrl(plan.original.srcPath), gainDb: plan.original.gainDb } }
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
