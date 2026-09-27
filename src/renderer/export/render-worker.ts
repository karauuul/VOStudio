import { api } from '../api'
import { renderJob, runPlan } from './run-export'

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 2000)

export function startRenderWorker(): void {
  api.on('render:line', ({ id, job }) => {
    void renderJob(job).then(
      ({ wav }) => api['render:reply']({ id, ok: true, wav }),
      (e: unknown) => api['render:reply']({ id, ok: false, error: reason(e) })
    )
  })
  api.on('render:plan', ({ id, plan }) => {
    void runPlan(plan).then(
      (result) => api['render:reply']({ id, ok: true, result }),
      (e: unknown) => api['render:reply']({ id, ok: false, error: reason(e) })
    )
  })
}
