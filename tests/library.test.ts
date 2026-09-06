import { describe, expect, it } from 'vitest'
import {
  addTrack,
  clipText,
  clipTrackId,
  clipVersions,
  clipWords,
  compTracks,
  libraryGroups,
  nearestPoint,
  placeClip,
  referencedByOtherComp,
  resolveTake,
  splitClipByWord,
  updateTrack,
  versionLabel,
  wordSnapPoints,
  wordsFromAlignment,
} from '../src/shared/library'
import { compProblem } from '../src/shared/comp'
import {
  emptyEdits,
  type CompClip,
  type Cue,
  type CueComp,
  type Project,
  type Take,
  type TakeKind,
} from '../src/shared/domain'

const take = (id: string, over: Partial<Take> = {}): Take => ({
  id,
  kind: 'tts' as TakeKind,
  createdAt: '2026-01-01T00:00:00.000Z',
  file: { fileId: id, relPath: `${id}.mp3`, format: 'mp3' },
  duration: 1,
  meta: {},
  edits: emptyEdits(),
  ...over,
})

const cue = (id: string, over: Partial<Cue> = {}): Cue => ({
  id,
  characterId: 'ch',
  key: id,
  fields: {},
  sourceText: 'S',
  text: 'Line text',
  status: 'generated',
  notes: '',
  takes: [],
  ...over,
})

const project = (cues: Cue[]): Project => ({
  id: 'p',
  schemaVersion: 1,
  createdAt: 'now',
  name: 'P',
  media: { referenceDir: '', referencePattern: '' },
  characters: [],
  cues,
  sessions: [],
  pronunciationRules: '',
  exportTemplate: '',
  ui: { filter: '', search: '' },
})

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'c1',
  sourceTakeId: 't1',
  srcIn: 0,
  srcOut: 1,
  start: 0,
  edits: emptyEdits(),
  ...over,
})

describe('tracks of a composition', () => {
  it('an absent tracks array means one implicit track', () => {
    expect(compTracks({ clips: [] })).toEqual([
      { id: 'track-1', name: 'Track 1', gainDb: 0, muted: false, solo: false },
    ])
  })

  it('a present tracks array is returned untouched', () => {
    const tracks = [{ id: 'a', name: 'A', gainDb: -3, muted: true, solo: false }]
    expect(compTracks({ clips: [], tracks })).toBe(tracks)
  })

  it('a clip without a trackId belongs to the first implicit track', () => {
    expect(clipTrackId(clip())).toBe('track-1')
    expect(clipTrackId(clip({ trackId: 'track-2' }))).toBe('track-2')
  })
})

describe('resolveTake', () => {
  const own = take('own')
  const pinned = take('pin', { pinned: true })
  const plain = take('plain')
  const buried = take('buried', { pinned: true, deletedAt: 'then' })
  const a = cue('a', { takes: [own, take('gone', { deletedAt: 'then' })] })
  const b = cue('b', { takes: [pinned, plain, buried] })
  const p = project([a, b])

  it('finds the cue own take first', () => {
    expect(resolveTake(p, a, 'own')).toEqual({ take: own, cue: a })
  })

  it('keeps resolving a soft deleted take of the same cue, as before', () => {
    expect(resolveTake(p, a, 'gone')?.take.id).toBe('gone')
    expect(resolveTake(undefined, a, 'gone')?.take.id).toBe('gone')
  })

  it('finds a live pinned take of another cue', () => {
    expect(resolveTake(p, a, 'pin')).toEqual({ take: pinned, cue: b })
  })

  it('never reaches an unpinned or deleted take of another cue', () => {
    expect(resolveTake(p, a, 'plain')).toBeUndefined()
    expect(resolveTake(p, a, 'buried')).toBeUndefined()
  })

  it('without a project only the cue own takes resolve', () => {
    expect(resolveTake(undefined, a, 'pin')).toBeUndefined()
  })
})

describe('referencedByOtherComp', () => {
  const p = project([
    cue('a', { takes: [take('t1', { pinned: true })] }),
    cue('b', { comp: { clips: [clip({ sourceTakeId: 't1' })] } }),
  ])

  it('sees a clip of another cue', () => {
    expect(referencedByOtherComp(p, 'a', 't1')).toBe(true)
  })

  it('ignores the cue own composition', () => {
    expect(referencedByOtherComp(p, 'b', 't1')).toBe(false)
  })
})

describe('libraryGroups', () => {
  const c = cue('a', {
    text: 'Current translation',
    takes: [
      take('v1', { createdAt: '2026-01-01T00:00:01.000Z', meta: { text: ' Hello ' } }),
      take('r1', { kind: 'recording', createdAt: '2026-01-01T00:00:02.000Z', meta: { text: 'Hello' } }),
      take('v2', { createdAt: '2026-01-01T00:00:03.000Z', meta: { text: 'Hello' } }),
      take('old', { createdAt: '2026-01-01T00:00:04.000Z' }),
      take('dead', { createdAt: '2026-01-01T00:00:05.000Z', deletedAt: 'then' }),
    ],
    comp: { clips: [clip({ sourceTakeId: 'v2' })] },
  })
  const groups = libraryGroups(c, project([c]))

  it('groups by trimmed text in order of first creation', () => {
    expect(groups.map((g) => g.text)).toEqual(['Hello', 'Current translation'])
  })

  it('labels versions and recordings on separate counters', () => {
    expect(groups[0].rows.map((r) => `${r.take.id}:${r.label}`)).toEqual([
      'v1:v1',
      'r1:take 1',
      'v2:v2',
    ])
  })

  it('falls back to the cue current text and drops deleted takes', () => {
    expect(groups[1].rows.map((r) => r.take.id)).toEqual(['old'])
  })

  it('marks the rows used by a clip of this composition', () => {
    expect(groups[0].rows.map((r) => r.used)).toEqual([false, false, true])
  })

  it('appends pinned takes of other cues with a use count', () => {
    const mine = cue('a', { text: 'Mine', takes: [take('m1')] })
    const other = cue('b', {
      text: 'Shared',
      takes: [take('p1', { pinned: true }), take('p2')],
    })
    const user = cue('c', { comp: { clips: [clip({ sourceTakeId: 'p1' })] } })
    const all = libraryGroups(mine, project([mine, other, user]))
    expect(all.map((g) => g.text)).toEqual(['Mine', 'Shared'])
    expect(all[1]).toMatchObject({ pinned: true, useCount: 1 })
    expect(all[1].rows.map((r) => r.take.id)).toEqual(['p1'])
  })
})

describe('clipWords', () => {
  const words = [
    { text: 'one', start: 0, end: 1 },
    { text: 'two', start: 1, end: 2 },
    { text: 'three', start: 2, end: 3 },
  ]

  it('cuts to the clip range and shifts to clip-local seconds', () => {
    expect(clipWords(take('t', { words }), 1, 3)).toEqual([
      { text: 'two', start: 0, end: 1 },
      { text: 'three', start: 1, end: 2 },
    ])
  })

  it('a take without words shows its text as one word', () => {
    expect(clipWords(take('t', { meta: { text: 'Whole line' } }), 0, 2)).toEqual([
      { text: 'Whole line', start: 0, end: 2 },
    ])
  })

  it('a take with neither words nor text has no words', () => {
    expect(clipWords(take('t'), 0, 2)).toEqual([])
  })
})

describe('placeClip', () => {
  const req = {
    duration: 2,
    targetTrackId: 'track-1',
    playhead: 0,
    sourceTakeId: 'new',
    edits: emptyEdits(),
  }

  it('replacing keeps the start and the track and takes the whole new source', () => {
    const comp: CueComp = {
      clips: [clip({ id: 'c1', start: 5, srcIn: 3, srcOut: 4, trackId: 'track-2' })],
      tracks: [
        { id: 'track-1', name: 'Track 1', gainDb: 0, muted: false, solo: false },
        { id: 'track-2', name: 'Track 2', gainDb: 0, muted: false, solo: false },
      ],
    }
    const placed = placeClip(comp, { ...req, replaceClipId: 'c1' })
    expect(placed).toMatchObject({ clipId: 'c1', trackId: 'track-2' })
    expect(placed.comp.clips[0]).toMatchObject({
      start: 5,
      srcIn: 0,
      srcOut: 2,
      sourceTakeId: 'new',
      trackId: 'track-2',
    })
  })

  it('lands at the playhead on a free target track and leaves a track-less comp track-less', () => {
    const placed = placeClip({ clips: [] }, { ...req, playhead: 1.5 })
    expect(placed.trackId).toBe('track-1')
    expect(placed.comp.tracks).toBeUndefined()
    expect(placed.comp.clips[0]).toMatchObject({ start: 1.5, srcIn: 0, srcOut: 2 })
    expect(placed.comp.clips[0].trackId).toBeUndefined()
  })

  it('moves to the next free track below when the target is occupied', () => {
    const comp: CueComp = {
      clips: [clip({ id: 'c1', start: 0, srcOut: 3 })],
      tracks: [
        { id: 'track-1', name: 'Track 1', gainDb: 0, muted: false, solo: false },
        { id: 'track-2', name: 'Track 2', gainDb: 0, muted: false, solo: false },
      ],
    }
    const placed = placeClip(comp, req)
    expect(placed.trackId).toBe('track-2')
    expect(placed.comp.tracks).toHaveLength(2)
    expect(compProblem(placed.comp)).toBeNull()
  })

  it('creates a new track when every track below is occupied', () => {
    const comp: CueComp = { clips: [clip({ id: 'c1', start: 0, srcOut: 3 })] }
    const placed = placeClip(comp, req)
    expect(placed.trackId).toBe('track-2')
    expect(placed.comp.tracks).toEqual([
      { id: 'track-1', name: 'Track 1', gainDb: 0, muted: false, solo: false },
      { id: 'track-2', name: 'Track 2', gainDb: 0, muted: false, solo: false },
    ])
    expect(compProblem(placed.comp)).toBeNull()
  })
})

describe('wordsFromAlignment', () => {
  const alignment = (text: string): unknown => ({
    characters: [...text],
    character_start_times_seconds: [...text].map((_, i) => i * 0.1),
    character_end_times_seconds: [...text].map((_, i) => (i + 1) * 0.1),
  })

  it('groups characters at whitespace and keeps punctuation on the word', () => {
    expect(wordsFromAlignment(alignment('Hi, you!'))).toEqual([
      { text: 'Hi,', start: 0, end: 0.30000000000000004 },
      { text: 'you!', start: 0.4, end: 0.8 },
    ])
  })

  it('double spaces do not produce empty words', () => {
    expect(wordsFromAlignment(alignment('a  b'))?.map((w) => w.text)).toEqual(['a', 'b'])
  })

  it('a missing or unusable alignment yields no words', () => {
    expect(wordsFromAlignment(undefined)).toBeUndefined()
    expect(wordsFromAlignment(null)).toBeUndefined()
    expect(wordsFromAlignment({ characters: 'not an array' })).toBeUndefined()
    expect(wordsFromAlignment(alignment('   '))).toBeUndefined()
  })
})

describe('timeline words', () => {
  const words = [
    { text: 'one', start: 0, end: 0.4 },
    { text: 'two', start: 0.5, end: 0.9 },
    { text: 'three', start: 1.0, end: 1.4 },
  ]
  const t = take('t1', { duration: 2, words, meta: { text: 'one two three' } })
  const clip = (over: Partial<CompClip> = {}): CompClip => ({
    id: 'c1',
    sourceTakeId: 't1',
    srcIn: 0,
    srcOut: 2,
    start: 0,
    edits: emptyEdits(),
    ...over,
  })

  it('clipText joins the words the clip actually covers', () => {
    expect(clipText(t, 0, 2)).toBe('one two three')
    expect(clipText(t, 0.45, 2)).toBe('two three')
  })

  it('a source with no timings shows its whole text as one word', () => {
    const plain = take('t2', { meta: { text: ' Hello ' } })
    expect(clipText(plain, 0, 1)).toBe('Hello')
  })

  it('word boundaries land on the timeline, offset by the clip start', () => {
    const c = cue('q', { takes: [t] })
    const points = wordSnapPoints({ clips: [clip({ start: 3 })] }, c, project([c]))
    expect(points).toContain(3)
    expect(points).toContain(5)
    expect(points.some((p) => Math.abs(p - 3.5) < 1e-6)).toBe(true)
    expect(points.some((p) => Math.abs(p - 3.9) < 1e-6)).toBe(true)
  })

  it('speed scales the boundaries with the clip', () => {
    const c = cue('q', { takes: [t] })
    const fast = clip({ edits: { ...emptyEdits(), timeStretch: 2 } })
    const points = wordSnapPoints({ clips: [fast] }, c, project([c]))
    expect(points.some((p) => Math.abs(p - 0.25) < 1e-6)).toBe(true)
  })

  it('boundaries outside the trimmed window do not appear', () => {
    const c = cue('q', { takes: [t] })
    const points = wordSnapPoints({ clips: [clip({ srcIn: 1, srcOut: 2 })] }, c, project([c]))
    expect(points.some((p) => Math.abs(p - 0.5) < 1e-6)).toBe(false)
  })

  it('nearestPoint stays put outside the tolerance', () => {
    expect(nearestPoint([1, 2], 1.9)).toBe(2)
    expect(nearestPoint([1, 2], 1.9, 0.05)).toBe(1.9)
  })

  it('a razor cut lands on the nearest word boundary', () => {
    const c = cue('q', { takes: [t] })
    const out = splitClipByWord({ clips: [clip()] }, c, project([c]), 'c1', 0.47)
    expect(out.clips).toHaveLength(2)
    expect(out.clips[1].start).toBeCloseTo(0.5, 9)
    expect(compProblem(out)).toBeNull()
  })

  it('with no word timings the cut stays where it was asked for', () => {
    const plain = take('t2', { duration: 2, meta: { text: 'x' } })
    const c = cue('q', { takes: [plain] })
    const out = splitClipByWord(
      { clips: [clip({ sourceTakeId: 't2' })] },
      c,
      project([c]),
      'c1',
      0.7
    )
    expect(out.clips[1].start).toBeCloseTo(0.7, 9)
  })
})

describe('version chips', () => {
  const takes = [
    take('t1', { createdAt: '2026-01-01T00:00:00.000Z', meta: { text: 'Hi' } }),
    take('t2', { createdAt: '2026-01-02T00:00:00.000Z', meta: { text: 'Hi' }, duration: 2 }),
    take('t3', { createdAt: '2026-01-03T00:00:00.000Z', meta: { text: 'Bye' } }),
  ]

  it('lists the versions of the same text with the current one flagged', () => {
    const c = cue('q', { takes })
    const v = clipVersions(c, project([c]), 't2')
    expect(v.map((x) => x.label)).toEqual(['v1', 'v2'])
    expect(v.find((x) => x.current)?.takeId).toBe('t2')
    expect(v[1].duration).toBe(2)
  })

  it('versionLabel names the take inside its group', () => {
    const c = cue('q', { takes })
    expect(versionLabel(c, project([c]), 't3')).toBe('v1')
    expect(versionLabel(c, project([c]), 'gone')).toBe('')
  })
})

describe('track edits materialise the implicit track', () => {
  const bare: CueComp = {
    clips: [
      { id: 'a', sourceTakeId: 't1', srcIn: 0, srcOut: 1, start: 0, edits: emptyEdits() },
    ],
  }

  it('a comp without tracks reads as one Track 1', () => {
    expect(compTracks(bare)).toEqual([
      { id: 'track-1', name: 'Track 1', gainDb: 0, muted: false, solo: false },
    ])
  })

  it('the first track edit writes the tracks array and points the clips at it', () => {
    const out = updateTrack(bare, 'track-1', { gainDb: -3 })
    expect(out.tracks).toEqual([
      { id: 'track-1', name: 'Track 1', gainDb: -3, muted: false, solo: false },
    ])
    expect(clipTrackId(out.clips[0])).toBe('track-1')
    expect(compProblem(out)).toBeNull()
  })

  it('an unknown track is left alone', () => {
    expect(updateTrack(bare, 'nope', { muted: true })).toBe(bare)
  })

  it('addTrack appends the next numbered track', () => {
    const one = addTrack(bare)
    expect(one.tracks?.map((t) => t.name)).toEqual(['Track 1', 'Track 2'])
    expect(addTrack(one).tracks?.map((t) => t.id)).toEqual(['track-1', 'track-2', 'track-3'])
    expect(compProblem(addTrack(one))).toBeNull()
  })
})
