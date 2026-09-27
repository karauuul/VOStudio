import { describe, expect, it } from 'vitest'
import { busyCountNow, mirrorJobs, useJobsStore } from '../src/renderer/jobs/store'
import type { Job } from '../src/shared/jobs'

const job = (id: string, state: Job['state'] = 'queued'): Job => ({ id, kind: 'tts', cueId: id, state, origin: 'agent', chars: 3 })

describe('renderer mirror of the main generation queue', () => {
  it('hydrates from a snapshot and ignores one older than an event that already arrived', () => {
    mirrorJobs({ seq: 4, jobs: [job('a', 'running'), job('b')] })
    expect(busyCountNow()).toBe(2)
    mirrorJobs({ seq: 3, jobs: [job('a', 'running'), job('b'), job('c')] })
    expect(useJobsStore.getState().remote.map((j) => j.id)).toEqual(['a', 'b'])
    mirrorJobs({ seq: 4, jobs: [] })
    expect(busyCountNow()).toBe(2)
    mirrorJobs({ seq: 5, jobs: [job('a', 'done'), job('b', 'running')] })
    expect(useJobsStore.getState().jobs.map((j) => j.state)).toEqual(['done', 'running'])
    expect(busyCountNow()).toBe(1)
  })
})
