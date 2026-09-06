import { describe, expect, it } from 'vitest'
import {
  clipZone,
  EDGE_PX,
  FADE_BAND_PX,
  FADE_HANDLE_PX,
  playheadX,
  type TimelineView,
} from '../src/shared/timeline-math'
import { playBounds } from '../src/shared/resume'
import {
  compOriginalStart,
  compRegionBounds,
  cutCandidate,
  normalizeComp,
  setOriginalStart,
  setRegionEdge,
} from '../src/shared/comp'
import { ghostPlacement } from '../src/shared/generation'
import { emptyEdits, sanitizeOriginalStart, type CompClip, type CueComp } from '../src/shared/domain'
import { compSchema, projectFileSchema } from '../src/main/schemas'

const view = (pxPerSec: number, scroll = 0): TimelineView => ({ pxPerSec, scroll })

const clip = (patch: Partial<CompClip> = {}): CompClip => ({
  id: 'c1',
  sourceTakeId: 't1',
  srcIn: 0,
  srcOut: 2,
  start: 0,
  edits: emptyEdits(),
  ...patch,
})

const zone = (patch: Partial<Parameters<typeof clipZone>[0]> = {}) =>
  clipZone({ width: 200, lx: 100, ly: 60, fadeInPx: 0, fadeOutPx: 0, gainY: 70, ...patch })

describe('playheadX', () => {
  it('offsets by the strip inside the body', () => {
    expect(playheadX(view(100), 1, 190, 500)).toBe(290)
  })

  it('hides the head scrolled off the left of the body', () => {
    expect(playheadX(view(100, 4), 1, 190, 500)).toBeNull()
  })

  it('hides the head past the right of the body', () => {
    expect(playheadX(view(100), 6, 190, 500)).toBeNull()
    expect(playheadX(view(100), 5, 190, 500)).toBe(690)
  })
})

describe('clipZone', () => {
  it('trims on either edge below the fade band', () => {
    expect(zone({ lx: 0 })).toBe('trimStart')
    expect(zone({ lx: EDGE_PX })).toBe('trimStart')
    expect(zone({ lx: 200 - EDGE_PX })).toBe('trimEnd')
    expect(zone({ lx: EDGE_PX + 1 })).toBe('move')
  })

  it('keeps the trim zone at the edges even at the very top of the body', () => {
    expect(zone({ lx: 2, ly: FADE_BAND_PX + 1 })).toBe('trimStart')
    expect(zone({ lx: 198, ly: FADE_BAND_PX + 1 })).toBe('trimEnd')
  })

  it('grabs the fade handles inside the top band', () => {
    expect(zone({ lx: 0, ly: 2 })).toBe('fadeIn')
    expect(zone({ lx: 200, ly: 2 })).toBe('fadeOut')
    expect(zone({ lx: FADE_HANDLE_PX + 1, ly: 2 })).toBe('move')
  })

  it('follows the fade end once a fade exists', () => {
    expect(zone({ lx: 40, ly: 2, fadeInPx: 40 })).toBe('fadeIn')
    expect(zone({ lx: 160, ly: 2, fadeOutPx: 40 })).toBe('fadeOut')
  })

  it('grabs the gain line in the clip body', () => {
    expect(zone({ ly: 70 })).toBe('gain')
    expect(zone({ ly: 90 })).toBe('move')
  })
})

describe('playBounds', () => {
  it('stops at the content end when there is no region', () => {
    expect(playBounds(4.5)).toEqual({ from: 0, until: 4.5 })
    expect(playBounds(4.5, null)).toEqual({ from: 0, until: 4.5 })
  })

  it('clamps a region into the content', () => {
    expect(playBounds(4, { in: 1, out: 9 })).toEqual({ from: 1, until: 4 })
    expect(playBounds(4, { in: -2, out: 3 })).toEqual({ from: 0, until: 3 })
  })

  it('never returns an inverted window', () => {
    expect(playBounds(4, { in: 3, out: 1 })).toEqual({ from: 3, until: 3 })
  })
})

describe('region bounds and markers', () => {
  it('falls back to zero and the content end without a region', () => {
    expect(compRegionBounds({ clips: [] }, 3.2)).toEqual({ in: 0, out: 3.2 })
  })

  it('setting only out keeps in at zero', () => {
    const comp = setRegionEdge({ clips: [clip({ srcOut: 5 })] }, 'out', 3)
    expect(comp.region).toEqual({ in: 0, out: 3 })
  })

  it('setting only in keeps out at the content end', () => {
    const comp = setRegionEdge({ clips: [clip({ srcOut: 5 })] }, 'in', 2)
    expect(comp.region).toEqual({ in: 2, out: 5 })
  })
})

describe('cutCandidate', () => {
  const comp: CueComp = {
    clips: [
      clip({ id: 'a', start: 0, srcOut: 2, trackId: 'track-1' }),
      clip({ id: 'b', start: 0, srcOut: 2, trackId: 'track-2' }),
    ],
    tracks: [
      { id: 'track-1', name: 'T1', gainDb: 0, muted: false, solo: false },
      { id: 'track-2', name: 'T2', gainDb: 0, muted: false, solo: false },
    ],
  }

  it('picks the clip under the playhead on the target track', () => {
    expect(cutCandidate(comp, 1, 'track-2')?.id).toBe('b')
  })

  it('falls back to the selected clip spanning the playhead', () => {
    expect(cutCandidate({ clips: [comp.clips[1]] }, 1, 'track-1', 'b')?.id).toBe('b')
  })

  it('ignores a playhead sitting on an edge', () => {
    expect(cutCandidate(comp, 0, 'track-1')).toBeNull()
    expect(cutCandidate(comp, 2, 'track-1')).toBeNull()
  })
})

describe('ghostPlacement', () => {
  const track = (id: string) => ({ id, name: id, gainDb: 0, muted: false, solo: false })

  it('lands at the playhead on the target track when free', () => {
    expect(ghostPlacement({ takeId: 't', duration: 2, playhead: 1.5 })).toEqual({
      trackId: 'track-1',
      start: 1.5,
      end: 3.5,
    })
  })

  it('drops to the next free track when the target is occupied', () => {
    const comp: CueComp = {
      clips: [clip({ id: 'a', start: 1, srcOut: 3, trackId: 'track-1' })],
      tracks: [track('track-1'), track('track-2')],
    }
    const g = ghostPlacement({ comp, takeId: 't', duration: 2, targetTrackId: 'track-1', playhead: 2 })
    expect(g).toEqual({ trackId: 'track-2', start: 2, end: 4 })
  })

  it('outlines the clip being replaced', () => {
    const comp: CueComp = { clips: [clip({ id: 'a', start: 1, srcOut: 3 })] }
    const g = ghostPlacement({ comp, takeId: 't', duration: 1, playhead: 0, replaceClipId: 'a' })
    expect(g).toEqual({ trackId: 'track-1', start: 1, end: 2, replaceClipId: 'a' })
  })

  it('has nothing to show without a duration', () => {
    expect(ghostPlacement({ takeId: 't', duration: 0, playhead: 0 })).toBeNull()
  })
})

describe('originalStart', () => {
  it('sanitizes to undefined unless it is a positive finite number', () => {
    expect(sanitizeOriginalStart(undefined)).toBeUndefined()
    expect(sanitizeOriginalStart(0)).toBeUndefined()
    expect(sanitizeOriginalStart(-1)).toBeUndefined()
    expect(sanitizeOriginalStart(Number.NaN)).toBeUndefined()
    expect(sanitizeOriginalStart('2')).toBeUndefined()
    expect(sanitizeOriginalStart(1.25)).toBe(1.25)
    expect(sanitizeOriginalStart(1e9)).toBe(36000)
  })

  it('survives normalizeComp and reads back through compOriginalStart', () => {
    const comp = normalizeComp({ clips: [clip()], originalStart: 1.5 })
    expect(comp.originalStart).toBe(1.5)
    expect(compOriginalStart(comp)).toBe(1.5)
  })

  it('is absent on compositions that never used it', () => {
    const comp = normalizeComp({ clips: [clip()] })
    expect('originalStart' in comp).toBe(false)
    expect(compOriginalStart(comp)).toBe(0)
    expect(JSON.stringify(comp)).toBe(JSON.stringify({ clips: comp.clips }))
  })

  it('drops the field again when moved back to zero', () => {
    const comp = setOriginalStart(normalizeComp({ clips: [clip()], originalStart: 2 }), 0)
    expect('originalStart' in comp).toBe(false)
  })

  it('roundtrips through the project schema', () => {
    const comp: CueComp = { clips: [clip()], originalStart: 2.5 }
    const parsed = compSchema.parse(JSON.parse(JSON.stringify(comp)))
    expect(parsed?.originalStart).toBe(2.5)
  })

  it('leaves an old project byte-identical', () => {
    const project = {
      id: 'p',
      schemaVersion: 1,
      name: 'Legacy',
      createdAt: '2026-01-01T00:00:00.000Z',
      media: { referenceDir: 'ref', referencePattern: '{key}.wav' },
      characters: [],
      cues: [
        {
          id: 'c',
          key: 'K1',
          fields: { EventName: 'Hello' },
          sourceText: 'Hello',
          text: 'Привіт',
          status: 'generated',
          notes: '',
          takes: [],
          comp: { clips: [clip()], region: { in: 0, out: 2 } },
        },
      ],
      sessions: [],
      pronunciationRules: '',
      exportTemplate: '{EventName}.{ext}',
    }
    const before = JSON.stringify(project)
    const parsed = projectFileSchema.parse(JSON.parse(before))
    expect(parsed).toEqual(project)
    const cue = parsed.cues[0]
    expect(compOriginalStart(cue.comp)).toBe(0)
    expect(JSON.stringify(normalizeComp(cue.comp!))).toBe(JSON.stringify(cue.comp))
  })
})
