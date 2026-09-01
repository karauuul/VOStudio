import { describe, expect, it } from 'vitest'
import {
  clipEnd,
  compRenderPlan,
  crossfadeRoom,
  effectiveCrossfade,
  findInsertSlot,
  insertClipFromTake,
  maxCrossfade,
  setCrossfade,
  setRegion,
  setRegionEdge,
  clipTimelineDuration,
  compClipEdits,
  compDuration,
  COMP_EPS,
  compProblem,
  defaultCompFromTake,
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  isEmptyComp,
  moveClip,
  MIN_CLIP_SRC,
  normalizeComp,
  canHeal,
  healableAt,
  healCut,
  removeClip,
  replaceClipSource,
  setClipEdits,
  SPEED_MAX,
  SPEED_MIN,
  splitClipAt,
  trimClipEdge,
} from '../src/shared/comp'
import { emptyEdits, type ClipEdits, type CompClip, type CueComp } from '../src/shared/domain'

const edits = (over: Partial<ClipEdits> = {}): ClipEdits => ({ ...emptyEdits(), ...over })

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'a',
  sourceTakeId: 't1',
  srcIn: 0,
  srcOut: 1,
  start: 0,
  edits: emptyEdits(),
  ...over,
})

const comp = (...clips: CompClip[]): CueComp => ({ clips })

const expectValid = (c: CueComp): void => expect(compProblem(c)).toBeNull()

describe('durations: two scales and the speed between them', () => {
  it('timeline = source / speed', () => {
    expect(clipTimelineDuration(clip({ srcIn: 1, srcOut: 3 }))).toBe(2)
    expect(clipTimelineDuration(clip({ srcIn: 1, srcOut: 3, edits: edits({ timeStretch: 2 }) }))).toBe(1)
    expect(clipTimelineDuration(clip({ srcIn: 1, srcOut: 3, edits: edits({ timeStretch: 0.5 }) }))).toBe(4)
  })

  it('broken speed values degrade to 1, not to NaN', () => {
    expect(clipTimelineDuration(clip({ srcOut: 2, edits: edits({ timeStretch: 0 }) }))).toBe(2)
    expect(clipTimelineDuration(clip({ srcOut: 2, edits: edits({ timeStretch: NaN }) }))).toBe(2)
    expect(clipTimelineDuration(clip({ srcOut: 2, edits: edits({ timeStretch: -3 }) }))).toBe(2)
  })

  it('a degenerate clip has zero length, not a negative one', () => {
    expect(clipTimelineDuration(clip({ srcIn: 3, srcOut: 1 }))).toBe(0)
  })

  it('comp duration goes by the last clip, silence inside counts', () => {
    const c = comp(clip({ id: 'a', srcOut: 1 }), clip({ id: 'b', srcIn: 0, srcOut: 2, start: 5 }))
    expect(compDuration(c)).toBe(7)
    expect(compDuration({ clips: [] })).toBe(0)
  })

  it('isEmptyComp', () => {
    expect(isEmptyComp(undefined)).toBe(true)
    expect(isEmptyComp({ clips: [] })).toBe(true)
    expect(isEmptyComp(comp(clip()))).toBe(false)
  })
})

describe('compClipEdits — srcIn/srcOut REPLACE the trims', () => {
  it('converts the source window into trimStart/trimEnd', () => {
    const e = compClipEdits(clip({ srcIn: 1, srcOut: 3 }), 10)
    expect(e.trimStart).toBe(1)
    expect(e.trimEnd).toBe(7)
  })

  it('trims on the clip itself are ignored, the rest of edits passes through as is', () => {
    const e = compClipEdits(
      clip({ srcIn: 2, srcOut: 4, edits: edits({ trimStart: 9, trimEnd: 9, gainDb: -6 }) }),
      10
    )
    expect(e.trimStart).toBe(2)
    expect(e.trimEnd).toBe(6)
    expect(e.gainDb).toBe(-6)
  })

  it('srcOut past the buffer clamps instead of giving a negative trimEnd', () => {
    const e = compClipEdits(clip({ srcIn: 1, srcOut: 99 }), 5)
    expect(e.trimStart).toBe(1)
    expect(e.trimEnd).toBe(0)
  })

  it('srcIn past the buffer does not produce a negative duration', () => {
    const e = compClipEdits(clip({ srcIn: 20, srcOut: 30 }), 5)
    expect(e.trimStart).toBe(5)
    expect(e.trimEnd).toBe(0)
  })
})

describe('defaultCompFromTake — lazy initialization', () => {
  const take = { id: 't1', duration: 10, edits: emptyEdits() }

  it('one clip spanning the whole take', () => {
    const c = defaultCompFromTake(take, { id: 'c1' })
    expect(c.clips).toHaveLength(1)
    expect(c.clips[0]).toMatchObject({ id: 'c1', sourceTakeId: 't1', srcIn: 0, srcOut: 10, start: 0 })
    expect(compDuration(c)).toBe(10)
    expectValid(c)
  })

  it('take trims move into srcIn/srcOut and are zeroed in edits', () => {
    const c = defaultCompFromTake(
      { ...take, edits: edits({ trimStart: 1, trimEnd: 2, gainDb: -3 }) },
      { id: 'c1' }
    )
    expect(c.clips[0].srcIn).toBe(1)
    expect(c.clips[0].srcOut).toBe(8)
    expect(c.clips[0].edits.trimStart).toBe(0)
    expect(c.clips[0].edits.trimEnd).toBe(0)
    expect(c.clips[0].edits.gainDb).toBe(-3)
    expect(compDuration(c)).toBe(7)
  })

  it('duration from the argument beats a zero in the model (adopted takes)', () => {
    const c = defaultCompFromTake({ ...take, duration: 0 }, { duration: 4, id: 'c1' })
    expect(c.clips[0].srcOut).toBe(4)
  })

  it('throws when there is no duration from anywhere', () => {
    expect(() => defaultCompFromTake({ ...take, duration: 0 })).toThrow(/duration/i)
  })

  it('throws when the trims ate the whole take', () => {
    expect(() =>
      defaultCompFromTake({ ...take, edits: edits({ trimStart: 5, trimEnd: 5 }) })
    ).toThrow(/nothing to compose/i)
  })
})

describe('normalizeComp', () => {
  it('sorts by start and leaves the content untouched', () => {
    const c = normalizeComp(comp(clip({ id: 'b', start: 5, srcOut: 1 }), clip({ id: 'a', start: 0, srcOut: 1 })))
    expect(c.clips.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('drops degenerate clips', () => {
    const c = normalizeComp(comp(clip({ id: 'a', srcOut: 1 }), clip({ id: 'z', srcIn: 2, srcOut: 2, start: 3 })))
    expect(c.clips.map((x) => x.id)).toEqual(['a'])
  })

  it('a negative start is pulled up to zero', () => {
    expect(normalizeComp(comp(clip({ start: -4 }))).clips[0].start).toBe(0)
  })

  it('does NOT silently fix overlaps — that is the job of compProblem', () => {
    const c = normalizeComp(comp(clip({ id: 'a', srcOut: 5 }), clip({ id: 'b', srcOut: 5, start: 1 })))
    expect(c.clips[1].start).toBe(1)
    expect(compProblem(c)).toMatch(/overlap/)
  })

  it('the input object is not mutated', () => {
    const src = comp(clip({ id: 'a', start: -1 }))
    normalizeComp(src)
    expect(src.clips[0].start).toBe(-1)
  })
})

describe('compProblem — what main must reject', () => {
  it('a valid comp', () => {
    expectValid(comp(clip({ id: 'a', srcOut: 2 }), clip({ id: 'b', srcIn: 1, srcOut: 3, start: 2 })))
  })

  it('butt-to-butt is NOT counted as an overlap', () => {
    expectValid(comp(clip({ id: 'a', srcOut: 2 }), clip({ id: 'b', srcOut: 2, start: 2 })))
  })

  it('srcOut <= srcIn', () => {
    expect(compProblem(comp(clip({ srcIn: 2, srcOut: 2 })))).toMatch(/srcOut <= srcIn/)
  })

  it('negative positions', () => {
    expect(compProblem(comp(clip({ srcIn: -1, srcOut: 2 })))).toMatch(/srcIn < 0/)
    expect(compProblem(comp(clip({ start: -1 })))).toMatch(/before zero/)
  })

  it('NaN / Infinity', () => {
    expect(compProblem(comp(clip({ srcOut: NaN })))).toMatch(/non-finite/)
    expect(compProblem(comp(clip({ start: Infinity })))).toMatch(/non-finite/)
  })

  it('duplicate id', () => {
    expect(compProblem(comp(clip({ id: 'a' }), clip({ id: 'a', start: 5 })))).toMatch(/duplicate/)
  })

  it('overlap', () => {
    expect(compProblem(comp(clip({ id: 'a', srcOut: 3 }), clip({ id: 'b', srcOut: 1, start: 2 })))).toMatch(
      /overlap/
    )
  })
})

describe('splitClipAt', () => {
  const base = comp(clip({ id: 'a', srcIn: 1, srcOut: 5, start: 0 }))

  it('splits into two parts whose sum = the whole', () => {
    const c = splitClipAt(base, 'a', 1.5, { left: 'L', right: 'R' })
    expect(c.clips.map((x) => x.id)).toEqual(['L', 'R'])
    expect(c.clips[0]).toMatchObject({ srcIn: 1, srcOut: 2.5, start: 0 })
    expect(c.clips[1]).toMatchObject({ srcIn: 2.5, srcOut: 5, start: 1.5 })
    expect(compDuration(c)).toBe(compDuration(base))
    expectValid(c)
  })

  it('the cut point is converted into SOURCE seconds through the speed', () => {
    const fast = comp(clip({ id: 'a', srcIn: 0, srcOut: 4, edits: edits({ timeStretch: 2 }) }))
    const c = splitClipAt(fast, 'a', 0.5, { left: 'L', right: 'R' })
    expect(c.clips[0].srcOut).toBe(1)
    expect(c.clips[1].srcIn).toBe(1)
    expect(c.clips[1].start).toBe(0.5)
    expectValid(c)
  })

  it('a non-round speed does not make the comp invalid (float round-trip)', () => {
    const odd = comp(clip({ id: 'a', srcIn: 0.3, srcOut: 7.1, edits: edits({ timeStretch: 1.37 }) }))
    for (const t of [0.4, 1.234, 3.9]) {
      const c = splitClipAt(odd, 'a', t, { left: 'L', right: 'R' })
      expect(c.clips).toHaveLength(2)
      expectValid(c)
      expect(compDuration(c)).toBeCloseTo(compDuration(odd), 9)
    }
  })

  it('the inner seam stays bare: fadeOut on the left and fadeIn on the right disappear', () => {
    const faded = comp(
      clip({
        id: 'a',
        srcOut: 4,
        edits: edits({ fadeIn: { duration: 0.5, shape: 'linear' }, fadeOut: { duration: 0.5, shape: 'linear' } }),
      })
    )
    const c = splitClipAt(faded, 'a', 2, { left: 'L', right: 'R' })
    expect(c.clips[0].edits.fadeIn.duration).toBe(0.5)
    expect(c.clips[0].edits.fadeOut.duration).toBe(0)
    expect(c.clips[1].edits.fadeIn.duration).toBe(0)
    expect(c.clips[1].edits.fadeOut.duration).toBe(0.5)
  })

  it('the envelope of the right half moves to the cut point and does not replay from the start', () => {
    const env = comp(
      clip({ id: 'a', srcOut: 4, edits: edits({ gainEnvelope: [{ t: 0, db: 0 }, { t: 4, db: -12 }] }) })
    )
    const c = splitClipAt(env, 'a', 2, { left: 'L', right: 'R' })
    expect(c.clips[0].edits.gainEnvelope).toEqual([{ t: 0, db: 0 }, { t: 2, db: -6 }])
    expect(c.clips[1].edits.gainEnvelope).toEqual([{ t: 0, db: -6 }, { t: 2, db: -12 }])
  })

  it('a cut at the edge or outside the clip — no-op', () => {
    expect(splitClipAt(base, 'a', 0)).toBe(base)
    expect(splitClipAt(base, 'a', 4)).toBe(base)
    expect(splitClipAt(base, 'a', -1)).toBe(base)
    expect(splitClipAt(base, 'a', 99)).toBe(base)
  })

  it('unknown clip — no-op', () => {
    expect(splitClipAt(base, 'nope', 1)).toBe(base)
  })

  it('a cut that would leave a stub shorter than the minimum is not made', () => {
    expect(splitClipAt(base, 'a', MIN_CLIP_SRC / 4)).toBe(base)
  })
})

describe('moveClip — neighbours as walls', () => {
  const three = comp(
    clip({ id: 'a', srcOut: 2, start: 0 }),
    clip({ id: 'b', srcOut: 2, start: 3 }),
    clip({ id: 'c', srcOut: 2, start: 8 })
  )

  it('moves within a free window', () => {
    const c = moveClip(three, 'b', 4)
    expect(c.clips.find((x) => x.id === 'b')!.start).toBe(4)
    expectValid(c)
  })

  it('the left wall is the end of the previous clip', () => {
    expect(moveClip(three, 'b', 0).clips.find((x) => x.id === 'b')!.start).toBe(2)
  })

  it('the right wall is the start of the next clip minus the length', () => {
    expect(moveClip(three, 'b', 99).clips.find((x) => x.id === 'b')!.start).toBe(6)
  })

  it('the first clip does not go past zero', () => {
    expect(moveClip(three, 'a', -5).clips[0].start).toBe(0)
  })

  it('the last clip has no right wall', () => {
    expect(moveClip(three, 'c', 100).clips.find((x) => x.id === 'c')!.start).toBe(100)
  })

  it('window narrower than the clip — we stick to the left wall, without overlapping the left neighbour', () => {
    const tight = comp(
      clip({ id: 'a', srcOut: 2, start: 0 }),
      clip({ id: 'b', srcOut: 2, start: 2 }),
      clip({ id: 'c', srcOut: 2, start: 3 })
    )
    const moved = moveClip(tight, 'b', 99)
    expect(moved.clips.find((x) => x.id === 'b')!.start).toBe(2)
  })

  it('a move does not change clip order', () => {
    expect(moveClip(three, 'a', 99).clips.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('unknown clip and NaN — no-op', () => {
    expect(moveClip(three, 'nope', 1)).toBe(three)
    expect(moveClip(three, 'b', NaN)).toBe(three)
  })
})

describe('trimClipEdge', () => {
  const two = comp(
    clip({ id: 'a', srcIn: 2, srcOut: 6, start: 0 }),
    clip({ id: 'b', srcIn: 0, srcOut: 2, start: 10 })
  )

  it('the left handle drags start and srcIn TOGETHER — the audio does not slip', () => {
    const c = trimClipEdge(two, 'a', 'start', 1)
    expect(c.clips[0]).toMatchObject({ start: 1, srcIn: 3, srcOut: 6 })
    expectValid(c)
  })

  it('the left handle does not drive the source negative', () => {
    const c = trimClipEdge(comp(clip({ id: 'a', srcIn: 1, srcOut: 5, start: 4 })), 'a', 'start', -99)
    expect(c.clips[0].srcIn).toBe(0)
    expect(c.clips[0].start).toBe(3)
  })

  it('the left handle does not run over the previous clip', () => {
    const c = trimClipEdge(
      comp(clip({ id: 'a', srcOut: 2, start: 0 }), clip({ id: 'b', srcIn: 5, srcOut: 9, start: 3 })),
      'b',
      'start',
      -99
    )
    expect(c.clips[1]).toMatchObject({ start: 2, srcIn: 4 })
    expectValid(c)
  })

  it('the right handle does not go past the source duration', () => {
    const c = trimClipEdge(two, 'a', 'end', 99, 7)
    expect(c.clips[0].srcOut).toBe(7)
    expectValid(c)
  })

  it('the right handle does not run over the next clip', () => {
    const c = trimClipEdge(two, 'a', 'end', 99, 1000)
    expect(clipEnd(c.clips[0])).toBeCloseTo(10, 9)
    expectValid(c)
  })

  it('at speed ≠ 1 the source edge moves by delta * speed', () => {
    const fast = comp(clip({ id: 'a', srcIn: 0, srcOut: 8, start: 0, edits: edits({ timeStretch: 2 }) }))
    expect(trimClipEdge(fast, 'a', 'end', -1, 100).clips[0].srcOut).toBe(6)
    const left = trimClipEdge(fast, 'a', 'start', 1, 100)
    expect(left.clips[0]).toMatchObject({ start: 1, srcIn: 2 })
    expect(clipTimelineDuration(left.clips[0])).toBe(3)
  })

  it('the neighbour clamp is also in TIMELINE seconds, not source seconds', () => {
    const fast = comp(
      clip({ id: 'a', srcIn: 0, srcOut: 4, start: 0, edits: edits({ timeStretch: 2 }) }),
      clip({ id: 'b', srcOut: 1, start: 3 })
    )
    const c = trimClipEdge(fast, 'a', 'end', 99, 100)
    expect(c.clips[0].srcOut).toBe(6)
    expect(clipEnd(c.clips[0])).toBe(3)
    expectValid(c)
  })

  it('neither handle eats the clip down to zero', () => {
    const c = trimClipEdge(two, 'a', 'end', -99, 100)
    expect(c.clips[0].srcOut - c.clips[0].srcIn).toBeCloseTo(MIN_CLIP_SRC, 9)
    expectValid(c)
    const d = trimClipEdge(two, 'a', 'start', 99, 100)
    expect(d.clips[0].srcOut - d.clips[0].srcIn).toBeCloseTo(MIN_CLIP_SRC, 9)
    expectValid(d)
  })

  it('unknown clip and NaN — no-op', () => {
    expect(trimClipEdge(two, 'nope', 'end', 1)).toBe(two)
    expect(trimClipEdge(two, 'a', 'end', NaN)).toBe(two)
  })
})

describe('removeClip', () => {
  const two = comp(clip({ id: 'a', srcOut: 2 }), clip({ id: 'b', srcOut: 2, start: 5 }))

  it('removes the clip and leaves the hole as silence', () => {
    const c = removeClip(two, 'a')
    expect(c.clips.map((x) => x.id)).toEqual(['b'])
    expect(c.clips[0].start).toBe(5)
    expect(compDuration(c)).toBe(7)
  })

  it('unknown id — no-op', () => {
    expect(removeClip(two, 'nope')).toBe(two)
  })

  it('the last clip can be removed — the comp becomes empty', () => {
    expect(isEmptyComp(removeClip(removeClip(two, 'a'), 'b'))).toBe(true)
  })
})

describe('setClipEdits', () => {
  const two = comp(clip({ id: 'a', srcOut: 2 }), clip({ id: 'b', srcOut: 2, start: 4 }))

  it('gain and fade shape arrive as is', () => {
    const c = setClipEdits(two, 'a', { gainDb: -6, fadeIn: { duration: 0.2, shape: 'linear' } })
    expect(c.clips[0].edits.gainDb).toBe(-6)
    expect(c.clips[0].edits.fadeIn).toEqual({ duration: 0.2, shape: 'linear' })
  })

  it('gain clamps to the range of the knob', () => {
    expect(setClipEdits(two, 'a', { gainDb: -999 }).clips[0].edits.gainDb).toBe(GAIN_MIN_DB)
    expect(setClipEdits(two, 'a', { gainDb: 999 }).clips[0].edits.gainDb).toBe(GAIN_MAX_DB)
    expect(setClipEdits(two, 'a', { gainDb: NaN }).clips[0].edits.gainDb).toBe(0)
  })

  it('speed clamps to the range of the knob', () => {
    expect(setClipEdits(two, 'b', { timeStretch: 100 }).clips[1].edits.timeStretch).toBe(SPEED_MAX)
    expect(setClipEdits(two, 'b', { timeStretch: 0.001 }).clips[1].edits.timeStretch).toBe(SPEED_MIN)
    expect(setClipEdits(two, 'b', { timeStretch: -1 }).clips[1].edits.timeStretch).toBe(1)
  })

  it('slowing down does NOT run over the neighbour', () => {
    const c = setClipEdits(two, 'a', { timeStretch: 0.25 })
    expect(c.clips[0].edits.timeStretch).toBeCloseTo(0.5, 9)
    expectValid(c)
    expect(clipEnd(c.clips[0])).toBeLessThanOrEqual(c.clips[1].start + COMP_EPS)
  })

  it('the last clip slows down freely — there is no wall on the right', () => {
    const c = setClipEdits(two, 'b', { timeStretch: 0.25 })
    expect(c.clips[1].edits.timeStretch).toBe(SPEED_MIN)
    expectValid(c)
  })

  it('a fade is no longer than the clip', () => {
    const c = setClipEdits(two, 'a', { fadeIn: { duration: 99, shape: 'equalPower' } })
    expect(c.clips[0].edits.fadeIn.duration).toBeCloseTo(clipTimelineDuration(c.clips[0]), 9)
  })

  it('the sum of the fades is no longer than the clip — the untouched one gives way', () => {
    const withOut = setClipEdits(two, 'a', { fadeOut: { duration: 1.5, shape: 'equalPower' } })
    const both = setClipEdits(withOut, 'a', { fadeIn: { duration: 1.5, shape: 'equalPower' } })
    const e = both.clips[0].edits
    expect(e.fadeIn.duration).toBeCloseTo(1.5, 9)
    expect(e.fadeOut.duration).toBeCloseTo(0.5, 9)
    expect(e.fadeIn.duration + e.fadeOut.duration).toBeLessThanOrEqual(
      clipTimelineDuration(both.clips[0]) + COMP_EPS
    )
  })

  it('speeding up shortens the clip and the fades follow it', () => {
    const slow = setClipEdits(two, 'a', { fadeOut: { duration: 1.8, shape: 'equalPower' } })
    const fast = setClipEdits(slow, 'a', { timeStretch: 4 })
    expect(clipTimelineDuration(fast.clips[0])).toBeCloseTo(0.5, 9)
    expect(fast.clips[0].edits.fadeOut.duration).toBeLessThanOrEqual(0.5 + COMP_EPS)
    expectValid(fast)
  })

  it('unknown clip — no-op', () => {
    expect(setClipEdits(two, 'nope', { gainDb: -6 })).toBe(two)
  })
})

describe('replaceClipSource — ripple and the fate of edits', () => {
  const three = comp(
    clip({ id: 'a', srcOut: 2 }),
    clip({ id: 'b', srcIn: 0, srcOut: 3, start: 2 }),
    clip({ id: 'c', srcOut: 1, start: 6 })
  )

  it('the clip takes the new take WHOLE and stays at its own start', () => {
    const c = replaceClipSource(three, 'b', 't9', 5)
    const b = c.clips[1]
    expect(b.id).toBe('b')
    expect(b.sourceTakeId).toBe('t9')
    expect(b.srcIn).toBe(0)
    expect(b.srcOut).toBe(5)
    expect(b.start).toBe(2)
    expectValid(c)
  })

  it('a longer take pushes the neighbours right exactly by delta', () => {
    const c = replaceClipSource(three, 'b', 't9', 5)
    expect(c.clips.map((x) => x.start)).toEqual([0, 2, 8])
    expect(compDuration(c)).toBe(9)
    expectValid(c)
  })

  it('a shorter take PULLS the neighbours left — no hole is left behind', () => {
    const c = replaceClipSource(three, 'b', 't9', 1)
    expect(c.clips.map((x) => x.start)).toEqual([0, 2, 4])
    expectValid(c)
  })

  it('clips on the LEFT do not move', () => {
    const c = replaceClipSource(three, 'c', 't9', 4)
    expect(c.clips[0].start).toBe(0)
    expect(c.clips[1].start).toBe(2)
    expectValid(c)
  })

  it('gain and fade shapes survive the swap', () => {
    const src = comp(
      clip({
        id: 'a',
        srcOut: 2,
        edits: edits({
          gainDb: -4.5,
          fadeIn: { duration: 0.3, shape: 'linear' },
          fadeOut: { duration: 0.4, shape: 'sCurve' },
        }),
      })
    )
    const e = replaceClipSource(src, 'a', 't9', 6).clips[0].edits
    expect(e.gainDb).toBe(-4.5)
    expect(e.fadeIn).toEqual({ duration: 0.3, shape: 'linear' })
    expect(e.fadeOut).toEqual({ duration: 0.4, shape: 'sCurve' })
  })

  it('speed resets to 1 — it was fitted to the OLD material', () => {
    const src = comp(clip({ id: 'a', srcOut: 4, edits: edits({ timeStretch: 2 }) }))
    const c = replaceClipSource(src, 'a', 't9', 3)
    expect(c.clips[0].edits.timeStretch).toBe(1)
    expect(clipTimelineDuration(c.clips[0])).toBe(3)
    expectValid(c)
  })

  it('fades do not outlive the clip: the sum clamps to the new length', () => {
    const src = comp(
      clip({
        id: 'a',
        srcOut: 10,
        edits: edits({
          fadeIn: { duration: 3, shape: 'equalPower' },
          fadeOut: { duration: 3, shape: 'equalPower' },
        }),
      })
    )
    const e = replaceClipSource(src, 'a', 't9', 4).clips[0].edits
    expect(e.fadeIn.duration).toBe(3)
    expect(e.fadeOut.duration).toBe(1)
    expect(e.fadeIn.duration + e.fadeOut.duration).toBeLessThanOrEqual(4 + COMP_EPS)
  })

  it('the envelope does NOT move onto foreign audio', () => {
    const src = comp(
      clip({ id: 'a', srcOut: 2, edits: edits({ gainEnvelope: [{ t: 0, db: -12 }] }) })
    )
    expect(replaceClipSource(src, 'a', 't9', 3).clips[0].edits.gainEnvelope).toBeUndefined()
  })

  it('unknown clip — no-op (the clip was already deleted)', () => {
    expect(replaceClipSource(three, 'nope', 't9', 5)).toBe(three)
  })

  it('a take with no duration — no-op, not a zero-length clip', () => {
    expect(replaceClipSource(three, 'b', 't9', 0)).toBe(three)
    expect(replaceClipSource(three, 'b', 't9', NaN)).toBe(three)
    expect(replaceClipSource(three, 'b', 't9', MIN_CLIP_SRC / 2)).toBe(three)
  })
})

describe('mutators mutate nothing', () => {
  const src = comp(clip({ id: 'a', srcIn: 1, srcOut: 5 }), clip({ id: 'b', srcOut: 2, start: 6 }))
  const snapshot = JSON.stringify(src)

  it('after a full editing cycle the input is unchanged', () => {
    splitClipAt(src, 'a', 2)
    moveClip(src, 'b', 99)
    trimClipEdge(src, 'a', 'end', 1, 10)
    setClipEdits(src, 'a', { gainDb: -3, timeStretch: 2 })
    replaceClipSource(src, 'a', 't9', 7)
    removeClip(src, 'a')
    normalizeComp(src)
    expect(JSON.stringify(src)).toBe(snapshot)
  })
})

describe('healCut: glue the cut back together', () => {
  const one = comp(clip({ id: 'a', sourceTakeId: 't1', srcIn: 0, srcOut: 4, start: 0 }))

  it('split → heal returns the very same comp', () => {
    const cut = splitClipAt(one, 'a', 1.5)
    expect(cut.clips).toHaveLength(2)
    const healed = healCut(cut, cut.clips[0].id)
    expect(healed.clips).toHaveLength(1)
    expect(healed).toEqual(one)
    expectValid(healed)
  })

  it('heal keeps the id of the LEFT clip — the selection holds on to it', () => {
    const cut = splitClipAt(one, 'a', 2)
    expect(healCut(cut, 'a').clips[0].id).toBe('a')
  })

  it('split → heal after two cuts in a row', () => {
    const cut = splitClipAt(splitClipAt(one, 'a', 1), 'a', 0.5)
    expect(cut.clips).toHaveLength(3)
    const once = healCut(cut, cut.clips[0].id)
    expect(once.clips).toHaveLength(2)
    const twice = healCut(once, once.clips[0].id)
    expect(twice).toEqual(one)
  })

  it('the outer fades survive, the inner seam disappears', () => {
    const faded = comp(
      clip({
        id: 'a',
        srcOut: 4,
        edits: edits({
          fadeIn: { duration: 0.4, shape: 'equalPower' },
          fadeOut: { duration: 0.7, shape: 'equalPower' },
        }),
      })
    )
    const healed = healCut(splitClipAt(faded, 'a', 2), 'a')
    expect(healed.clips[0].edits.fadeIn.duration).toBeCloseTo(0.4, 10)
    expect(healed.clips[0].edits.fadeOut.duration).toBeCloseTo(0.7, 10)
    expect(healed).toEqual(faded)
  })

  it('the envelope glues back without a synthetic seam point', () => {
    const env = comp(
      clip({
        id: 'a',
        srcOut: 4,
        edits: edits({ gainEnvelope: [{ t: 0, db: -12 }, { t: 4, db: 0 }] }),
      })
    )
    const healed = healCut(splitClipAt(env, 'a', 2), 'a')
    expect(healed.clips[0].edits.gainEnvelope).toEqual([{ t: 0, db: -12 }, { t: 4, db: 0 }])
  })

  it('speed ≠ 1 glues back as well', () => {
    const fast = comp(clip({ id: 'a', srcOut: 4, edits: edits({ timeStretch: 2 }) }))
    const cut = splitClipAt(fast, 'a', 1)
    expect(cut.clips).toHaveLength(2)
    expect(healCut(cut, 'a')).toEqual(fast)
  })

  it('different sources do not glue', () => {
    const mixed = comp(
      clip({ id: 'a', sourceTakeId: 't1', srcOut: 2, start: 0 }),
      clip({ id: 'b', sourceTakeId: 't2', srcIn: 2, srcOut: 4, start: 2 })
    )
    expect(canHeal(mixed, 'a')).toBe(false)
    expect(healCut(mixed, 'a')).toBe(mixed)
  })

  it('different speeds do not glue: the length would not add up', () => {
    const mixed = comp(
      clip({ id: 'a', srcOut: 2, start: 0 }),
      clip({ id: 'b', srcIn: 2, srcOut: 4, start: 2, edits: edits({ timeStretch: 2 }) })
    )
    expect(canHeal(mixed, 'a')).toBe(false)
  })

  it('a gap in the SOURCE does not glue, even when the timeline is butt-to-butt', () => {
    const gap = comp(
      clip({ id: 'a', srcIn: 0, srcOut: 2, start: 0 }),
      clip({ id: 'b', srcIn: 3, srcOut: 5, start: 2 })
    )
    expect(canHeal(gap, 'a')).toBe(false)
  })

  it('a gap on the TIMELINE does not glue, even when the source is continuous', () => {
    const gap = comp(
      clip({ id: 'a', srcIn: 0, srcOut: 2, start: 0 }),
      clip({ id: 'b', srcIn: 2, srcOut: 4, start: 2.5 })
    )
    expect(canHeal(gap, 'a')).toBe(false)
    expect(healCut(gap, 'a')).toBe(gap)
  })

  it('the last clip and an unknown id — no-op', () => {
    const cut = splitClipAt(one, 'a', 2)
    const last = cut.clips[1].id
    expect(canHeal(cut, last)).toBe(false)
    expect(healCut(cut, last)).toBe(cut)
    expect(canHeal(cut, 'nope')).toBe(false)
    expect(healCut(cut, 'nope')).toBe(cut)
  })

  it('with a single clip there is nothing to glue', () => {
    expect(canHeal(one, 'a')).toBe(false)
    expect(healableAt(one, 0)).toBeNull()
  })

  it('healableAt finds the cut under the playhead and stays silent far from it', () => {
    const cut = splitClipAt(one, 'a', 1.5)
    expect(healableAt(cut, 1.5)).toBe('a')
    expect(healableAt(cut, 1.6)).toBe('a')
    expect(healableAt(cut, 3.5)).toBeNull()
  })

  it('healCut does not mutate the input', () => {
    const cut = splitClipAt(one, 'a', 2)
    const snapshot = JSON.stringify(cut)
    healCut(cut, 'a')
    expect(JSON.stringify(cut)).toBe(snapshot)
  })
})

const butted = (over: Partial<CompClip> = {}): CueComp =>
  comp(
    clip({ id: 'l', srcIn: 0, srcOut: 2, start: 0, ...over }),
    clip({ id: 'r', srcIn: 1, srcOut: 3, start: 2 })
  )

describe('crossfade: handles at the seam', () => {
  it('a butt-to-butt seam with source handles accepts a transition', () => {
    expect(maxCrossfade(butted(), 'l')).toBeCloseTo(1, 9)
  })

  it('a gap between clips accepts nothing', () => {
    const gapped = comp(
      clip({ id: 'l', srcOut: 2 }),
      clip({ id: 'r', srcIn: 1, srcOut: 3, start: 2.5 })
    )
    expect(maxCrossfade(gapped, 'l')).toBe(0)
  })

  it('zero source handle on the right = zero transition', () => {
    const noHandle = comp(
      clip({ id: 'l', srcOut: 2 }),
      clip({ id: 'r', srcIn: 0, srcOut: 2, start: 2 })
    )
    expect(maxCrossfade(noHandle, 'l')).toBe(0)
  })

  it('the handle is measured in TIMELINE seconds: srcIn / speed', () => {
    const fast = comp(
      clip({ id: 'l', srcOut: 2 }),
      clip({ id: 'r', srcIn: 1, srcOut: 3, start: 2, edits: edits({ timeStretch: 2 }) })
    )
    expect(maxCrossfade(fast, 'l')).toBeCloseTo(0.5, 9)
  })

  it('the transition is no longer than either of the two clips', () => {
    const shortLeft = comp(
      clip({ id: 'l', srcIn: 0, srcOut: 0.3, start: 0 }),
      clip({ id: 'r', srcIn: 5, srcOut: 7, start: 0.3 })
    )
    expect(maxCrossfade(shortLeft, 'l')).toBeCloseTo(0.3, 9)
    const shortRight = comp(
      clip({ id: 'l', srcIn: 0, srcOut: 2, start: 0 }),
      clip({ id: 'r', srcIn: 5, srcOut: 5.4, start: 2 })
    )
    expect(maxCrossfade(shortRight, 'l')).toBeCloseTo(0.4, 9)
  })

  it('the last clip and an unknown id — zero', () => {
    expect(maxCrossfade(butted(), 'r')).toBe(0)
    expect(maxCrossfade(butted(), 'nope')).toBe(0)
  })
})

describe('crossfade: setCrossfade', () => {
  it('sets it and clamps it to the handle', () => {
    const on = setCrossfade(butted(), 'l', 0.08)
    expect(on.clips[0].crossfade).toBeCloseTo(0.08, 9)
    expectValid(on)
    const over = setCrossfade(butted(), 'l', 99)
    expect(over.clips[0].crossfade).toBeCloseTo(1, 9)
    expectValid(over)
  })

  it('the model does not move: starts, durations and compDuration stay the same', () => {
    const base = normalizeComp(butted())
    const on = setCrossfade(base, 'l', 0.08)
    expect(on.clips.map((c) => c.start)).toEqual(base.clips.map((c) => c.start))
    expect(on.clips.map(clipTimelineDuration)).toEqual(base.clips.map(clipTimelineDuration))
    expect(compDuration(on)).toBe(compDuration(base))
    expect(compProblem(on)).toBeNull()
  })

  it('zero REMOVES the field instead of writing a zero: old comps stay exactly the same', () => {
    const on = setCrossfade(butted(), 'l', 0.08)
    const off = setCrossfade(on, 'l', 0)
    expect('crossfade' in off.clips[0]).toBe(false)
    expect(JSON.stringify(off)).toBe(JSON.stringify(normalizeComp(butted())))
  })

  it('a seam without handles leaves the comp without the field', () => {
    const noHandle = comp(
      clip({ id: 'l', srcOut: 2 }),
      clip({ id: 'r', srcIn: 0, srcOut: 2, start: 2 })
    )
    const out = setCrossfade(noHandle, 'l', 0.08)
    expect('crossfade' in out.clips[0]).toBe(false)
  })

  it('the last clip, an unknown id and NaN — no-op', () => {
    const b = butted()
    expect(setCrossfade(b, 'r', 0.08)).toBe(b)
    expect(setCrossfade(b, 'nope', 0.08)).toBe(b)
    expect(setCrossfade(b, 'l', NaN)).toBe(b)
  })

  it('does not mutate the input', () => {
    const b = butted()
    const snapshot = JSON.stringify(b)
    setCrossfade(b, 'l', 0.08)
    expect(JSON.stringify(b)).toBe(snapshot)
  })
})

describe('crossfade: render plan', () => {
  it('the right clip starts earlier and takes the source handle, the left one stays put', () => {
    const on = normalizeComp(setCrossfade(butted(), 'l', 0.2))
    const plan = compRenderPlan(on.clips)
    expect(plan[0].clip.start).toBe(0)
    expect(plan[0].crossfadeOut).toBeCloseTo(0.2, 9)
    expect(plan[1].clip.start).toBeCloseTo(1.8, 9)
    expect(plan[1].clip.srcIn).toBeCloseTo(0.8, 9)
    expect(plan[1].crossfadeIn).toBeCloseTo(0.2, 9)
  })

  it('the handle in the SOURCE is multiplied by the speed, while start moves in timeline seconds', () => {
    const fast = comp(
      clip({ id: 'l', srcOut: 2 }),
      clip({ id: 'r', srcIn: 1, srcOut: 3, start: 2, edits: edits({ timeStretch: 2 }) })
    )
    const on = normalizeComp(setCrossfade(fast, 'l', 0.25))
    const plan = compRenderPlan(on.clips)
    expect(plan[1].clip.start).toBeCloseTo(1.75, 9)
    expect(plan[1].clip.srcIn).toBeCloseTo(0.5, 9)
  })

  it('comp duration does not change because of the transition', () => {
    const base = normalizeComp(butted())
    const on = normalizeComp(setCrossfade(base, 'l', 0.2))
    const plan = compRenderPlan(on.clips)
    const planned = Math.max(...plan.map((p) => clipEnd(p.clip)))
    expect(planned).toBeCloseTo(compDuration(base), 9)
  })

  it('chain A→B→C: every seam is computed separately', () => {
    const three = comp(
      clip({ id: 'a', srcIn: 0, srcOut: 2, start: 0 }),
      clip({ id: 'b', srcIn: 1, srcOut: 3, start: 2 }),
      clip({ id: 'c', srcIn: 1, srcOut: 3, start: 4 })
    )
    const on = normalizeComp(setCrossfade(setCrossfade(three, 'a', 0.1), 'b', 0.3))
    const plan = compRenderPlan(on.clips)
    expect(plan[0].crossfadeIn).toBe(0)
    expect(plan[0].crossfadeOut).toBeCloseTo(0.1, 9)
    expect(plan[1].crossfadeIn).toBeCloseTo(0.1, 9)
    expect(plan[1].crossfadeOut).toBeCloseTo(0.3, 9)
    expect(plan[2].crossfadeIn).toBeCloseTo(0.3, 9)
    expect(plan[2].crossfadeOut).toBe(0)
  })

  it('a seam that came apart makes the transition INERT but does not erase the field', () => {
    const on = setCrossfade(butted(), 'l', 0.2)
    const moved = moveClip(on, 'r', 2.5)
    expect(moved.clips[0].crossfade).toBeCloseTo(0.2, 9)
    const plan = compRenderPlan(moved.clips)
    expect(plan[0].crossfadeOut).toBe(0)
    expect(plan[1].clip.start).toBe(2.5)
    const back = compRenderPlan(moveClip(moved, 'r', 2).clips)
    expect(back[0].crossfadeOut).toBeCloseTo(0.2, 9)
  })

  it('a raw field larger than the handle clamps at render time instead of breaking srcIn', () => {
    const stale = comp(
      clip({ id: 'l', srcIn: 0, srcOut: 2, start: 0, crossfade: 99 }),
      clip({ id: 'r', srcIn: 0.5, srcOut: 3, start: 2 })
    )
    const plan = compRenderPlan(normalizeComp(stale).clips)
    expect(plan[1].clip.srcIn).toBeGreaterThanOrEqual(0)
    expect(plan[1].crossfadeIn).toBeCloseTo(0.5, 9)
  })

  it('empty and single-clip input', () => {
    expect(compRenderPlan([])).toEqual([])
    const solo = comp(clip({ id: 'a', srcIn: 0, srcOut: 2, start: 0 }))
    const single = compRenderPlan(solo.clips)
    expect(single[0].crossfadeIn).toBe(0)
    expect(single[0].crossfadeOut).toBe(0)
    expect(single[0].clip).toBe(solo.clips[0])
  })
})

describe('crossfade: whose it is after a split and a heal', () => {
  it('a split gives the transition to the RIGHT half: Cut does not create a transition on its own', () => {
    const on = setCrossfade(butted(), 'l', 0.2)
    const cut = splitClipAt(on, 'l', 1)
    const left = cut.clips.find((c) => c.id === 'l')!
    const right = cut.clips.find((c) => c.id !== 'l' && c.start === 1)!
    expect('crossfade' in left).toBe(false)
    expect(right.crossfade).toBeCloseTo(0.2, 9)
    expect(compRenderPlan(cut.clips)[0].crossfadeOut).toBe(0)
    expectValid(cut)
  })

  it('a heal takes the transition of the RIGHT clip: the inner seam disappears along with it', () => {
    const two = splitClipAt(butted(), 'l', 1)
    const rightHalf = two.clips.find((c) => c.start === 1 && c.id !== 'r')!
    const on = setCrossfade(two, rightHalf.id, 0.15)
    const healed = healCut(on, 'l')
    const merged = healed.clips.find((c) => c.id === 'l')!
    expect(merged.crossfade).toBeCloseTo(0.15, 9)
    expectValid(healed)
  })

  it('a heal with no transition on the right leaves no field from the left half', () => {
    const two = splitClipAt(butted(), 'l', 1)
    const withXf = setCrossfade(two, 'l', 0.2)
    const healed = healCut(withXf, 'l')
    expect('crossfade' in healed.clips.find((c) => c.id === 'l')!).toBe(false)
  })
})

describe('take insertion: finding a slot', () => {
  const track = comp(
    clip({ id: 'a', srcIn: 0, srcOut: 2, start: 0 }),
    clip({ id: 'b', srcIn: 0, srcOut: 2, start: 5 })
  )

  it('free space is taken as is', () => {
    expect(findInsertSlot(track, 1, 3)).toBe(3)
  })

  it('inside a gap the clip clamps instead of running over a neighbour', () => {
    expect(findInsertSlot(track, 3, 4)).toBe(2)
    expect(findInsertSlot(track, 2, 4)).toBe(3)
  })

  it('the gap is too tight — we take the nearest other one, including the tail', () => {
    expect(findInsertSlot(track, 4, 3)).toBe(7)
  })

  it('the tail after the last clip is infinite: there is always room', () => {
    expect(findInsertSlot(track, 100, 50)).toBe(50)
    expect(findInsertSlot(track, 100, 0)).toBe(7)
  })

  it('maxShift refuses when the clip would have to be pulled too far', () => {
    expect(findInsertSlot(track, 4, 3, 1)).toBeNull()
    expect(findInsertSlot(track, 4, 3, 4)).toBe(7)
  })

  it('an empty comp and a negative position', () => {
    expect(findInsertSlot(comp(), 1, 3)).toBe(3)
    expect(findInsertSlot(comp(), 1, -5)).toBe(0)
  })

  it('degenerate duration — nowhere to put it', () => {
    expect(findInsertSlot(track, 0, 3)).toBeNull()
    expect(findInsertSlot(track, NaN, 3)).toBeNull()
    expect(findInsertSlot(track, 1, NaN)).toBeNull()
  })
})

describe('take insertion: insertClipFromTake', () => {
  const track = comp(
    clip({ id: 'a', srcIn: 0, srcOut: 2, start: 0 }),
    clip({ id: 'b', srcIn: 0, srcOut: 2, start: 5 })
  )

  it('places the take WHOLE and leaves the comp valid', () => {
    const out = insertClipFromTake(track, 't9', 1.5, 3, { id: 'new' })
    const added = out.clips.find((c) => c.id === 'new')!
    expect(added.sourceTakeId).toBe('t9')
    expect(added.srcIn).toBe(0)
    expect(added.srcOut).toBe(1.5)
    expect(added.start).toBe(3)
    expectValid(out)
  })

  it('the neighbours do NOT shift: ripple is forbidden here', () => {
    const out = insertClipFromTake(track, 't9', 1.5, 3, { id: 'new' })
    expect(out.clips.find((c) => c.id === 'a')!.start).toBe(0)
    expect(out.clips.find((c) => c.id === 'b')!.start).toBe(5)
  })

  it('no valid slot within maxShift — no-op', () => {
    const out = insertClipFromTake(track, 't9', 4, 3, { maxShift: 1 })
    expect(out).toBe(track)
  })

  it('does not mutate the input', () => {
    const snapshot = JSON.stringify(track)
    insertClipFromTake(track, 't9', 1, 3)
    expect(JSON.stringify(track)).toBe(snapshot)
  })
})

describe('region: normalization and validation', () => {
  const two = comp(
    clip({ id: 'a', srcIn: 0, srcOut: 2, start: 0 }),
    clip({ id: 'b', srcIn: 0, srcOut: 2, start: 2 })
  )

  it('with no region the field is simply absent', () => {
    expect('region' in normalizeComp(two)).toBe(false)
  })

  it('clamped to comp duration', () => {
    const out = normalizeComp({ clips: two.clips, region: { in: -3, out: 99 } })
    expect(out.region).toEqual({ in: 0, out: 4 })
  })

  it('a degenerate window is dropped entirely', () => {
    expect(normalizeComp({ clips: two.clips, region: { in: 2, out: 2 } }).region).toBeUndefined()
    expect(normalizeComp({ clips: two.clips, region: { in: 3, out: 1 } }).region).toBeUndefined()
    expect(normalizeComp({ clips: two.clips, region: { in: 0, out: NaN } }).region).toBeUndefined()
  })

  it('a region on an empty comp does not survive', () => {
    expect(normalizeComp({ clips: [], region: { in: 0, out: 1 } }).region).toBeUndefined()
  })

  it('compProblem catches an inverted and a non-finite region', () => {
    expect(compProblem({ clips: two.clips, region: { in: 1, out: 1 } })).toMatch(/region/)
    expect(compProblem({ clips: two.clips, region: { in: -1, out: 2 } })).toMatch(/region/)
    expect(compProblem({ clips: two.clips, region: { in: 0, out: Infinity } })).toMatch(/region/)
    expect(compProblem({ clips: two.clips, region: { in: 1, out: 3 } })).toBeNull()
  })

  it('setRegion sets it, flips it back and clears it', () => {
    expect(setRegion(two, { in: 3, out: 1 }).region).toEqual({ in: 1, out: 3 })
    const on = setRegion(two, { in: 1, out: 3 })
    expect('region' in setRegion(on, null)).toBe(false)
    expect(setRegion(two, null)).toBe(two)
  })

  it('setRegionEdge sets the edge at the playhead and fills in the other one', () => {
    expect(setRegionEdge(two, 'in', 1).region).toEqual({ in: 1, out: 4 })
    expect(setRegionEdge(two, 'out', 3).region).toEqual({ in: 0, out: 3 })
    const on = setRegion(two, { in: 1, out: 3 })
    expect(setRegionEdge(on, 'in', 2).region).toEqual({ in: 2, out: 3 })
    expect(setRegionEdge(on, 'out', 2).region).toEqual({ in: 1, out: 2 })
  })

  it('an edge that jumped past the opposite one does not collapse the region to zero', () => {
    const on = setRegion(two, { in: 1, out: 3 })
    expect(setRegionEdge(on, 'in', 3.5).region).toEqual({ in: 3.5, out: 4 })
    expect(setRegionEdge(on, 'out', 0.5).region).toEqual({ in: 0, out: 0.5 })
  })
})

describe('region survives EVERY mutator', () => {
  const base = normalizeComp({
    clips: comp(
      clip({ id: 'a', srcIn: 0, srcOut: 2, start: 0 }),
      clip({ id: 'b', srcIn: 1, srcOut: 3, start: 2 })
    ).clips,
    region: { in: 0.5, out: 3.5 },
  })

  const survives = (name: string, out: CueComp): void => {
    it(name, () => {
      expect(out.region, name).toEqual({ in: 0.5, out: 3.5 })
    })
  }

  survives('moveClip', moveClip(base, 'b', 2.5))
  survives('splitClipAt', splitClipAt(base, 'a', 1))
  survives('healCut', healCut(splitClipAt(base, 'a', 1), 'a'))
  survives('setClipEdits', setClipEdits(base, 'a', { gainDb: -3 }))
  survives('trimClipEdge', trimClipEdge(base, 'b', 'end', 0.2, 10))
  survives('setCrossfade', setCrossfade(base, 'a', 0.08))
  survives('insertClipFromTake', insertClipFromTake(base, 't', 0.5, 10))

  it('replaceClipSource too, and it clamps the region to the new length', () => {
    const out = replaceClipSource(base, 'b', 't2', 0.5)
    expect(out.region).toEqual({ in: 0.5, out: 2.5 })
  })

  it('removing material under OUT pulls it in instead of leaving it past the edge', () => {
    const out = removeClip(base, 'b')
    expect(compDuration(out)).toBe(2)
    expect(out.region).toEqual({ in: 0.5, out: 2 })
  })
})
