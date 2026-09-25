import { describe, expect, it } from 'vitest'
import { clipEnd, compProblem, compRenderPlan } from '../src/shared/comp'
import { emptyEdits, type CompClip, type CompTrack, type CueComp } from '../src/shared/domain'
import { PUNCH_CROSSFADE, punchClip } from '../src/shared/library'

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
