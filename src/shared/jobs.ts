export type JobKind = 'tts' | 'sts' | 'stt'
export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'
export type JobOrigin = 'ui' | 'agent'

export interface Job {
  id: string
  kind: JobKind
  cueId: string
  state: JobState
  origin: JobOrigin
  chars: number
  error?: string
  takeId?: string
}

export interface JobsSnapshot {
  seq: number
  jobs: Job[]
}

export const KEEP_TERMINAL = 100

export const JOB_CANCELLED = 'The job was cancelled before it ran.'
export const JOB_RETIRED = 'The project was closed or switched before this job ran.'

export const isTerminal = (j: Job): boolean => j.state === 'done' || j.state === 'error' || j.state === 'cancelled'

function prune(jobs: Job[]): Job[] {
  const terminal = jobs.filter(isTerminal)
  if (terminal.length <= KEEP_TERMINAL) return jobs
  const drop = new Set(terminal.slice(0, terminal.length - KEEP_TERMINAL).map((j) => j.id))
  return jobs.filter((j) => !drop.has(j.id))
}

export function enqueue(jobs: Job[], job: Omit<Job, 'state'>): Job[] {
  return prune([...jobs, { ...job, state: 'queued' }])
}

export function nextQueued(jobs: Job[]): Job | null {
  if (jobs.some((j) => j.state === 'running')) return null
  return jobs.find((j) => j.state === 'queued') ?? null
}

export function start(jobs: Job[], id: string): Job[] {
  return jobs.map((j) => (j.id === id && j.state === 'queued' ? { ...j, state: 'running' } : j))
}

export function finish(jobs: Job[], id: string, takeId?: string): Job[] {
  return prune(
    jobs.map((j) => {
      if (j.id !== id) return j
      const { error: _error, ...rest } = j
      return { ...rest, state: 'done', ...(takeId === undefined ? {} : { takeId }) }
    })
  )
}

export function fail(jobs: Job[], id: string, error: string): Job[] {
  return prune(jobs.map((j) => (j.id === id ? { ...j, state: 'error', error } : j)))
}

export function cancelQueued(jobs: Job[], ids: readonly string[]): Job[] {
  const wanted = new Set(ids)
  return prune(jobs.map((j) => (wanted.has(j.id) && j.state === 'queued' ? { ...j, state: 'cancelled' } : j)))
}

export function dropQueued(jobs: Job[]): Job[] {
  return jobs.filter((j) => j.state !== 'queued')
}

export function pendingCount(jobs: Job[]): number {
  return jobs.reduce((n, j) => (isTerminal(j) ? n : n + 1), 0)
}

export function cueHasPending(jobs: Job[], cueId: string): boolean {
  return jobs.some((j) => j.cueId === cueId && !isTerminal(j))
}

export interface GenerationGuard {
  lineBusy: boolean
  exporting: boolean
  restoring: boolean
  recording: boolean
}

export function generationRefusal(guard: GenerationGuard): string | null {
  if (guard.exporting) return 'Export in progress'
  if (guard.restoring) return 'Restoring version'
  if (guard.recording) return 'The line is being recorded'
  if (guard.lineBusy) return 'The line is already generating'
  return null
}

export function exportRefusal(jobs: Job[]): string | null {
  return pendingCount(jobs) > 0 ? 'Generation in progress; wait until the queued and running jobs finish, then export.' : null
}
