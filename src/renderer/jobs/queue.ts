export type JobKind = 'tts' | 'sts'
export type JobState = 'queued' | 'running' | 'done' | 'error'

export interface Job {
  id: string
  kind: JobKind
  cueId: string
  state: JobState
  error?: string
}

export const KEEP_TERMINAL = 20

const isTerminal = (j: Job): boolean => j.state === 'done' || j.state === 'error'

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

export function finish(jobs: Job[], id: string): Job[] {
  return prune(jobs.map((j) => (j.id === id ? { ...j, state: 'done', error: undefined } : j)))
}

export function fail(jobs: Job[], id: string, error: string): Job[] {
  return prune(jobs.map((j) => (j.id === id ? { ...j, state: 'error', error } : j)))
}

export function pendingCount(jobs: Job[]): number {
  return jobs.reduce((n, j) => (isTerminal(j) ? n : n + 1), 0)
}

export function cueHasPending(jobs: Job[], cueId: string): boolean {
  return jobs.some((j) => j.cueId === cueId && !isTerminal(j))
}
