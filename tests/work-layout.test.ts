import { describe, expect, it } from 'vitest'
import { fitWorkPanes } from '../src/shared/work-layout'

const mins = { lines: 240, props: 320, prog: 480 }
const stored = { lines: 280, props: 380, prog: 620 }

describe('fitWorkPanes', () => {
  it('keeps stored widths when the window is wide enough', () => {
    expect(fitWorkPanes(stored, mins, 1896, 320)).toEqual(stored)
  })

  it('shrinks program first, then properties, then lines', () => {
    expect(fitWorkPanes(stored, mins, 1500, 320)).toEqual({ lines: 280, props: 380, prog: 520 })
    expect(fitWorkPanes(stored, mins, 1400, 320)).toEqual({ lines: 280, props: 320, prog: 480 })
    expect(fitWorkPanes(stored, mins, 1380, 320)).toEqual({ lines: 260, props: 320, prog: 480 })
  })

  it('leaves room for the text pane at 1440', () => {
    const fitted = fitWorkPanes(stored, mins, 1440 - 16 - 24, 320)
    expect(1440 - 16 - 24 - fitted.lines - fitted.props - fitted.prog).toBeGreaterThanOrEqual(320)
  })

  it('never goes below the minimums', () => {
    expect(fitWorkPanes(stored, mins, 800, 320)).toEqual(mins)
  })
})
