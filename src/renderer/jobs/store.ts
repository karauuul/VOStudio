import { create } from 'zustand'
import {
  cueHasPending,
  dropQueued,
  enqueue,
  isTerminal,
  fail,
  finish,
  nextQueued,
  pendingCount,
  start,
  type Job,
  type JobKind,
} from '@shared/jobs'

export interface JobSpec {
  kind: JobKind
  cueId: string
  run: () => Promise<void>
  onError?: (error: unknown) => void
}

interface JobsState {
  local: Job[]
  remote: Job[]
  jobs: Job[]
  placing: Record<string, number>
  submit: (spec: JobSpec) => string
  saving: number
  beginSave: () => void
  endSave: () => void
}

const runners = new Map<string, JobSpec>()
let generation = 0

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `job_${Date.now()}_${Math.random().toString(36).slice(2)}`

const setLocal = (fn: (local: Job[]) => Job[]): void =>
  useJobsStore.setState((s) => {
    const local = fn(s.local)
    return { local, jobs: [...s.remote, ...local] }
  })

export const useJobsStore = create<JobsState>((set) => ({
  local: [],
  remote: [],
  jobs: [],
  placing: {},
  submit: (spec) => {
    const id = newId()
    runners.set(id, spec)
    setLocal((local) => enqueue(local, { id, kind: spec.kind, cueId: spec.cueId, origin: 'ui', chars: 0 }))
    pump()
    return id
  },
  saving: 0,
  beginSave: () => set((s) => ({ saving: s.saving + 1 })),
  endSave: () => set((s) => ({ saving: Math.max(0, s.saving - 1) })),
}))

function pump(): void {
  const next = nextQueued(useJobsStore.getState().local)
  if (!next) return
  const spec = runners.get(next.id)
  setLocal((local) => start(local, next.id))
  if (!spec) {
    setLocal((local) => fail(local, next.id, 'Internal: no runner'))
    pump()
    return
  }
  const started = generation
  const done = (): void => {
    runners.delete(next.id)
    pump()
  }
  void spec.run().then(
    () => {
      setLocal((local) => finish(local, next.id))
      done()
    },
    (e: unknown) => {
      setLocal((local) => fail(local, next.id, String(e)))
      if (generation === started) spec.onError?.(e)
      done()
    }
  )
}

export const mirrorJobs = (remote: Job[]): void =>
  useJobsStore.setState((s) => ({ remote, jobs: [...remote, ...s.local] }))

const mark = (cueId: string, delta: number): void =>
  useJobsStore.setState((s) => {
    const count = (s.placing[cueId] ?? 0) + delta
    const { [cueId]: _cleared, ...rest } = s.placing
    return { placing: count > 0 ? { ...rest, [cueId]: count } : rest }
  })

export function runGeneration(
  cueId: string,
  work: (live: () => boolean) => Promise<void>,
  onError: (error: unknown) => void
): void {
  const started = generation
  const live = (): boolean => generation === started
  mark(cueId, 1)
  void work(live)
    .catch((e: unknown) => {
      if (live()) onError(e)
    })
    .finally(() => {
      if (live()) mark(cueId, -1)
    })
}

export const cancelQueuedJobs = (): void => {
  generation++
  const { local } = useJobsStore.getState()
  const kept = dropQueued(local)
  for (const j of local) if (!kept.includes(j)) runners.delete(j.id)
  setLocal(() => kept)
  useJobsStore.setState({ placing: {} })
}

export const clearTerminalJobs = (): void => setLocal((local) => local.filter((j) => !isTerminal(j)))

const placingCount = (placing: Record<string, number>): number =>
  Object.values(placing).reduce((n, v) => n + v, 0)

const cueBusy = (s: JobsState, cueId: string): boolean => cueHasPending(s.jobs, cueId) || (s.placing[cueId] ?? 0) > 0

export const useJobCount = (): number => useJobsStore((s) => pendingCount(s.jobs))

export const useJobTotal = (): number => useJobsStore((s) => s.jobs.length)

export const useJobFailed = (): number =>
  useJobsStore((s) => s.jobs.reduce((n, j) => (j.state === 'error' ? n + 1 : n), 0))

export const useBusyCount = (): number =>
  useJobsStore((s) => pendingCount(s.jobs) + s.saving + placingCount(s.placing))

export const useCueBusy = (cueId: string): boolean => useJobsStore((s) => cueBusy(s, cueId))

export const busyCountNow = (): number => {
  const s = useJobsStore.getState()
  return pendingCount(s.jobs) + s.saving + placingCount(s.placing)
}

export const isCueBusyNow = (cueId: string): boolean => cueBusy(useJobsStore.getState(), cueId)
