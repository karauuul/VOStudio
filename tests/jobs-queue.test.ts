import { describe, expect, it } from 'vitest'
import {
  cueHasPending,
  enqueue,
  fail,
  finish,
  KEEP_TERMINAL,
  nextQueued,
  pendingCount,
  start,
  type Job,
} from '../src/renderer/jobs/queue'

const add = (jobs: Job[], id: string, cueId = 'c1', kind: 'tts' | 'sts' = 'tts'): Job[] =>
  enqueue(jobs, { id, kind, cueId })

describe('enqueue', () => {
  it('appends the job at the end with state queued', () => {
    const jobs = add(add([], 'a'), 'b')
    expect(jobs.map((j) => j.id)).toEqual(['a', 'b'])
    expect(jobs.every((j) => j.state === 'queued')).toBe(true)
  })

  it('does not mutate the input array', () => {
    const before: Job[] = []
    add(before, 'a')
    expect(before).toHaveLength(0)
  })

  it('preserves kind and cueId', () => {
    const [j] = add([], 'a', 'cue-9', 'sts')
    expect(j).toMatchObject({ kind: 'sts', cueId: 'cue-9' })
  })
})

describe('nextQueued — concurrency 1', () => {
  it('an empty queue → null', () => {
    expect(nextQueued([])).toBeNull()
  })

  it('hands out the FIRST queued job', () => {
    const jobs = add(add([], 'a'), 'b')
    expect(nextQueued(jobs)?.id).toBe('a')
  })

  it('while one is running — it hands out no next job', () => {
    const jobs = start(add(add([], 'a'), 'b'), 'a')
    expect(nextQueued(jobs)).toBeNull()
  })

  it('after finish it hands out the next one', () => {
    const jobs = finish(start(add(add([], 'a'), 'b'), 'a'), 'a')
    expect(nextQueued(jobs)?.id).toBe('b')
  })

  it('everything finished → null', () => {
    const jobs = finish(start(add([], 'a'), 'a'), 'a')
    expect(nextQueued(jobs)).toBeNull()
  })
})

describe('start', () => {
  it('moves queued → running', () => {
    const [j] = start(add([], 'a'), 'a')
    expect(j.state).toBe('running')
  })

  it('does not resurrect a finished job', () => {
    const jobs = start(finish(start(add([], 'a'), 'a'), 'a'), 'a')
    expect(jobs[0].state).toBe('done')
  })

  it('an unknown id breaks nothing', () => {
    const jobs = add([], 'a')
    expect(start(jobs, 'zzz')[0].state).toBe('queued')
  })
})

describe('fail — an error does not stop the queue', () => {
  it('records the state and the error text', () => {
    const jobs = fail(start(add([], 'a'), 'a'), 'a', 'ElevenLabs 401')
    expect(jobs[0]).toMatchObject({ state: 'error', error: 'ElevenLabs 401' })
  })

  it('after fail the next job starts', () => {
    const jobs = fail(start(add(add([], 'a'), 'b'), 'a'), 'a', 'boom')
    expect(nextQueued(jobs)?.id).toBe('b')
  })

  it('finish after fail clears the error text', () => {
    const jobs = finish(fail(add([], 'a'), 'a', 'boom'), 'a')
    expect(jobs[0].error).toBeUndefined()
  })
})

describe('pendingCount / cueHasPending — count ONLY the live ones', () => {
  it('queued and running count, done and error do not', () => {
    let jobs = add(add(add(add([], 'a'), 'b'), 'c'), 'd')
    jobs = finish(start(jobs, 'a'), 'a')
    jobs = fail(start(jobs, 'b'), 'b', 'boom')
    jobs = start(jobs, 'c')
    expect(pendingCount(jobs)).toBe(2)
  })

  it('an empty queue → 0', () => {
    expect(pendingCount([])).toBe(0)
  })

  it('cueHasPending sees only its own cue', () => {
    const jobs = add(add([], 'a', 'cue-1'), 'b', 'cue-2')
    expect(cueHasPending(jobs, 'cue-1')).toBe(true)
    expect(cueHasPending(jobs, 'cue-3')).toBe(false)
  })

  it('a finished job no longer blocks its cue', () => {
    const jobs = finish(start(add([], 'a', 'cue-1'), 'a'), 'a')
    expect(cueHasPending(jobs, 'cue-1')).toBe(false)
  })

  it('a failed job does not block either', () => {
    const jobs = fail(start(add([], 'a', 'cue-1'), 'a'), 'a', 'boom')
    expect(cueHasPending(jobs, 'cue-1')).toBe(false)
  })
})

describe('trimming the tail of finished jobs', () => {
  it('live jobs are never dropped', () => {
    let jobs: Job[] = []
    for (let i = 0; i < KEEP_TERMINAL + 5; i++) {
      jobs = finish(start(add(jobs, `done${i}`), `done${i}`), `done${i}`)
    }
    jobs = add(jobs, 'alive')
    expect(jobs.filter((j) => j.state === 'done')).toHaveLength(KEEP_TERMINAL)
    expect(jobs.some((j) => j.id === 'alive')).toBe(true)
  })

  it('exactly the TAIL stays — the freshest finished ones', () => {
    let jobs: Job[] = []
    for (let i = 0; i < KEEP_TERMINAL + 3; i++) {
      jobs = finish(start(add(jobs, `j${i}`), `j${i}`), `j${i}`)
    }
    expect(jobs[0].id).toBe('j3')
    expect(jobs[jobs.length - 1].id).toBe(`j${KEEP_TERMINAL + 2}`)
  })
})
