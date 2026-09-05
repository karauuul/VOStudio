import { create } from 'zustand'
import {
  cueHasPending,
  enqueue,
  fail,
  finish,
  nextQueued,
  pendingCount,
  start,
  type Job,
  type JobKind,
} from './queue'

export interface JobSpec {
  kind: JobKind
  cueId: string
  run: () => Promise<void>
  onError?: (error: unknown) => void
}

interface JobsState {
  jobs: Job[]
  submit: (spec: JobSpec) => string
  saving: number
  beginSave: () => void
  endSave: () => void
}

const runners = new Map<string, JobSpec>()

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `job_${Date.now()}_${Math.random().toString(36).slice(2)}`

export const useJobsStore = create<JobsState>((set) => ({
  jobs: [],
  submit: (spec) => {
    const id = newId()
    runners.set(id, spec)
    set((s) => ({ jobs: enqueue(s.jobs, { id, kind: spec.kind, cueId: spec.cueId }) }))
    pump()
    return id
  },
  saving: 0,
  beginSave: () => set((s) => ({ saving: s.saving + 1 })),
  endSave: () => set((s) => ({ saving: Math.max(0, s.saving - 1) })),
}))

function pump(): void {
  const next = nextQueued(useJobsStore.getState().jobs)
  if (!next) return
  const spec = runners.get(next.id)
  useJobsStore.setState((s) => ({ jobs: start(s.jobs, next.id) }))
  if (!spec) {
    useJobsStore.setState((s) => ({ jobs: fail(s.jobs, next.id, 'Internal: no runner') }))
    pump()
    return
  }
  const done = (): void => {
    runners.delete(next.id)
    pump()
  }
  void spec.run().then(
    () => {
      useJobsStore.setState((s) => ({ jobs: finish(s.jobs, next.id) }))
      done()
    },
    (e: unknown) => {
      useJobsStore.setState((s) => ({ jobs: fail(s.jobs, next.id, String(e)) }))
      spec.onError?.(e)
      done()
    }
  )
}

export const useJobCount = (): number => useJobsStore((s) => pendingCount(s.jobs))

export const useBusyCount = (): number => useJobsStore((s) => pendingCount(s.jobs) + s.saving)

export const useCueBusy = (cueId: string): boolean =>
  useJobsStore((s) => cueHasPending(s.jobs, cueId))

export const busyCountNow = (): number => {
  const s = useJobsStore.getState()
  return pendingCount(s.jobs) + s.saving
}

export const isCueBusyNow = (cueId: string): boolean =>
  cueHasPending(useJobsStore.getState().jobs, cueId)
