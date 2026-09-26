import { describe, expect, it } from 'vitest'
import { clipEnd, compProblem, compRenderPlan } from '../src/shared/comp'
import { emptyEdits, type CompClip, type CompTrack, type CueComp } from '../src/shared/domain'
import { PUNCH_CROSSFADE, punchClip, recordClip } from '../src/shared/library'
import {
  latencyEstimate,
  latencySeconds,
  punchHidden,
  punchPrerollSeconds,
  recordLatencyMs,
} from '../src/shared/punch'

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'a',
  sourceTakeId: 't1',
  srcIn: 0,
  srcOut: 3,
  start: 0,
  edits: emptyEdits(),
  ...over,
})

const track = (id: string): CompTrack => ({ id, name: id, gainDb: 0, muted: false, solo: false })

const punch = { takeId: 'new', duration: 6, hidden: 5, at: 1.5 }

const added = (comp: CueComp, id: string): CompClip => {
  const c = comp.clips.find((x) => x.id === id)
  if (!c) throw new Error('missing clip')
  return c
}

describe('punchClip', () => {
  it('trims a clip crossing the punch point and joins with a short crossfade', () => {
    const r = punchClip({ clips: [clip()] }, punch)
    expect(r).not.toBeNull()
    if (!r) return
    expect(compProblem(r.comp)).toBeNull()
    const left = added(r.comp, 'a')
    expect(clipEnd(left)).toBeCloseTo(1.5)
    expect(left.crossfade).toBeCloseTo(PUNCH_CROSSFADE)
    const fresh = added(r.comp, r.clipId)
    expect(fresh).toMatchObject({ sourceTakeId: 'new', srcIn: 5, srcOut: 6, start: 1.5 })
    expect(fresh.trackId).toBeUndefined()
    expect(r.comp.clips).toHaveLength(2)
    const plan = compRenderPlan(r.comp.clips)
    expect(plan.find((p) => p.clip.id === r.clipId)?.crossfadeIn).toBeCloseTo(PUNCH_CROSSFADE)
  })

  it('removes clips after the punch point on the target track only', () => {
    const comp: CueComp = {
      clips: [
        clip({ id: 'a', srcOut: 1, trackId: 'track-1' }),
        clip({ id: 'b', start: 2, srcOut: 1, trackId: 'track-1' }),
        clip({ id: 'c', start: 4, srcOut: 1, trackId: 'track-1' }),
        clip({ id: 'o', start: 1, srcOut: 4, trackId: 'track-2' }),
      ],
      tracks: [track('track-1'), track('track-2')],
    }
    const r = punchClip(comp, { ...punch, targetTrackId: 'track-1' })
    if (!r) throw new Error('no placement')
    expect(r.comp.clips.map((c) => c.id).sort()).toEqual(['a', 'o', r.clipId].sort())
    expect(added(r.comp, 'o')).toEqual(comp.clips[3])
    expect(added(r.comp, 'a')).toEqual(comp.clips[0])
    expect(added(r.comp, r.clipId).trackId).toBe('track-1')
    expect(r.trackId).toBe('track-1')
    expect(compProblem(r.comp)).toBeNull()
  })

  it('punches into the requested track and leaves the other tracks untouched', () => {
    const comp: CueComp = {
      clips: [clip({ id: 'a', trackId: 'track-1' }), clip({ id: 'b', trackId: 'track-2' })],
      tracks: [track('track-1'), track('track-2')],
    }
    const r = punchClip(comp, { ...punch, targetTrackId: 'track-2' })
    if (!r) throw new Error('no placement')
    expect(added(r.comp, 'a')).toEqual(comp.clips[0])
    expect(clipEnd(added(r.comp, 'b'))).toBeCloseTo(1.5)
    expect(added(r.comp, r.clipId).trackId).toBe('track-2')
  })

  it('does not crossfade when the punch point sits in a gap', () => {
    const r = punchClip({ clips: [clip({ srcOut: 1 })] }, punch)
    if (!r) throw new Error('no placement')
    expect(added(r.comp, 'a')).toEqual(clip({ srcOut: 1 }))
    expect(r.comp.clips.every((c) => c.crossfade === undefined)).toBe(true)
  })

  it('replaces the whole track when punching at zero', () => {
    const r = punchClip({ clips: [clip(), clip({ id: 'b', start: 4 })] }, { ...punch, at: 0, hidden: 0 })
    if (!r) throw new Error('no placement')
    expect(r.comp.clips).toHaveLength(1)
    expect(r.comp.clips[0]).toMatchObject({ srcIn: 0, srcOut: 6, start: 0 })
  })

  it('places onto an empty or missing composition', () => {
    for (const comp of [undefined, { clips: [] }]) {
      const r = punchClip(comp, punch)
      if (!r) throw new Error('no placement')
      expect(r.comp.clips).toHaveLength(1)
      expect(r.comp.tracks).toBeUndefined()
      expect(r.trackId).toBe('track-1')
      expect(r.comp.clips[0]).toMatchObject({ start: 1.5, srcIn: 5, srcOut: 6 })
    }
  })

  it('keeps time-stretched clips in sync when trimming', () => {
    const c = clip({ srcOut: 4, edits: { ...emptyEdits(), timeStretch: 2 } })
    const r = punchClip({ clips: [c] }, punch)
    if (!r) throw new Error('no placement')
    expect(added(r.comp, 'a').srcOut).toBeCloseTo(3)
    expect(clipEnd(added(r.comp, 'a'))).toBeCloseTo(1.5)
  })

  it('refuses when nothing was recorded after the punch point', () => {
    const comp: CueComp = { clips: [clip()] }
    expect(punchClip(comp, { ...punch, duration: 5 })).toBeNull()
    expect(comp).toEqual({ clips: [clip()] })
  })

  it('does not mutate the input composition', () => {
    const comp: CueComp = { clips: [clip(), clip({ id: 'b', start: 4 })] }
    const before = structuredClone(comp)
    punchClip(comp, punch)
    expect(comp).toEqual(before)
  })
})

describe('recordClip', () => {
  const take = { takeId: 'new', duration: 2, at: 0 }

  it('replaces the clip under the playhead as a new version of the same clip', () => {
    const comp: CueComp = { clips: [clip({ edits: { ...emptyEdits(), gainDb: -3 } })] }
    for (const at of [0, 1.2]) {
      const r = recordClip(comp, { ...take, at })
      expect(r.clipId).toBe('a')
      expect(r.trackId).toBe('track-1')
      expect(r.comp).toEqual({
        clips: [{ id: 'a', sourceTakeId: 'new', srcIn: 0, srcOut: 2, start: 0, edits: emptyEdits() }],
      })
    }
  })

  it('overwrites whatever a longer retake runs into on the same track', () => {
    const comp: CueComp = { clips: [clip(), clip({ id: 'b', start: 3, srcOut: 2 }), clip({ id: 'c', start: 5 })] }
    const r = recordClip(comp, { ...take, duration: 5.5 })
    expect(compProblem(r.comp)).toBeNull()
    expect(r.comp.clips.map((c) => c.id)).toEqual(['a', 'c'])
    expect(added(r.comp, 'a')).toMatchObject({ sourceTakeId: 'new', start: 0, srcOut: 5.5 })
    expect(added(r.comp, 'c')).toMatchObject({ start: 5.5, srcIn: 0.5, srcOut: 3 })
  })

  it('places at the playhead in a gap and trims only the target track', () => {
    const comp: CueComp = {
      clips: [
        clip({ id: 'a', srcOut: 1, trackId: 'track-1' }),
        clip({ id: 'b', start: 2, srcOut: 0.5, trackId: 'track-1' }),
        clip({ id: 'c', start: 3, srcOut: 4, trackId: 'track-1' }),
        clip({ id: 'o', start: 1, srcOut: 4, trackId: 'track-2' }),
      ],
      tracks: [track('track-1'), track('track-2')],
    }
    const r = recordClip(comp, { ...take, at: 1.5, targetTrackId: 'track-1' })
    expect(compProblem(r.comp)).toBeNull()
    expect(r.comp.tracks).toEqual(comp.tracks)
    expect(r.trackId).toBe('track-1')
    expect(added(r.comp, r.clipId)).toMatchObject({ start: 1.5, srcIn: 0, srcOut: 2, trackId: 'track-1' })
    expect(added(r.comp, 'a')).toEqual(comp.clips[0])
    expect(r.comp.clips.some((c) => c.id === 'b')).toBe(false)
    expect(added(r.comp, 'c')).toMatchObject({ start: 3.5, srcIn: 0.5, srcOut: 4 })
    expect(added(r.comp, 'o')).toEqual(comp.clips[3])
  })

  it('treats a clip that ends at the playhead as a neighbour, not a hit', () => {
    const r = recordClip({ clips: [clip()] }, { ...take, at: 3 })
    expect(r.comp.clips.map((c) => c.id)).toEqual(['a', r.clipId])
    expect(added(r.comp, 'a')).toEqual(clip())
    expect(added(r.comp, r.clipId).start).toBe(3)
  })

  it('never creates a track, even when only another track is free', () => {
    const comp: CueComp = {
      clips: [clip({ id: 'a', trackId: 'track-1' })],
      tracks: [track('track-1'), track('track-2')],
    }
    const r = recordClip(comp, { ...take, at: 1, targetTrackId: 'track-1' })
    expect(r.comp.tracks).toEqual(comp.tracks)
    expect(r.comp.clips).toHaveLength(1)
    expect(added(r.comp, 'a')).toMatchObject({ sourceTakeId: 'new', trackId: 'track-1' })
    const single = recordClip({ clips: [clip()] }, { ...take, at: 4 })
    expect(single.comp.tracks).toBeUndefined()
    expect(single.comp.clips.every((c) => c.trackId === undefined)).toBe(true)
  })

  it('replaces on the target track only', () => {
    const comp: CueComp = {
      clips: [clip({ id: 'a', trackId: 'track-1' }), clip({ id: 'b', trackId: 'track-2' })],
      tracks: [track('track-1'), track('track-2')],
    }
    const r = recordClip(comp, { ...take, at: 1, targetTrackId: 'track-2' })
    expect(r.clipId).toBe('b')
    expect(added(r.comp, 'a')).toEqual(comp.clips[0])
    expect(added(r.comp, 'b')).toMatchObject({ sourceTakeId: 'new', srcOut: 2, trackId: 'track-2' })
  })

  it('places onto an empty or missing composition', () => {
    for (const comp of [undefined, { clips: [] }]) {
      const r = recordClip(comp, { ...take, at: 1 })
      expect(r.trackId).toBe('track-1')
      expect(r.comp).toEqual({
        clips: [{ id: r.clipId, sourceTakeId: 'new', srcIn: 0, srcOut: 2, start: 1, edits: emptyEdits() }],
      })
    }
  })

  it('keeps a time-stretched neighbour in sync when trimming its head', () => {
    const c = clip({ id: 'b', start: 1, srcOut: 4, edits: { ...emptyEdits(), timeStretch: 2 } })
    const r = recordClip({ clips: [c] }, take)
    expect(added(r.comp, 'b').start).toBeCloseTo(2)
    expect(added(r.comp, 'b').srcIn).toBeCloseTo(2)
    expect(clipEnd(added(r.comp, 'b'))).toBeCloseTo(3)
  })

  it('does not mutate the input composition', () => {
    const comp: CueComp = { clips: [clip(), clip({ id: 'b', start: 3 })] }
    const before = structuredClone(comp)
    recordClip(comp, { ...take, duration: 4 })
    recordClip(comp, { ...take, at: 6 })
    expect(comp).toEqual(before)
  })
})

describe('punch latency', () => {
  it('estimates from the output and input latencies it can read', () => {
    expect(latencyEstimate([0.01, 0.04, 0.02])).toBeCloseTo(0.07)
    expect(latencyEstimate([0.01, undefined, Number.NaN, -0.5, '0.2', null])).toBeCloseTo(0.01)
    expect(latencyEstimate([])).toBe(0)
    expect(latencyEstimate([0.8, 0.9])).toBe(1)
  })

  it('applies no correction when unset, the estimate on Auto and the manual value otherwise', () => {
    expect(latencySeconds(undefined, 0.07)).toBe(0)
    expect(latencySeconds('auto', 0.07)).toBeCloseTo(0.07)
    expect(latencySeconds('auto', 3)).toBe(1)
    expect(latencySeconds(100, 0.07)).toBeCloseTo(0.1)
    expect(latencySeconds(0, 0.07)).toBe(0)
    expect(latencySeconds(-250, 0.07)).toBeCloseTo(-0.25)
    expect(latencySeconds(5000, 0)).toBe(1)
    expect(latencySeconds(-5000, 0)).toBe(-1)
    expect(latencySeconds('100', 0.02)).toBe(0)
  })

  it('sanitizes a manual latency to whole milliseconds in range', () => {
    expect(recordLatencyMs(undefined)).toBeUndefined()
    expect(recordLatencyMs(Number.NaN)).toBeUndefined()
    expect(recordLatencyMs('12')).toBeUndefined()
    expect(recordLatencyMs('auto')).toBe('auto')
    expect(recordLatencyMs(12.4)).toBe(12)
    expect(recordLatencyMs(-12.6)).toBe(-13)
    expect(recordLatencyMs(1200)).toBe(1000)
    expect(recordLatencyMs(-1200)).toBe(-1000)
  })

  it('moves the take earlier without leaving the recorded audio', () => {
    expect(punchHidden(5, 0.1, 9)).toBeCloseTo(5.1)
    expect(punchHidden(5, 0, 9)).toBe(5)
    expect(punchHidden(0.05, -0.2, 9)).toBe(0)
    expect(punchHidden(5, 1, 5.5)).toBe(5.5)
  })

  it('bounds the pre-roll to 0–10 s in half-second steps', () => {
    for (const junk of [undefined, null, '3', Number.NaN, {}]) expect(punchPrerollSeconds(junk)).toBe(5)
    expect(punchPrerollSeconds(0)).toBe(0)
    expect(punchPrerollSeconds(2)).toBe(2)
    expect(punchPrerollSeconds(2.3)).toBe(2.5)
    expect(punchPrerollSeconds(-1)).toBe(0)
    expect(punchPrerollSeconds(12)).toBe(10)
  })

  it('keeps the punch point and trims the latency from the take', () => {
    const hidden = punchHidden(punch.hidden, latencySeconds(100, 0), punch.duration)
    const r = punchClip({ clips: [clip()] }, { ...punch, hidden })
    if (!r) throw new Error('no placement')
    expect(added(r.comp, r.clipId)).toMatchObject({ start: 1.5, srcOut: 6 })
    expect(added(r.comp, r.clipId).srcIn).toBeCloseTo(5.1)
    expect(clipEnd(added(r.comp, 'a'))).toBeCloseTo(1.5)
    expect(compProblem(r.comp)).toBeNull()
  })

  it('places exactly as before when there is no latency to correct', () => {
    const hidden = punchHidden(punch.hidden, latencySeconds(undefined, 0), punch.duration)
    expect(hidden).toBe(punch.hidden)
    const before = punchClip({ clips: [clip()] }, punch)
    const after = punchClip({ clips: [clip()] }, { ...punch, hidden })
    if (!before || !after) throw new Error('no placement')
    expect(after.comp.clips.map(({ id: _, ...c }) => c)).toEqual(before.comp.clips.map(({ id: _, ...c }) => c))
  })

  it('refuses when the correction leaves nothing after the punch point', () => {
    const hidden = punchHidden(punch.hidden, latencySeconds(1000, 0), punch.duration)
    expect(punchClip({ clips: [clip()] }, { ...punch, hidden })).toBeNull()
  })
})
