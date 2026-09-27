import { describe, expect, it } from 'vitest'
import { offsetPage, stablePage } from '../src/shared/agent-lines'
import type { Cue } from '../src/shared/domain'

const cues = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}` }) as Cue)

describe('stablePage', () => {
  it('resumes by project position when earlier items leave the selection', () => {
    const first = stablePage(cues, (cue) => cue, cues, undefined, 2)
    expect(first.page.map((c) => c.id)).toEqual(['c0', 'c1'])
    expect(first.nextCursor).toBe('2')
    const shrunk = cues.slice(2)
    const second = stablePage(shrunk, (cue) => cue, cues, first.nextCursor, 2)
    expect(second.page.map((c) => c.id)).toEqual(['c2', 'c3'])
    expect(second.nextCursor).toBe('4')
    expect(stablePage(cues.slice(4), (cue) => cue, cues, second.nextCursor, 2)).toEqual({ page: [cues[4], cues[5]] })
  })

  it('rejects a cursor past the project', () => {
    expect(() => stablePage(cues, (cue) => cue, cues, '7', 2)).toThrow(/Invalid cursor/)
  })
})

describe('offsetPage', () => {
  it('pages an explicit list by offset', () => {
    expect(offsetPage([1, 2, 3], undefined, 2)).toEqual({ page: [1, 2], nextCursor: '2' })
    expect(offsetPage([1, 2, 3], '2', 2)).toEqual({ page: [3] })
  })
})
