import { randomUUID } from 'crypto'
import type { Take } from '@shared/domain'
import {
  JOB_CANCELLED,
  JOB_RETIRED,
  cancelQueued,
  cueHasPending,
  enqueue,
  fail,
  finish,
  generationRefusal,
  isTerminal,
  nextQueued,
  start,
  type GenerationGuard,
  type Job,
  type JobOrigin,
  type JobsSnapshot,
} from '@shared/jobs'

export interface GenerationSpec {
  kind: 'tts' | 'sts'
  cueId: string
  origin: JobOrigin
  chars: number
  owner: object
  run: () => Promise<Take>
}

export interface QueuedGeneration {
  id: string
  done: Promise<Take>
}

export interface GenerationQueue {
  submit: (spec: GenerationSpec) => QueuedGeneration
  cancel: (ids: readonly string[]) => string[]
  retire: (owner: object | null) => void
  list: () => Job[]
  owned: (owner: object | null) => Job[]
  snapshot: () => JobsSnapshot
  check: (cueId: string) => GenerationGuard
  settle: (ids: readonly string[], ms: number, signal: AbortSignal, progress: (done: number, total: number) => void) => Promise<void>
}

interface Entry {
  spec: GenerationSpec
  resolve: (take: Take) => void
  reject: (error: Error) => void
}

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

export function createGenerationQueue(options: {
  guard: (cueId: string) => Omit<GenerationGuard, 'lineBusy'>
  changed: (snapshot: JobsSnapshot) => void
}): GenerationQueue {
  let jobs: Job[] = []
  let seq = 0
  const entries = new Map<string, Entry>()
  const owners = new Map<string, object>()
  let inFlight: string | null = null
  const listeners = new Set<() => void>()

  const publish = (next: Job[]): void => {
    jobs = next
    seq++
    const kept = new Set(jobs.map((j) => j.id))
    for (const id of owners.keys()) if (!kept.has(id)) owners.delete(id)
    options.changed({ seq, jobs })
    for (const listener of [...listeners]) listener()
  }

  const check = (cueId: string): GenerationGuard => ({ lineBusy: cueHasPending(jobs, cueId), ...options.guard(cueId) })

  const settleEntry = (id: string, error: Error): void => {
    entries.get(id)?.reject(error)
    entries.delete(id)
  }

  const pump = (): void => {
    if (inFlight) return
    const next = nextQueued(jobs)
    if (!next) return
    const entry = entries.get(next.id)
    if (!entry) {
      publish(fail(jobs, next.id, 'The job lost its runner.'))
      pump()
      return
    }
    inFlight = next.id
    publish(start(jobs, next.id))
    const settle = (settled: Job[]): void => {
      if (jobs.some((j) => j.id === next.id)) publish(settled)
    }
    void entry.spec
      .run()
      .then(
        (take) => {
          settle(finish(jobs, next.id, take.id))
          entry.resolve(take)
        },
        (error: unknown) => {
          const failure = asError(error)
          settle(fail(jobs, next.id, failure.message))
          entry.reject(failure)
        }
      )
      .finally(() => {
        inFlight = null
        entries.delete(next.id)
        pump()
      })
  }

  return {
    submit(spec) {
      const refusal = generationRefusal(check(spec.cueId))
      if (refusal) throw new Error(refusal)
      const id = randomUUID()
      const done = new Promise<Take>((resolve, reject) => entries.set(id, { spec, resolve, reject }))
      done.catch(() => undefined)
      owners.set(id, spec.owner)
      publish(enqueue(jobs, { id, kind: spec.kind, cueId: spec.cueId, origin: spec.origin, chars: spec.chars }))
      pump()
      return { id, done }
    },
    cancel(ids) {
      const cancelled = jobs.filter((j) => ids.includes(j.id) && j.state === 'queued').map((j) => j.id)
      if (cancelled.length === 0) return []
      publish(cancelQueued(jobs, cancelled))
      for (const id of cancelled) settleEntry(id, new Error(JOB_CANCELLED))
      return cancelled
    },
    retire(owner) {
      const stale = (j: Job): boolean => owners.get(j.id) !== owner
      const dropped = jobs.filter(stale)
      if (dropped.length === 0) return
      publish(jobs.filter((j) => !stale(j)))
      for (const j of dropped) if (j.state !== 'running') settleEntry(j.id, new Error(JOB_RETIRED))
    },
    list: () => jobs,
    owned: (owner) => jobs.filter((j) => owners.get(j.id) === owner),
    snapshot: () => ({ seq, jobs }),
    check,
    settle(ids, ms, signal, progress) {
      return new Promise((resolve) => {
        let reported = -1
        const check = (): void => {
          const tracked = jobs.filter((j) => ids.includes(j.id))
          const done = tracked.filter(isTerminal).length
          if (done !== reported) progress(done, tracked.length)
          reported = done
          if (done === tracked.length || signal.aborted) stop()
        }
        const timer = setTimeout(() => stop(), ms)
        const stop = (): void => {
          clearTimeout(timer)
          listeners.delete(check)
          signal.removeEventListener('abort', stop)
          resolve()
        }
        signal.addEventListener('abort', stop)
        listeners.add(check)
        check()
      })
    },
  }
}
