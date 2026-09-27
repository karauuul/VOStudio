import { describe, expect, it } from 'vitest'
import {
  cancelQueued,
  cueHasPending,
  dropQueued,
  enqueue,
  exportRefusal,
  fail,
  finish,
  generationRefusal,
  isTerminal,
  KEEP_TERMINAL,
  nextQueued,
  pendingCount,
  recordingRefusal,
  start,
  type Job,
} from '../src/shared/jobs'

const add = (jobs: Job[], id: string, cueId = 'c1', kind: 'tts' | 'sts' = 'tts'): Job[] =>
  enqueue(jobs, { id, kind, cueId, origin: 'ui', chars: 0 })

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

describe('dropQueued — a project switch cancels what has not started', () => {
  it('removes queued jobs and keeps running and finished ones in order', () => {
    let jobs = add(add(add(add([], 'a'), 'b'), 'c'), 'd')
    jobs = finish(start(jobs, 'a'), 'a')
    jobs = start(jobs, 'b')
    const kept = dropQueued(jobs)
    expect(kept.map((j) => [j.id, j.state])).toEqual([
      ['a', 'done'],
      ['b', 'running'],
    ])
    expect(pendingCount(kept)).toBe(1)
    expect(nextQueued(kept)).toBeNull()
  })

  it('does not mutate the input and keeps untouched jobs by identity', () => {
    const jobs = start(add(add([], 'a'), 'b'), 'a')
    const kept = dropQueued(jobs)
    expect(jobs).toHaveLength(2)
    expect(kept[0]).toBe(jobs[0])
  })
})

describe('finish records the take', () => {
  it('stores the take id and drops a previous error', () => {
    const jobs = finish(fail(start(add([], 'a'), 'a'), 'a', 'boom'), 'a', 'take-1')
    expect(jobs[0]).toEqual({ id: 'a', kind: 'tts', cueId: 'c1', origin: 'ui', chars: 0, state: 'done', takeId: 'take-1' })
  })
})

describe('cancelQueued — only jobs that have not started', () => {
  it('cancels queued jobs, leaves running and finished ones, and frees the cue', () => {
    let jobs = add(add(add([], 'a', 'c1'), 'b', 'c2'), 'c', 'c3')
    jobs = start(jobs, 'a')
    jobs = cancelQueued(jobs, ['a', 'b'])
    expect(jobs.map((j) => [j.id, j.state])).toEqual([
      ['a', 'running'],
      ['b', 'cancelled'],
      ['c', 'queued'],
    ])
    expect(isTerminal(jobs[1])).toBe(true)
    expect(cueHasPending(jobs, 'c2')).toBe(false)
    expect(pendingCount(jobs)).toBe(2)
  })

  it('a cancelled job is never handed out', () => {
    const jobs = cancelQueued(add(add([], 'a'), 'b'), ['a'])
    expect(nextQueued(jobs)?.id).toBe('b')
  })
})

describe('generationRefusal — one decision for every submitter', () => {
  const free = { lineBusy: false, exporting: false, restoring: false, recording: false }

  it('allows a free line', () => {
    expect(generationRefusal(free)).toBeNull()
  })

  it('refuses a busy line, an export, a restore and a recording of the line', () => {
    expect(generationRefusal({ ...free, lineBusy: true })).toBe('The line is already generating')
    expect(generationRefusal({ ...free, exporting: true })).toBe('Export in progress')
    expect(generationRefusal({ ...free, restoring: true })).toBe('Restoring version')
    expect(generationRefusal({ ...free, recording: true })).toBe('The line is being recorded')
  })

  it('names the project-wide reason before the line reason', () => {
    expect(generationRefusal({ lineBusy: true, exporting: true, restoring: true, recording: true })).toBe('Export in progress')
  })
})

describe('recordingRefusal — recording waits for the line generation', () => {
  const free = { lineBusy: false, exporting: false, restoring: false, recording: false }

  it('allows a free line, an export and another recording of the line', () => {
    expect(recordingRefusal(free)).toBeNull()
    expect(recordingRefusal({ ...free, exporting: true })).toBeNull()
    expect(recordingRefusal({ ...free, recording: true })).toBeNull()
  })

  it('refuses a restore and a line with queued or running generation', () => {
    expect(recordingRefusal({ ...free, restoring: true })).toBe('Restoring version')
    expect(recordingRefusal({ ...free, lineBusy: true })).toBe('The line is generating; wait until its jobs finish, then record.')
    expect(recordingRefusal({ ...free, lineBusy: true, restoring: true })).toBe('Restoring version')
  })
})

describe('exportRefusal — export waits for generation', () => {
  it('refuses while any job is queued or running and allows once all are finished', () => {
    const queued = add(add([], 'a'), 'b', 'c2')
    expect(exportRefusal([])).toBeNull()
    expect(exportRefusal(queued)).toBe('Generation in progress; wait until the queued and running jobs finish, then export.')
    const running = start(queued, 'a')
    expect(exportRefusal(cancelQueued(running, ['b']))).not.toBeNull()
    expect(exportRefusal(fail(cancelQueued(running, ['b']), 'a', 'no'))).toBeNull()
    expect(exportRefusal(finish(finish(queued, 'a', 't1'), 'b', 't2'))).toBeNull()
  })
})
