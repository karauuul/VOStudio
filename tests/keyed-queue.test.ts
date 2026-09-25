import { describe, expect, it } from 'vitest'
import { keyedQueue } from '../src/shared/keyed-queue'
import { placeTake } from '../src/shared/generation'
import type { CueComp } from '../src/shared/domain'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

function line() {
  let comp: CueComp | undefined
  const place = async (takeId: string, duration: number): Promise<void> => {
    const base = comp
    await tick()
    comp = placeTake({ comp: base, takeId, duration, targetTrackId: undefined, playhead: 0 }).comp
  }
  return { place, clips: () => (comp?.clips ?? []).map((c) => c.sourceTakeId).sort() }
}

describe('per-line placement queue', () => {
  it('two concurrent placements on one line both end up in the composition', async () => {
    const queue = keyedQueue()
    const target = line()
    await Promise.all([queue('c', () => target.place('t1', 1)), queue('c', () => target.place('t2', 2))])
    expect(target.clips()).toEqual(['t1', 't2'])
  })

  it('without the queue the later placement overwrites the earlier one', async () => {
    const target = line()
    await Promise.all([target.place('t1', 1), target.place('t2', 2)])
    expect(target.clips()).toHaveLength(1)
  })

  it('runs in order per key, keeps going after a failure, and lets other keys run alongside', async () => {
    const queue = keyedQueue()
    const order: string[] = []
    const step = (name: string, fail = false) => async (): Promise<string> => {
      order.push(`start ${name}`)
      await tick()
      order.push(`end ${name}`)
      if (fail) throw new Error(name)
      return name
    }
    const results = await Promise.allSettled([queue('a', step('a1', true)), queue('a', step('a2')), queue('b', step('b1'))])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
    expect(order.indexOf('end a1')).toBeLessThan(order.indexOf('start a2'))
    expect(order.indexOf('start b1')).toBeLessThan(order.indexOf('end a1'))
  })
})
