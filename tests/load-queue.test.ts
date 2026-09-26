import { describe, expect, it } from 'vitest'
import { LoadQueue } from '../src/shared/load-queue'

interface Call {
  key: string
  priority: number
  resolve: (v: string) => void
  reject: (e: unknown) => void
}

function harness(concurrency: number) {
  const calls: Call[] = []
  const queue = new LoadQueue<string>(concurrency, (key, priority) => {
    return new Promise<string>((resolve, reject) => calls.push({ key, priority, resolve, reject }))
  })
  const finish = async (key: string, value = `v:${key}`): Promise<void> => {
    const call = calls.find((c) => c.key === key)
    if (!call) throw new Error(`not started: ${key}`)
    call.resolve(value)
    await flush()
  }
  return { calls, queue, finish, started: () => calls.map((c) => c.key) }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('LoadQueue', () => {
  it('never runs more than the concurrency limit at once', async () => {
    const { queue, started, finish } = harness(4)
    const all = Array.from({ length: 10 }, (_, i) => queue.load(`k${i}`))
    expect(started()).toEqual(['k0', 'k1', 'k2', 'k3'])
    await finish('k1')
    expect(started()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4'])
    for (let i = 0; i < 10; i++) if (i !== 1) await finish(`k${i}`)
    expect(await Promise.all(all)).toEqual(Array.from({ length: 10 }, (_, i) => `v:k${i}`))
  })

  it('runs a key once for every waiter, queued or running', async () => {
    const { queue, started, finish } = harness(1)
    const a1 = queue.load('a')
    const b1 = queue.load('b')
    const b2 = queue.load('b')
    const a2 = queue.load('a')
    await finish('a')
    await finish('b')
    expect(started()).toEqual(['a', 'b'])
    expect(await Promise.all([a1, a2, b1, b2])).toEqual(['v:a', 'v:a', 'v:b', 'v:b'])
  })

  it('serves higher priority first and keeps arrival order within a priority', async () => {
    const { queue, started, finish } = harness(1)
    void queue.load('busy')
    void queue.load('bg1', { priority: 0 })
    void queue.load('bg2', { priority: 0 })
    void queue.load('fg1', { priority: 1 })
    void queue.load('fg2', { priority: 1 })
    for (const k of ['busy', 'fg1', 'fg2', 'bg1']) await finish(k)
    expect(started()).toEqual(['busy', 'fg1', 'fg2', 'bg1', 'bg2'])
  })

  it('upgrades a queued key when a higher-priority waiter joins and runs it with that priority', async () => {
    const { queue, calls, finish } = harness(1)
    void queue.load('busy')
    void queue.load('a', { priority: 0 })
    void queue.load('b', { priority: 0 })
    void queue.load('b', { priority: 1 })
    await finish('busy')
    expect(calls.map((c) => [c.key, c.priority])).toEqual([
      ['busy', 0],
      ['b', 1],
    ])
  })

  it('drops a queued key once its only waiter aborts', async () => {
    const { queue, started, finish } = harness(1)
    void queue.load('busy')
    const ctl = new AbortController()
    const gone = queue.load('a', { signal: ctl.signal })
    void queue.load('b')
    ctl.abort()
    await expect(gone).rejects.toMatchObject({ name: 'AbortError' })
    await finish('busy')
    expect(started()).toEqual(['busy', 'b'])
  })

  it('keeps a queued key while another waiter still wants it', async () => {
    const { queue, started, finish } = harness(1)
    void queue.load('busy')
    const ctl = new AbortController()
    const aborted = queue.load('a', { signal: ctl.signal })
    const kept = queue.load('a')
    ctl.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    await finish('busy')
    await finish('a')
    expect(started()).toEqual(['busy', 'a'])
    expect(await kept).toBe('v:a')
  })

  it('lets a running load finish for the others when one waiter aborts', async () => {
    const { queue, finish } = harness(1)
    const ctl = new AbortController()
    const aborted = queue.load('a', { signal: ctl.signal })
    const kept = queue.load('a')
    ctl.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    await finish('a')
    expect(await kept).toBe('v:a')
  })

  it('rejects at once for an already aborted signal without running', async () => {
    const { queue, started } = harness(1)
    const ctl = new AbortController()
    ctl.abort()
    await expect(queue.load('a', { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(started()).toEqual([])
  })

  it('rejects every waiter on failure, frees the slot and retries on the next load', async () => {
    const { queue, calls, started, finish } = harness(1)
    const a1 = queue.load('a')
    const a2 = queue.load('a')
    void queue.load('b')
    calls[0].reject(new Error('decode failed'))
    await expect(a1).rejects.toThrow('decode failed')
    await expect(a2).rejects.toThrow('decode failed')
    await flush()
    expect(started()).toEqual(['a', 'b'])
    await finish('b')
    const again = queue.load('a')
    expect(started()).toEqual(['a', 'b', 'a'])
    calls[2].resolve('ok')
    expect(await again).toBe('ok')
  })

  it('turns a synchronous throw into a rejection', async () => {
    const queue = new LoadQueue<string>(1, () => {
      throw new Error('boom')
    })
    await expect(queue.load('a')).rejects.toThrow('boom')
    await expect(queue.load('a')).rejects.toThrow('boom')
  })

  it('starts a fresh run when a waiter reloads the same key on completion', async () => {
    const { queue, started, calls } = harness(1)
    const reloaded = queue.load('a').then(() => queue.load('a'))
    calls[0].resolve('first')
    await flush()
    expect(started()).toEqual(['a', 'a'])
    calls[1].resolve('second')
    expect(await reloaded).toBe('second')
  })
})
