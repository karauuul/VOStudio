import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DurationQueue, type DurationEntry } from '../src/renderer/audio/duration-queue'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const entry = (takeId: string, duration = 1.5): DurationEntry => ({
  cueId: 'cue-1',
  takeId,
  duration,
})

describe('DurationQueue', () => {
  it('coalesces a burst of decodes into ONE call', () => {
    const flush = vi.fn()
    const q = new DurationQueue({ flush, debounceMs: 2000, maxWaitMs: 8000 })
    q.push(entry('t1'))
    vi.advanceTimersByTime(500)
    q.push(entry('t2'))
    vi.advanceTimersByTime(500)
    q.push(entry('t3'))
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0][0].map((e: DurationEntry) => e.takeId)).toEqual(['t1', 't2', 't3'])
  })

  it('the wait ceiling stops continuous scrolling from deferring the write forever', () => {
    const flush = vi.fn()
    const q = new DurationQueue({ flush, debounceMs: 2000, maxWaitMs: 5000 })
    for (let i = 0; i < 6; i++) {
      q.push(entry(`t${i}`))
      vi.advanceTimersByTime(1000)
    }
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0][0].map((e: DurationEntry) => e.takeId)).toEqual([
      't0',
      't1',
      't2',
      't3',
      't4',
    ])
    expect(q.size).toBe(1)
  })

  it('a full batch sends immediately, with no waiting', () => {
    const flush = vi.fn()
    const q = new DurationQueue({ flush, maxBatch: 3 })
    q.push(entry('t1'))
    q.push(entry('t2'))
    expect(flush).not.toHaveBeenCalled()
    q.push(entry('t3'))
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0][0].length).toBe(3)
  })

  it('the same take is not sent twice — neither inside a batch nor after it', () => {
    const flush = vi.fn()
    const q = new DurationQueue({ flush, debounceMs: 100 })
    expect(q.push(entry('t1', 1.5))).toBe(true)
    expect(q.push(entry('t1', 1.5))).toBe(false)
    expect(q.size).toBe(1)
    vi.advanceTimersByTime(200)
    expect(flush).toHaveBeenCalledTimes(1)

    expect(q.push(entry('t1', 1.5))).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('a zero / invalid duration is not queued', () => {
    const flush = vi.fn()
    const q = new DurationQueue({ flush, debounceMs: 100 })
    expect(q.push(entry('t1', 0))).toBe(false)
    expect(q.push(entry('t2', Number.NaN))).toBe(false)
    vi.advanceTimersByTime(500)
    expect(flush).not.toHaveBeenCalled()
  })

  it('after a failed flush the take can be sent again', async () => {
    const flush = vi.fn().mockRejectedValue(new Error('IPC down'))
    const q = new DurationQueue({ flush, debounceMs: 100 })
    q.push(entry('t1'))
    vi.advanceTimersByTime(200)
    expect(flush).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()

    expect(q.push(entry('t1'))).toBe(true)
    vi.advanceTimersByTime(200)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('flushNow on an empty queue sends nothing', () => {
    const flush = vi.fn()
    const q = new DurationQueue({ flush })
    void q.flushNow()
    expect(flush).not.toHaveBeenCalled()
  })

  it('flushNow returns a promise you can await the batch on', async () => {
    let settle!: () => void
    const landed = new Promise<void>((resolve) => (settle = resolve))
    const flush = vi.fn(() => landed)
    const q = new DurationQueue({ flush })
    q.push(entry('t1'))

    let done = false
    const flushed = q.flushNow().then(() => {
      done = true
    })
    expect(flush).toHaveBeenCalledTimes(1)
    expect(done).toBe(false)
    settle()
    await flushed
    expect(done).toBe(true)
  })

  it('reset forgets both the batch and the memory of already sent takes', () => {
    const flush = vi.fn()
    const q = new DurationQueue({ flush, debounceMs: 100 })
    q.push(entry('t1'))
    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(1)

    expect(q.push(entry('t1'))).toBe(false)

    q.reset()
    expect(q.push(entry('t1'))).toBe(true)
    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('reset drops the unfinished batch — it belonged to the previous project', () => {
    const flush = vi.fn()
    const q = new DurationQueue({ flush, debounceMs: 100 })
    q.push(entry('t1'))
    q.reset()
    vi.advanceTimersByTime(1000)
    expect(flush).not.toHaveBeenCalled()
    expect(q.size).toBe(0)
  })
})
