import { describe, expect, it } from 'vitest'
import { pickHistory, redoStale } from '../src/shared/undo-route'

describe('undo routing between comp and take-effect histories', () => {
  it('undoes the newer entry first', () => {
    expect(pickHistory({ comp: 10, fx: 20 }, 'undo')).toBe('fx')
    expect(pickHistory({ comp: 30, fx: 20 }, 'undo')).toBe('comp')
  })

  it('redoes the older entry first', () => {
    expect(pickHistory({ comp: 10, fx: 20 }, 'redo')).toBe('comp')
    expect(pickHistory({ comp: 30, fx: 20 }, 'redo')).toBe('fx')
  })

  it('falls back to the non-empty history', () => {
    expect(pickHistory({ comp: null, fx: 5 }, 'undo')).toBe('fx')
    expect(pickHistory({ comp: 5, fx: null }, 'undo')).toBe('comp')
    expect(pickHistory({ comp: null, fx: 5 }, 'redo')).toBe('fx')
    expect(pickHistory({ comp: 5, fx: null }, 'redo')).toBe('comp')
  })

  it('returns null when both are empty', () => {
    expect(pickHistory({ comp: null, fx: null }, 'undo')).toBe(null)
    expect(pickHistory({ comp: null, fx: null }, 'redo')).toBe(null)
  })

  it('resolves ties to comp in both directions', () => {
    expect(pickHistory({ comp: 7, fx: 7 }, 'undo')).toBe('comp')
    expect(pickHistory({ comp: 7, fx: 7 }, 'redo')).toBe('comp')
  })

  it('marks a redo entry stale once the other history committed after it', () => {
    expect(redoStale(20, 30)).toBe(true)
    expect(redoStale(30, 20)).toBe(false)
    expect(redoStale(20, 20)).toBe(false)
    expect(redoStale(null, 30)).toBe(false)
    expect(redoStale(20, null)).toBe(false)
  })

  it('replays an interleaved session in order', () => {
    const comp = [1, 3]
    const fx = [2]
    const order: string[] = []
    for (let i = 0; i < 3; i++) {
      const side = pickHistory(
        { comp: comp[comp.length - 1] ?? null, fx: fx[fx.length - 1] ?? null },
        'undo'
      )
      if (side === 'comp') order.push(`comp${comp.pop()}`)
      else if (side === 'fx') order.push(`fx${fx.pop()}`)
    }
    expect(order).toEqual(['comp3', 'fx2', 'comp1'])
  })
})
