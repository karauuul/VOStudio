import { describe, expect, it } from 'vitest'
import {
  compProblem,
  compRenderPlan,
  moveClipTo,
  normalizeComp,
  setClipEdits,
  setRegion,
  splitClipAt,
} from '../src/shared/comp'
import { emptyEdits, type CompClip, type CompTrack, type CueComp } from '../src/shared/domain'

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'a',
  sourceTakeId: 't1',
  srcIn: 0,
  srcOut: 2,
  start: 0,
  edits: emptyEdits(),
  ...over,
})

const track = (id: string, over: Partial<CompTrack> = {}): CompTrack => ({
  id,
  name: id,
  gainDb: 0,
  muted: false,
  solo: false,
  ...over,
})

const twoTracks = [track('track-1'), track('track-2')]

describe('a composition without tracks behaves exactly as before', () => {
  const legacy: CueComp = {
    clips: [clip({ id: 'a' }), clip({ id: 'b', start: 2 })],
    region: { in: 0, out: 3 },
  }

  it('normalizeComp adds no keys', () => {
    expect(JSON.stringify(normalizeComp(legacy))).toBe(JSON.stringify(legacy))
    expect(normalizeComp(legacy)).not.toHaveProperty('tracks')
  })

  it('overlapping clips are still a problem', () => {
    expect(compProblem({ clips: [clip({ id: 'a' }), clip({ id: 'b', start: 1 })] })).toBe(
      'clips "a" and "b" overlap'
    )
    expect(compProblem(legacy)).toBeNull()
  })

  it('the render plan is unchanged', () => {
    const clips = [clip({ id: 'a', crossfade: 0.5 }), clip({ id: 'b', start: 2, srcIn: 1, srcOut: 3 })]
    const plan = compRenderPlan(clips)
    expect(plan[0].crossfadeOut).toBe(0.5)
    expect(plan[1].crossfadeIn).toBe(0.5)
    expect(plan[1].clip.start).toBe(1.5)
  })
})

describe('normalizeComp keeps tracks', () => {
  it('sanitizes them: clamped gain, defaulted name, no duplicate ids', () => {
    const comp = normalizeComp({
      clips: [clip()],
      tracks: [
        { id: 'track-1', name: '', gainDb: 200, muted: false, solo: false },
        { id: 'track-1', name: 'dup', gainDb: 0, muted: false, solo: false },
        { id: '', name: 'no id', gainDb: 0, muted: false, solo: false },
      ],
    })
    expect(comp.tracks).toEqual([track('track-1', { gainDb: 24 })])
  })

  it('an empty tracks array leaves no key behind', () => {
    expect(normalizeComp({ clips: [clip()], tracks: [] })).not.toHaveProperty('tracks')
  })

  it('every comp mutation carries them through', () => {
    const comp: CueComp = {
      clips: [clip({ id: 'a', trackId: 'track-2' })],
      region: { in: 0, out: 1 },
      tracks: twoTracks,
    }
    expect(splitClipAt(comp, 'a', 1).tracks).toEqual(twoTracks)
    expect(moveClipTo(comp, 'a', 3).tracks).toEqual(twoTracks)
    expect(setClipEdits(comp, 'a', { gainDb: -3 }).tracks).toEqual(twoTracks)
    expect(setRegion(comp, null).tracks).toEqual(twoTracks)
    expect(setRegion(comp, { in: 0, out: 2 }).tracks).toEqual(twoTracks)
  })
})

describe('compProblem with tracks', () => {
  it('a clip must point at an existing track', () => {
    expect(
      compProblem({ clips: [clip({ id: 'a', trackId: 'nope' })], tracks: twoTracks })
    ).toBe('clip "a" points at unknown track "nope"')
  })

  it('a clip without a trackId needs the implicit first track to exist', () => {
    expect(compProblem({ clips: [clip({ id: 'a' })], tracks: [track('track-2')] })).toBe(
      'clip "a" points at unknown track "track-1"'
    )
    expect(compProblem({ clips: [clip({ id: 'a' })], tracks: twoTracks })).toBeNull()
  })

  it('duplicate track ids are rejected', () => {
    expect(compProblem({ clips: [], tracks: [track('x'), track('x')] })).toBe(
      'duplicate track id "x"'
    )
  })

  it('clips may overlap across tracks but not inside one', () => {
    expect(
      compProblem({
        clips: [clip({ id: 'a' }), clip({ id: 'b', start: 1, trackId: 'track-2' })],
        tracks: twoTracks,
      })
    ).toBeNull()
    expect(
      compProblem({
        clips: [clip({ id: 'a', trackId: 'track-2' }), clip({ id: 'b', start: 1, trackId: 'track-2' })],
        tracks: twoTracks,
      })
    ).toBe('clips "a" and "b" overlap')
  })
})

describe('compRenderPlan crossfades only inside one track', () => {
  const neighbours = (trackId?: string): CompClip[] => [
    clip({ id: 'a', crossfade: 0.5 }),
    clip({ id: 'b', start: 2, srcIn: 1, srcOut: 3, ...(trackId ? { trackId } : {}) }),
  ]

  it('same track: the crossfade lands', () => {
    const plan = compRenderPlan(neighbours())
    expect([plan[0].crossfadeOut, plan[1].crossfadeIn]).toEqual([0.5, 0.5])
  })

  it('different tracks: no crossfade and no source shift', () => {
    const plan = compRenderPlan(neighbours('track-2'))
    expect([plan[0].crossfadeOut, plan[1].crossfadeIn]).toEqual([0, 0])
    expect(plan[1].clip.start).toBe(2)
    expect(plan[1].clip.srcIn).toBe(1)
  })
})
