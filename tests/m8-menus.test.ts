import { describe, expect, it } from 'vitest'
import {
  canRemoveTrack,
  clipBoundaries,
  compTracks,
  duplicateTrack,
  fitToLength,
  locateText,
  moveTrack,
  removeTrack,
  splitClipIntoWords,
} from '../src/shared/library'
import { clipEnd, clipTimelineDuration, clipTrackId, compProblem } from '../src/shared/comp'
import { setExcluded } from '../src/shared/approval'
import { applyProjectCommand } from '../src/shared/project-commands'
import {
  emptyEdits,
  type CompClip,
  type Cue,
  type CueComp,
  type Project,
  type Take,
} from '../src/shared/domain'

const words = (list: [string, number, number][]): { text: string; start: number; end: number }[] =>
  list.map(([text, start, end]) => ({ text, start, end }))

const take = (id: string, over: Partial<Take> = {}): Take => ({
  id,
  kind: 'tts',
  createdAt: '2026-01-01T00:00:00.000Z',
  file: { fileId: id, relPath: `${id}.mp3`, format: 'mp3' },
  duration: 3,
  meta: {},
  edits: emptyEdits(),
  ...over,
})

const cue = (over: Partial<Cue> = {}): Cue => ({
  id: 'c1',
  characterId: 'ch',
  key: 'c1',
  fields: {},
  sourceText: 'S',
  text: 'one two three',
  status: 'generated',
  notes: '',
  takes: [],
  ...over,
})

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'k1',
  sourceTakeId: 't1',
  srcIn: 0,
  srcOut: 3,
  start: 0,
  edits: emptyEdits(),
  ...over,
})

const t1 = take('t1', {
  meta: { text: 'one two three' },
  words: words([
    ['one', 0, 1],
    ['two', 1, 2],
    ['three', 2, 3],
  ]),
})

const lineCue = cue({ takes: [t1] })
const project = { cues: [lineCue] }

describe('split by words', () => {
  const comp: CueComp = { clips: [clip()] }

  it('finds the interior word boundaries of a clip', () => {
    expect(clipBoundaries(comp, lineCue, project, 'k1')).toEqual([1, 2])
  })

  it('makes one clip per word and keeps the composition valid', () => {
    const next = splitClipIntoWords(comp, lineCue, project, 'k1')
    expect(next.clips).toHaveLength(3)
    expect(next.clips.map((c) => [c.start, clipEnd(c)])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ])
    expect(compProblem(next)).toBeNull()
  })

  it('leaves a clip without word timings alone', () => {
    const plain = cue({ takes: [take('t1', { meta: { text: 'one two three' } })] })
    const next = splitClipIntoWords(comp, plain, { cues: [plain] }, 'k1')
    expect(next.clips).toHaveLength(1)
  })
})

describe('fit to original length', () => {
  it('stretches the clip so its timeline duration matches the target', () => {
    const comp: CueComp = { clips: [clip()] }
    const next = fitToLength(comp, 'k1', 4)
    expect(clipTimelineDuration(next.clips[0])).toBeCloseTo(4, 6)
    expect(next.clips[0].edits.timeStretch).toBeCloseTo(0.75, 6)
  })

  it('compresses a clip that is longer than the original', () => {
    const comp: CueComp = { clips: [clip()] }
    expect(clipTimelineDuration(fitToLength(comp, 'k1', 1.5).clips[0])).toBeCloseTo(1.5, 6)
  })

  it('ignores a target that is not a positive length', () => {
    const comp: CueComp = { clips: [clip()] }
    expect(fitToLength(comp, 'k1', 0)).toBe(comp)
    expect(fitToLength(comp, 'k1', Number.NaN)).toBe(comp)
  })
})

describe('locate text on the timeline', () => {
  const comp: CueComp = {
    clips: [clip({ id: 'k1', srcIn: 0, srcOut: 2, start: 0 }), clip({ id: 'k2', srcIn: 2, srcOut: 3, start: 2 })],
  }

  it('finds the clip that holds a word selection', () => {
    const hit = locateText(comp, lineCue, project, { start: 4, end: 7 })
    expect(hit).toEqual({ clipId: 'k1', time: 1 })
  })

  it('follows a selection into the next clip', () => {
    const hit = locateText(comp, lineCue, project, { start: 8, end: 13 })
    expect(hit).toEqual({ clipId: 'k2', time: 2 })
  })

  it('takes the word at the caret when nothing is selected', () => {
    expect(locateText(comp, lineCue, project, { start: 5, end: 5 })?.time).toBe(1)
    expect(locateText(comp, lineCue, project, { start: 0, end: 0 })?.time).toBe(0)
  })

  it('ignores punctuation and case', () => {
    const spoken = cue({ text: 'One, TWO! three', takes: [t1] })
    expect(locateText(comp, spoken, { cues: [spoken] }, { start: 6, end: 10 })?.time).toBe(1)
  })

  it('returns nothing when the words are not on the timeline', () => {
    const other = cue({ text: 'absent word', takes: [t1] })
    expect(locateText(comp, other, { cues: [other] }, { start: 0, end: 6 })).toBeNull()
    expect(locateText({ clips: [] }, lineCue, project, { start: 0, end: 3 })).toBeNull()
  })

  it('respects the clip speed when reporting a time', () => {
    const fast: CueComp = {
      clips: [clip({ edits: { ...emptyEdits(), timeStretch: 2 } })],
    }
    expect(locateText(fast, lineCue, project, { start: 4, end: 7 })?.time).toBeCloseTo(0.5, 6)
  })
})

describe('track operations', () => {
  const tracks = [
    { id: 'track-1', name: 'Track 1', gainDb: 0, muted: false, solo: false },
    { id: 'track-2', name: 'Track 2', gainDb: -3, muted: true, solo: false },
  ]
  const comp: CueComp = {
    clips: [clip({ id: 'k1', trackId: 'track-1' })],
    tracks,
  }

  it('duplicates a track with its settings and its clips', () => {
    const next = duplicateTrack(comp, 'track-1')
    const added = compTracks(next)[1]
    expect(compTracks(next).map((t) => t.id)).toEqual(['track-1', added.id, 'track-2'])
    expect(added.name).toBe('Track 1 copy')
    expect(next.clips).toHaveLength(2)
    expect(next.clips.filter((c) => clipTrackId(c) === added.id)).toHaveLength(1)
    expect(new Set(next.clips.map((c) => c.id)).size).toBe(2)
    expect(compProblem(next)).toBeNull()
  })

  it('carries the source track gain and mute onto the copy', () => {
    const added = compTracks(duplicateTrack(comp, 'track-2'))[2]
    expect(added.gainDb).toBe(-3)
    expect(added.muted).toBe(true)
  })

  it('moves a track up and down and stops at the ends', () => {
    expect(compTracks(moveTrack(comp, 'track-2', -1)).map((t) => t.id)).toEqual([
      'track-2',
      'track-1',
    ])
    expect(moveTrack(comp, 'track-1', -1)).toBe(comp)
    expect(moveTrack(comp, 'track-2', 1)).toBe(comp)
    expect(moveTrack(comp, 'nope', 1)).toBe(comp)
  })

  it('keeps the clips on their tracks when the order changes', () => {
    const next = moveTrack(comp, 'track-2', -1)
    expect(clipTrackId(next.clips[0])).toBe('track-1')
    expect(compProblem(next)).toBeNull()
  })

  it('deletes only an empty track that is not the last one', () => {
    expect(canRemoveTrack(comp, 'track-1')).toBe(false)
    expect(canRemoveTrack(comp, 'track-2')).toBe(true)
    expect(removeTrack(comp, 'track-1')).toBe(comp)
    expect(compTracks(removeTrack(comp, 'track-2')).map((t) => t.id)).toEqual(['track-1'])
    const single: CueComp = { clips: [], tracks: [tracks[0]] }
    expect(canRemoveTrack(single, 'track-1')).toBe(false)
  })
})

describe('exclude a line from export', () => {
  it('marks and clears the excluded status', () => {
    const generated = cue({ status: 'generated' })
    expect(setExcluded(generated, true).status).toBe('excluded')
    expect(setExcluded(setExcluded(generated, true), false).status).toBe('translated')
    expect(setExcluded(generated, false)).toBe(generated)
  })

  it('falls back to empty when the line has no translation', () => {
    const blank = cue({ status: 'excluded', text: '   ' })
    expect(setExcluded(blank, false).status).toBe('empty')
  })

  it('rides the command pipeline both ways', () => {
    const p: Project = {
      id: 'p',
      schemaVersion: 1,
      createdAt: 'now',
      updatedAt: 'now',
      name: 'p',
      sourceLang: 'en',
      targetLang: 'uk',
      characters: [{ id: 'ch', name: 'Ch', color: '#fff', provider: {} }],
      cues: [cue()],
      ui: {},
    } as unknown as Project
    expect(
      applyProjectCommand(p, { type: 'cue.setExcluded', cueId: 'c1', excluded: true }).cues?.[0]
        .status
    ).toBe('excluded')
    expect(
      applyProjectCommand(p, { type: 'cue.setExcluded', cueId: 'c1', excluded: false }).cues?.[0]
        .status
    ).toBe('translated')
  })
})
