import { describe, expect, it } from 'vitest'
import { clipEnd, compProblem } from '../src/shared/comp'
import { emptyEdits, type CompClip, type CompTrack, type Cue, type CueComp, type Take } from '../src/shared/domain'
import { clipVersions, punchClip } from '../src/shared/library'
import { LOOP_PASS_MAX, loopPlan, type LoopTake } from '../src/shared/loop-record'

const RATE = 1000

const take = (over: Partial<LoopTake> = {}): LoopTake => ({
  marks: [500, 2100, 3700],
  length: 1.5,
  latency: 0,
  frames: 4500,
  sampleRate: RATE,
  ...over,
})

describe('loopPlan', () => {
  it('cuts one In..Out length per pass and places the last complete one', () => {
    expect(loopPlan(take({ frames: 5200 }))).toEqual({
      passes: [
        { from: 500, to: 2000 },
        { from: 2100, to: 3600 },
        { from: 3700, to: 5200 },
      ],
      place: 2,
    })
  })

  it('keeps a pass stopped mid-loop as a take but places the pass before it', () => {
    expect(loopPlan(take())).toEqual({
      passes: [
        { from: 500, to: 2000 },
        { from: 2100, to: 3600 },
        { from: 3700, to: 4500 },
      ],
      place: 1,
    })
  })

  it('drops a pass that barely started and a mark past the stop', () => {
    expect(loopPlan(take({ frames: 3650, marks: [500, 2100, 3600, 5300] })).passes).toEqual([
      { from: 500, to: 2000 },
      { from: 2100, to: 3600 },
    ])
  })

  it('shifts every pass by the latency correction', () => {
    expect(loopPlan(take({ latency: 0.02, frames: 5300 }))).toEqual({
      passes: [
        { from: 520, to: 2020 },
        { from: 2120, to: 3620 },
        { from: 3720, to: 5220 },
      ],
      place: 2,
    })
  })

  it('a pass missing its head is incomplete and never placed', () => {
    const plan = loopPlan(take({ marks: [10, 1600], latency: -0.05, frames: 3200 }))
    expect(plan.passes).toEqual([
      { from: 0, to: 1460 },
      { from: 1550, to: 3050 },
    ])
    expect(plan.place).toBe(1)
  })

  it('a pass cut short by the next one is incomplete', () => {
    expect(loopPlan(take({ marks: [500, 1200, 2800], frames: 4400 }))).toEqual({
      passes: [
        { from: 500, to: 1200 },
        { from: 1200, to: 2700 },
        { from: 2800, to: 4300 },
      ],
      place: 2,
    })
  })

  it('orders and dedupes marks', () => {
    expect(loopPlan(take({ marks: [3700, 500, 2100, 500], frames: 5200 })).passes).toHaveLength(3)
  })

  it('no complete pass means nothing to place', () => {
    expect(loopPlan(take({ marks: [500], frames: 1400 }))).toEqual({ passes: [{ from: 500, to: 1400 }], place: null })
  })

  it('refuses inputs it cannot cut', () => {
    const empty = { passes: [], place: null }
    expect(loopPlan(take({ marks: [] }))).toEqual(empty)
    expect(loopPlan(take({ length: 0 }))).toEqual(empty)
    expect(loopPlan(take({ frames: 0 }))).toEqual(empty)
    expect(loopPlan(take({ sampleRate: 0 }))).toEqual(empty)
    expect(loopPlan(take({ latency: Number.NaN }))).toEqual(empty)
    expect(loopPlan(take({ marks: [Number.NaN, Infinity] }))).toEqual(empty)
  })

  it('more passes than one save can hold yields no plan', () => {
    const marks = Array.from({ length: LOOP_PASS_MAX + 1 }, (_, i) => i * 20)
    expect(loopPlan(take({ marks, length: 0.01, frames: marks.length * 20 }))).toEqual({ passes: [], place: null })
    const fits = loopPlan(take({ marks: marks.slice(1), length: 0.01, frames: marks.length * 20 }))
    expect(fits.passes).toHaveLength(LOOP_PASS_MAX)
  })
})

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'a',
  sourceTakeId: 'old',
  srcIn: 0,
  srcOut: 4,
  start: 0,
  edits: emptyEdits(),
  ...over,
})

const track = (id: string): CompTrack => ({ id, name: id, gainDb: 0, muted: false, solo: false })

describe('loop placement', () => {
  it('replaces exactly In..Out on the target track and keeps both sides of the old clip', () => {
    const comp: CueComp = {
      clips: [clip({ trackId: 'track-1' }), clip({ id: 'o', srcOut: 3, trackId: 'track-2' })],
      tracks: [track('track-1'), track('track-2')],
      region: { in: 0.5, out: 2 },
    }
    const r = punchClip(comp, { takeId: 'pass3', duration: 1.5, hidden: 0, at: 0.5, until: 2, targetTrackId: 'track-1' })
    if (!r) throw new Error('no placement')
    expect(compProblem(r.comp)).toBeNull()
    const onTrack = r.comp.clips.filter((c) => c.trackId === 'track-1').sort((a, b) => a.start - b.start)
    expect(onTrack.map((c) => [c.sourceTakeId, c.start, clipEnd(c), c.srcIn, c.srcOut])).toEqual([
      ['old', 0, 0.5, 0, 0.5],
      ['pass3', 0.5, 2, 0, 1.5],
      ['old', 2, 4, 2, 4],
    ])
    expect(r.comp.clips.find((c) => c.id === 'o')).toEqual(comp.clips[1])
    expect(r.comp.region).toEqual({ in: 0.5, out: 2 })
    expect(r.trackId).toBe('track-1')
  })

  it('leaves clips after Out alone where punch and roll would clear them', () => {
    const comp: CueComp = { clips: [clip({ srcOut: 1 }), clip({ id: 'b', start: 3, srcOut: 1 })] }
    const loop = punchClip(comp, { takeId: 'p', duration: 1, hidden: 0, at: 1.5, until: 2.5 })
    const roll = punchClip(comp, { takeId: 'p', duration: 1, hidden: 0, at: 1.5 })
    expect(loop?.comp.clips.map((c) => c.id)).toContain('b')
    expect(roll?.comp.clips.map((c) => c.id)).not.toContain('b')
  })
})

describe('loop passes as versions', () => {
  const rec = (id: string, at: string): Take => ({
    id,
    kind: 'recording',
    createdAt: at,
    file: { fileId: `c/${id}.wav`, relPath: `/p/${id}.wav`, format: 'wav', sampleRate: 48000, channels: 1 },
    duration: 1.5,
    meta: { text: 'line' },
    edits: emptyEdits(),
    fragment: true,
  })

  it('every pass is a version of the placed clip, the placed one current', () => {
    const takes = [rec('earlier', '2026-01-01T00:00:00.000Z'), rec('p1', '2026-01-02T00:00:00.000Z'), rec('p2', '2026-01-02T00:00:00.000Z'), rec('p3', '2026-01-02T00:00:00.001Z')]
    const cue: Cue = {
      id: 'c',
      characterId: '',
      key: 'c',
      fields: {},
      sourceText: '',
      text: 'line',
      status: 'translated',
      notes: '',
      takes,
    }
    expect(clipVersions(cue, { cues: [cue] }, 'p3')).toEqual([
      { takeId: 'earlier', label: 'take 1', duration: 1.5, current: false },
      { takeId: 'p1', label: 'take 2', duration: 1.5, current: false },
      { takeId: 'p2', label: 'take 3', duration: 1.5, current: false },
      { takeId: 'p3', label: 'take 4', duration: 1.5, current: true },
    ])
  })
})
