import { describe, expect, it } from 'vitest'
import { Lru } from '../src/renderer/audio/lru'

describe('Lru', () => {
  it('evicts the least recently used entry on overflow', () => {
    const c = new Lru<number>({ maxEntries: 3 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.set('d', 4)
    expect(c.keys()).toEqual(['b', 'c', 'd'])
    expect(c.has('a')).toBe(false)
    expect(c.size).toBe(3)
  })

  it('get refreshes recency, peek does not', () => {
    const c = new Lru<number>({ maxEntries: 3 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    expect(c.get('a')).toBe(1)
    c.set('d', 4)
    expect(c.keys()).toEqual(['c', 'a', 'd'])

    const c2 = new Lru<number>({ maxEntries: 2 })
    c2.set('a', 1)
    c2.set('b', 2)
    expect(c2.peek('a')).toBe(1)
    c2.set('c', 3)
    expect(c2.has('a')).toBe(false)
  })

  it('holds the WEIGHT ceiling, not just the count', () => {
    const c = new Lru<number>({ maxEntries: 100, maxCost: 100, cost: (v) => v })
    c.set('a', 40)
    c.set('b', 40)
    expect(c.cost).toBe(80)
    c.set('big', 90)
    expect(c.keys()).toEqual(['big'])
    expect(c.cost).toBe(90)
  })

  it('does not evict pinned entries', () => {
    const c = new Lru<number>({ maxEntries: 2 })
    c.set('playing', 1)
    c.pin('playing')
    c.set('b', 2)
    c.set('c', 3)
    c.set('d', 4)
    expect(c.has('playing')).toBe(true)
    c.unpin('playing')
    c.set('e', 5)
    expect(c.has('playing')).toBe(false)
  })

  it('delete adjusts the weight and returns whether there was anything to delete', () => {
    const c = new Lru<number>({ maxEntries: 4, maxCost: 100, cost: (v) => v })
    c.set('a', 10)
    c.set('b', 20)
    expect(c.delete('a')).toBe(true)
    expect(c.delete('a')).toBe(false)
    expect(c.cost).toBe(20)
    c.clear()
    expect(c.size).toBe(0)
    expect(c.cost).toBe(0)
  })

  it('overwriting a key does not double the weight', () => {
    const c = new Lru<number>({ maxEntries: 4, maxCost: 100, cost: (v) => v })
    c.set('a', 10)
    c.set('a', 30)
    expect(c.size).toBe(1)
    expect(c.cost).toBe(30)
  })
})
