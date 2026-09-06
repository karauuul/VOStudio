import { describe, expect, it } from 'vitest'
import {
  clampView,
  fitView,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  snap,
  snapDelta,
  tickLabel,
  ticks,
  tickStep,
  timeToX,
  xToTime,
  zoomAt,
  type TimelineView,
} from '../src/renderer/cue/timeline-math'

const view = (pxPerSec: number, scroll = 0): TimelineView => ({ pxPerSec, scroll })

describe('coordinates', () => {
  it('timeToX and xToTime are mutual inverses', () => {
    const v = view(120, 3.25)
    for (const t of [0, 1, 3.25, 7.5, 100]) {
      expect(xToTime(v, timeToX(v, t))).toBeCloseTo(t, 9)
    }
  })

  it('the left edge of the track is scroll', () => {
    expect(xToTime(view(50, 2), 0)).toBe(2)
    expect(timeToX(view(50, 2), 2)).toBe(0)
  })
})

describe('fitView', () => {
  it('fits the whole duration into the width with padding', () => {
    const v = fitView(10, 1024, 24)
    expect(timeToX(v, 10)).toBeCloseTo(1000, 6)
    expect(v.scroll).toBe(0)
  })

  it('stays within the zoom limits on degenerate inputs', () => {
    for (const [d, w] of [
      [0, 800],
      [-5, 800],
      [1e9, 800],
      [1e-9, 800],
    ]) {
      const v = fitView(d, w)
      expect(v.pxPerSec).toBeGreaterThanOrEqual(MIN_PX_PER_SEC)
      expect(v.pxPerSec).toBeLessThanOrEqual(MAX_PX_PER_SEC)
    }
  })
})

describe('zoomAt', () => {
  it('keeps the second under the cursor in place', () => {
    const v = view(100, 4)
    const anchor = 250
    const t = xToTime(v, anchor)
    for (const f of [1.2, 0.8, 3, 0.3]) {
      const z = zoomAt(v, f, anchor)
      expect(xToTime(z, anchor)).toBeCloseTo(t, 9)
    }
  })

  it('the zoom ceiling and floor hold, and the anchor still stays in place', () => {
    const deep = zoomAt(view(MAX_PX_PER_SEC, 1), 10, 100)
    expect(deep.pxPerSec).toBe(MAX_PX_PER_SEC)
    expect(xToTime(deep, 100)).toBeCloseTo(xToTime(view(MAX_PX_PER_SEC, 1), 100), 9)

    const far = zoomAt(view(MIN_PX_PER_SEC, 0), 0.01, 100)
    expect(far.pxPerSec).toBe(MIN_PX_PER_SEC)
  })
})

describe('clampView', () => {
  it('does not let scroll go negative', () => {
    expect(clampView(view(100, -50), 800, 10).scroll).toBe(0)
  })

  it('all the content is narrower than the window — scroll is always zero', () => {
    expect(clampView(view(100, 5), 800, 2).scroll).toBe(0)
  })

  it('leaves exactly tailPad pixels of empty space on the right', () => {
    const c = clampView(view(100, 1e6), 800, 20, 40)
    expect(c.scroll).toBeCloseTo(20 + 40 / 100 - 800 / 100, 9)
  })
})

describe('ruler', () => {
  it('the step grows as the zoom shrinks', () => {
    const a = tickStep(400)
    const b = tickStep(40)
    const c = tickStep(4)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
  })

  it('never less than minPx between ticks', () => {
    for (const pps of [3, 17, 60, 250, 1400]) {
      expect(tickStep(pps, 64) * pps).toBeGreaterThanOrEqual(64 - 1e-9)
    }
  })

  it('ticks cover the window and do not go past it', () => {
    const v = view(100, 3.1)
    const t = ticks(v, 500)
    expect(t.length).toBeGreaterThan(0)
    for (const x of t) {
      expect(x).toBeGreaterThanOrEqual(v.scroll - 1e-9)
      expect(x).toBeLessThanOrEqual(v.scroll + 500 / v.pxPerSec + 1e-9)
    }
  })

  it('there are never negative ticks', () => {
    for (const x of ticks(view(100, -2), 500)) expect(x).toBeGreaterThanOrEqual(0)
  })

  it('the label reads as time', () => {
    expect(tickLabel(30, 1)).toBe('30s')
    expect(tickLabel(90, 30)).toBe('1:30')
    expect(tickLabel(1.25, 0.05)).toBe('1.25')
  })
})

describe('snapping', () => {
  it('snaps within the tolerance and does nothing outside it', () => {
    expect(snap(1.02, [1, 2], 0.05)).toBe(1)
    expect(snap(1.2, [1, 2], 0.05)).toBe(1.2)
  })

  it('the nearest target wins', () => {
    expect(snap(1.4, [1, 1.5, 2], 1)).toBe(1.5)
  })

  it('zero tolerance moves nothing', () => {
    expect(snap(1.02, [1], 0)).toBe(1.02)
  })

  it('snapDelta sticks with whichever edge is closer', () => {
    expect(snapDelta([0, 2], 0.98, [3], 0.05)).toBeCloseTo(1, 9)
    expect(snapDelta([0, 2], 1.03, [1], 0.05)).toBeCloseTo(1, 9)
  })

  it('snapDelta never moves further than the tolerance', () => {
    const d = snapDelta([0, 2], 1.5, [3, 10], 0.05)
    expect(Math.abs(d - 1.5)).toBeLessThanOrEqual(0.05 + 1e-9)
  })
})
