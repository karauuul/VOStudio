import { describe, expect, it } from 'vitest'
import { fitWorkPanes } from '../src/shared/work-layout'

const comfort = { lines: 240, props: 320, prog: 480 }
const hard = { lines: 224, props: 296, prog: 400 }
const tiers = [comfort, hard]
const stored = { lines: 280, props: 380, prog: 620 }
const available = (window: number): number => window - 16 - 24

describe('fitWorkPanes', () => {
  it('keeps stored widths when the window is wide enough', () => {
    expect(fitWorkPanes(stored, tiers, 1896, 320)).toEqual(stored)
  })

  it('shrinks program first, then properties, then lines', () => {
    expect(fitWorkPanes(stored, tiers, 1500, 320)).toEqual({ lines: 280, props: 380, prog: 520 })
    expect(fitWorkPanes(stored, tiers, 1400, 320)).toEqual({ lines: 280, props: 320, prog: 480 })
    expect(fitWorkPanes(stored, tiers, 1380, 320)).toEqual({ lines: 260, props: 320, prog: 480 })
  })

  it('leaves room for the text pane at 1440', () => {
    const fitted = fitWorkPanes(stored, tiers, available(1440), 320)
    expect(available(1440) - fitted.lines - fitted.props - fitted.prog).toBeGreaterThanOrEqual(320)
  })

  it('keeps the 1400 px layout on the comfortable minimums', () => {
    expect(fitWorkPanes(stored, tiers, available(1400), 320)).toEqual(comfort)
  })

  it('goes below the comfortable minimums only when they no longer fit, in the same order', () => {
    expect(fitWorkPanes(stored, tiers, available(1360), 320)).toEqual({ ...comfort, prog: 440 })
    expect(fitWorkPanes(stored, tiers, available(1280), 320)).toEqual(hard)
  })

  it('leaves room for the text pane at 1280', () => {
    const fitted = fitWorkPanes(stored, tiers, available(1280), 320)
    expect(available(1280) - fitted.lines - fitted.props - fitted.prog).toBe(320)
  })

  it('a fitted layout with a narrower pane stays as is, so the freed width goes to text', () => {
    const fitted = fitWorkPanes(stored, tiers, available(1440), 320)
    const dragged = { ...fitted, lines: fitted.lines - 40 }
    expect(fitWorkPanes(dragged, tiers, available(1440), 320)).toEqual(dragged)
  })

  it('a pane dragged below the comfortable minimum is not widened back', () => {
    const dragged = { ...stored, prog: 420 }
    expect(fitWorkPanes(dragged, tiers, available(1280), 320).prog).toBe(400)
    expect(fitWorkPanes(dragged, tiers, available(1400), 320)).toEqual({ lines: 280, props: 340, prog: 420 })
  })

  it('never goes below the last tier', () => {
    expect(fitWorkPanes(stored, tiers, 800, 320)).toEqual(hard)
  })

  it('a single tier behaves as before', () => {
    expect(fitWorkPanes(stored, [comfort], 800, 320)).toEqual(comfort)
  })
})
