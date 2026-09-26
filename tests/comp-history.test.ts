import { describe, expect, it } from 'vitest'
import { emptyEdits, type CueComp } from '../src/shared/domain'
import {
  COMP_HISTORY_LIMIT,
  nextCompEdit,
  pruneCompHistory,
  recordCompEdit,
  stepCompEdit,
  type CompHistory,
} from '../src/shared/comp-history'
import { pickHistory } from '../src/shared/undo-route'
import type { StepDir } from '../src/shared/line-history'

const comp = (...starts: number[]): CueComp => ({
  clips: starts.map((start, i) => ({ id: `c${i}`, sourceTakeId: 't', srcIn: 0, srcOut: 1, start, edits: emptyEdits() })),
})

function timeline(lines: Record<string, CueComp | null>) {
  const history: CompHistory = new Map()
  const edit = (cueId: string, next: CueComp | null, at: number): void => {
    recordCompEdit(history, cueId, lines[cueId], at)
    lines[cueId] = next
  }
  const step = (dir: StepDir): string | null => {
    const target = nextCompEdit(history, dir)
    if (!target) return null
    const entry = stepCompEdit(history, target.cueId, dir, lines[target.cueId])
    if (!entry) return null
    lines[target.cueId] = entry.value
    return target.cueId
  }
  return { history, lines, edit, step }
}

describe('timeline history kept per line', () => {
  it('undoes the newest edit across lines and redoes in reverse order', () => {
    const t = timeline({ a: comp(0), b: comp(0) })
    t.edit('a', comp(0, 1), 10)
    t.edit('b', comp(0, 2), 20)
    expect(t.step('undo')).toBe('b')
    expect(t.lines).toEqual({ a: comp(0, 1), b: comp(0) })
    expect(t.step('undo')).toBe('a')
    expect(t.lines).toEqual({ a: comp(0), b: comp(0) })
    expect(t.step('undo')).toBeNull()
    expect(t.step('redo')).toBe('a')
    expect(t.lines).toEqual({ a: comp(0, 1), b: comp(0) })
    expect(t.step('redo')).toBe('b')
    expect(t.lines).toEqual({ a: comp(0, 1), b: comp(0, 2) })
    expect(t.step('redo')).toBeNull()
  })

  it('keeps the original time of an entry across undo and redo', () => {
    const t = timeline({ a: null })
    t.edit('a', comp(0), 10)
    t.step('undo')
    expect(nextCompEdit(t.history, 'redo')).toEqual({ cueId: 'a', at: 10 })
    t.step('redo')
    expect(nextCompEdit(t.history, 'undo')).toEqual({ cueId: 'a', at: 10 })
    expect(t.lines.a).toEqual(comp(0))
  })

  it('a new edit on any line clears redo on every line', () => {
    const t = timeline({ a: comp(0), b: comp(0) })
    t.edit('a', comp(0, 1), 10)
    t.edit('b', comp(0, 2), 20)
    t.step('undo')
    t.step('undo')
    t.edit('b', comp(0, 3), 30)
    expect(nextCompEdit(t.history, 'redo')).toBeNull()
    expect(t.step('redo')).toBeNull()
    expect(t.lines).toEqual({ a: comp(0), b: comp(0, 3) })
  })

  it('steps nothing on a line without entries', () => {
    const t = timeline({ a: comp(0) })
    t.edit('a', comp(0, 1), 10)
    expect(stepCompEdit(t.history, 'b', 'undo', null)).toBeUndefined()
    expect(stepCompEdit(t.history, 'a', 'redo', comp(0, 1))).toBeUndefined()
    expect(t.history.get('a')).toEqual({ undo: [{ value: comp(0), at: 10 }], redo: [] })
  })

  it('caps each line on its own', () => {
    const t = timeline({ a: null, b: null })
    for (let i = 0; i < COMP_HISTORY_LIMIT + 5; i++) t.edit('a', comp(i), i)
    t.edit('b', comp(0), 1000)
    expect(t.history.get('a')?.undo).toHaveLength(COMP_HISTORY_LIMIT)
    expect(t.history.get('a')?.undo[0].at).toBe(5)
    expect(t.history.get('b')?.undo).toHaveLength(1)
  })

  it('drops the stacks of removed lines only', () => {
    const t = timeline({ a: null, b: null })
    t.edit('a', comp(0), 1)
    t.edit('b', comp(0), 2)
    pruneCompHistory(t.history, ['a'])
    expect([...t.history.keys()]).toEqual(['a'])
    expect(t.step('undo')).toBe('a')
  })

  it('interleaves with the line history by time', () => {
    const t = timeline({ a: comp(0), b: comp(0) })
    const lineUndo = [5]
    t.edit('a', comp(0, 1), 10)
    t.edit('b', comp(0, 2), 20)
    const order: string[] = []
    for (let i = 0; i < 3; i++) {
      const side = pickHistory({ comp: nextCompEdit(t.history, 'undo')?.at ?? null, fx: null, line: lineUndo[lineUndo.length - 1] ?? null }, 'undo')
      if (side === 'comp') order.push(`comp:${t.step('undo')}`)
      else if (side === 'line') order.push(`line:${lineUndo.pop()}`)
    }
    expect(order).toEqual(['comp:b', 'comp:a', 'line:5'])
  })
})
