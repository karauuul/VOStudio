import { describe, expect, it } from 'vitest'
import {
  clampView,
  clipAt,
  EDGE_PX,
  fitView,
  hitTest,
  HANDLE_PX,
  regionHit,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  snap,
  snapDelta,
  snapTargets,
  tickLabel,
  ticks,
  tickStep,
  timeToX,
  xToTime,
  zoomAt,
  type HitClip,
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

  it('targets exclude the edges of the clip being dragged', () => {
    const clips = [
      { id: 'a', start: 0, end: 1 },
      { id: 'b', start: 2, end: 3 },
    ]
    const t = snapTargets(clips, 'b', [5])
    expect(t).toEqual([0, 1, 5])
  })

  it('targets are unique and sorted', () => {
    const clips = [
      { id: 'a', start: 0, end: 1 },
      { id: 'b', start: 1, end: 2 },
    ]
    expect(snapTargets(clips, null, [0, 2])).toEqual([0, 1, 2])
  })
})

describe('hit test', () => {
  const clips: HitClip[] = [
    { id: 'a', start: 0, end: 2, fadeIn: 0, fadeOut: 0, crossfade: 0 },
    { id: 'b', start: 3, end: 5, fadeIn: 0.5, fadeOut: 0.5, crossfade: 0 },
  ]
  const pps = 100

  it('empty space between clips hits nothing', () => {
    expect(hitTest(clips, 2.5, pps, false)).toBeNull()
  })

  it('clip body', () => {
    expect(hitTest(clips, 1, pps, false)).toEqual({ kind: 'clip', id: 'a' })
  })

  it('clip edge = trim, and exactly within the EDGE_PX zone', () => {
    expect(hitTest(clips, 2 - (EDGE_PX - 1) / pps, pps, false)).toEqual({
      kind: 'trimEnd',
      id: 'a',
    })
    expect(hitTest(clips, 3 + (EDGE_PX - 1) / pps, pps, false)).toEqual({
      kind: 'trimStart',
      id: 'b',
    })
  })

  it('the top band near the corner = fade, not trim', () => {
    expect(hitTest(clips, 0, pps, true)).toEqual({ kind: 'fadeIn', id: 'a' })
    expect(hitTest(clips, 0, pps, false)).toEqual({ kind: 'trimStart', id: 'a' })
  })

  it('the fade handle follows the fade peak', () => {
    expect(hitTest(clips, 3.5, pps, true)).toEqual({ kind: 'fadeIn', id: 'b' })
    expect(hitTest(clips, 4.5, pps, true)).toEqual({ kind: 'fadeOut', id: 'b' })
  })

  it('at a tight joint the right clip wins', () => {
    const tight: HitClip[] = [
      { id: 'l', start: 0, end: 1, fadeIn: 0, fadeOut: 0, crossfade: 0 },
      { id: 'r', start: 1, end: 2, fadeIn: 0, fadeOut: 0, crossfade: 0 },
    ]
    expect(hitTest(tight, 1, pps, false)).toEqual({ kind: 'trimStart', id: 'r' })
  })

  it('degenerate zoom does not throw', () => {
    expect(hitTest(clips, 1, 0, false)).toBeNull()
  })

  it('clipAt takes the clip under the playhead, joints do not count', () => {
    expect(clipAt(clips, 1)).toBe('a')
    expect(clipAt(clips, 2)).toBeNull()
    expect(clipAt(clips, 2.5)).toBeNull()
  })
})

describe('crossfade in the hit test', () => {
  const pps = 100
  const withXf: HitClip[] = [
    { id: 'l', start: 0, end: 1, fadeIn: 0, fadeOut: 0, crossfade: 0.2 },
    { id: 'r', start: 1, end: 2, fadeIn: 0, fadeOut: 0, crossfade: 0 },
  ]

  it('the crossfade zone belongs to the transition, not to the trims', () => {
    expect(hitTest(withXf, 0.9, pps, false)).toEqual({ kind: 'crossfade', id: 'l' })
    expect(hitTest(withXf, 1, pps, false)).toEqual({ kind: 'crossfade', id: 'l' })
  })

  it('outside the crossfade everything stays as before', () => {
    expect(hitTest(withXf, 0.5, pps, false)).toEqual({ kind: 'clip', id: 'l' })
    expect(hitTest(withXf, 1.5, pps, false)).toEqual({ kind: 'clip', id: 'r' })
  })

  it('the top band stays with the fades: the crossfade does not steal it', () => {
    expect(hitTest(withXf, 1, pps, true)).toEqual({ kind: 'fadeIn', id: 'r' })
    expect(hitTest(withXf, 0.9, pps, true)).toEqual({ kind: 'clip', id: 'l' })
  })

  it('a zero crossfade gives no handle', () => {
    const flat: HitClip[] = [
      { id: 'l', start: 0, end: 1, fadeIn: 0, fadeOut: 0, crossfade: 0 },
      { id: 'r', start: 1, end: 2, fadeIn: 0, fadeOut: 0, crossfade: 0 },
    ]
    expect(hitTest(flat, 1, pps, false)).toEqual({ kind: 'trimStart', id: 'r' })
  })
})

describe('region band on the ruler', () => {
  const pps = 100
  const region = { in: 1, out: 3 }

  it('with no region any press starts a new one', () => {
    expect(regionHit(undefined, 2, pps)).toBe('new')
  })

  it('edges take priority over «create new»', () => {
    expect(regionHit(region, 1, pps)).toBe('in')
    expect(regionHit(region, 3, pps)).toBe('out')
    expect(regionHit(region, 3 - (HANDLE_PX - 1) / pps, pps)).toBe('out')
  })

  it('inside the region but far from the edges — new', () => {
    expect(regionHit(region, 2, pps)).toBe('new')
  })

  it('degenerate zoom does not throw', () => {
    expect(regionHit(region, 1, 0)).toBe('new')
  })
})
