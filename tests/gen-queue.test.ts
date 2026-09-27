import { describe, expect, it } from 'vitest'
import { createGenerationQueue, JOB_CANCELLED, JOB_RETIRED, type GenerationSpec } from '../src/main/gen-queue'
import { emptyEdits, type Take } from '../src/shared/domain'
import type { Job } from '../src/shared/jobs'

const take = (id: string): Take => ({
  id,
  kind: 'tts',
  createdAt: 'now',
  file: { fileId: id, relPath: `/p/${id}.mp3`, format: 'mp3' },
  duration: 0,
  meta: {},
  edits: emptyEdits(),
})

function deferred(): { promise: Promise<Take>; resolve: (t: Take) => void; reject: (e: Error) => void } {
  let resolve!: (t: Take) => void
  let reject!: (e: Error) => void
  const promise = new Promise<Take>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(guard = { exporting: false, restoring: false, recording: false }) {
  const published: Job[][] = []
  const queue = createGenerationQueue({ guard: () => guard, changed: (jobs) => published.push(jobs) })
  const owner = {}
  const spec = (cueId: string, run: () => Promise<Take>, extra: Partial<GenerationSpec> = {}): GenerationSpec => ({
    kind: 'tts',
    cueId,
    origin: 'ui',
    chars: 5,
    owner,
    run,
    ...extra,
  })
  return { queue, owner, spec, published, guard }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('main generation queue', () => {
  it('runs one job at a time and records the take id', async () => {
    const { queue, spec } = setup()
    const first = deferred()
    const second = deferred()
    const a = queue.submit(spec('c1', () => first.promise))
    const b = queue.submit(spec('c2', () => second.promise, { origin: 'agent' }))
    expect(queue.list().map((j) => j.state)).toEqual(['running', 'queued'])
    first.resolve(take('t1'))
    expect(await a.done).toMatchObject({ id: 't1' })
    await flush()
    expect(queue.list().map((j) => [j.state, j.takeId])).toEqual([
      ['done', 't1'],
      ['running', undefined],
    ])
    second.reject(new Error('Provider said no'))
    await expect(b.done).rejects.toThrow('Provider said no')
    expect(queue.list()[1]).toMatchObject({ state: 'error', error: 'Provider said no', origin: 'agent', chars: 5 })
  })

  it('refuses a second job for a line that is queued or running, whoever submits it', () => {
    const { queue, spec } = setup()
    queue.submit(spec('c1', () => deferred().promise))
    queue.submit(spec('c2', () => deferred().promise))
    expect(() => queue.submit(spec('c1', () => deferred().promise, { origin: 'agent' }))).toThrow('The line is already generating')
    expect(() => queue.submit(spec('c2', () => deferred().promise))).toThrow('The line is already generating')
    expect(queue.busy('c1')).toBe(true)
    expect(queue.list()).toHaveLength(2)
  })

  it('refuses everything while an export or a restore runs and a line while it records', () => {
    const { queue, spec, guard } = setup()
    guard.exporting = true
    expect(() => queue.submit(spec('c1', () => deferred().promise))).toThrow('Export in progress')
    guard.exporting = false
    guard.restoring = true
    expect(() => queue.submit(spec('c1', () => deferred().promise))).toThrow('Restoring version')
    guard.restoring = false
    guard.recording = true
    expect(() => queue.submit(spec('c1', () => deferred().promise))).toThrow('The line is being recorded')
    expect(queue.list()).toEqual([])
  })

  it('cancels queued jobs only; the running one finishes', async () => {
    const { queue, spec } = setup()
    const first = deferred()
    const a = queue.submit(spec('c1', () => first.promise))
    const b = queue.submit(spec('c2', () => deferred().promise))
    expect(queue.cancel([a.id, b.id])).toEqual([b.id])
    await expect(b.done).rejects.toThrow(JOB_CANCELLED)
    first.resolve(take('t1'))
    await a.done
    expect(queue.list().map((j) => j.state)).toEqual(['done', 'cancelled'])
    expect(queue.busy('c2')).toBe(false)
  })

  it('a project switch drops the old project queued and finished jobs and keeps the running one', async () => {
    const { queue, spec, owner } = setup()
    const running = deferred()
    const done = queue.submit(spec('c0', () => Promise.resolve(take('t0'))))
    await done.done
    await flush()
    const a = queue.submit(spec('c1', () => running.promise))
    const b = queue.submit(spec('c2', () => deferred().promise))
    queue.retire({})
    await expect(b.done).rejects.toThrow(JOB_RETIRED)
    expect(queue.list().map((j) => [j.cueId, j.state])).toEqual([['c1', 'running']])
    running.resolve(take('t1'))
    await a.done
    await flush()
    const fresh = {}
    const c = queue.submit(spec('c2', () => Promise.resolve(take('t2')), { owner: fresh }))
    queue.retire(fresh)
    expect(queue.list().map((j) => j.id)).toEqual([c.id])
    expect(owner).not.toBe(fresh)
  })

  it('settle waits for the listed jobs, reports progress, and gives up at the timeout', async () => {
    const { queue, spec } = setup()
    const first = deferred()
    const a = queue.submit(spec('c1', () => first.promise))
    const b = queue.submit(spec('c2', () => deferred().promise))
    const progress: [number, number][] = []
    const waiting = queue.settle([a.id], 5000, new AbortController().signal, (done, total) => progress.push([done, total]))
    first.resolve(take('t1'))
    await waiting
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ])
    const started = Date.now()
    await queue.settle([b.id], 30, new AbortController().signal, () => undefined)
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
    const controller = new AbortController()
    const aborted = queue.settle([b.id], 60_000, controller.signal, () => undefined)
    controller.abort()
    await aborted
  })

  it('publishes every change', () => {
    const { queue, spec, published } = setup()
    queue.submit(spec('c1', () => deferred().promise))
    expect(published.at(-1)?.map((j) => j.state)).toEqual(['running'])
  })
})
