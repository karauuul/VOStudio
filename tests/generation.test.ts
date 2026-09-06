import { describe, expect, it } from 'vitest'
import {
  clampSpeed,
  clipTargetText,
  deriveGenTarget,
  findWholeWord,
  fromPercent,
  placeTake,
  targetRange,
  targetText,
  toPercent,
} from '../src/shared/generation'
import { groupByCharacter } from '../src/shared/cue-filter'
import {
  emptyEdits,
  type CompClip,
  type Cue,
  type CueComp,
  type Take,
} from '../src/shared/domain'

const take = (id: string, over: Partial<Take> = {}): Take => ({
  id,
  kind: 'tts',
  createdAt: '2026-01-01T00:00:00.000Z',
  file: { fileId: id, relPath: `${id}.mp3`, format: 'mp3' },
  duration: 1,
  meta: {},
  edits: emptyEdits(),
  ...over,
})

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'c1',
  sourceTakeId: 't1',
  srcIn: 0,
  srcOut: 2,
  start: 0,
  edits: emptyEdits(),
  ...over,
})

const cue = (over: Partial<Cue> = {}): Cue => ({
  id: 'cue-1',
  characterId: 'ada',
  key: 'k',
  fields: {},
  sourceText: 'S',
  text: 'Модулі живлення та оболонки тепер доступні для будівництва.',
  status: 'translated',
  notes: '',
  takes: [],
  ...over,
})

describe('deriveGenTarget', () => {
  it('a selected clip wins over everything', () => {
    expect(deriveGenTarget({ clipId: 'c1', text: 'hi' }, { start: 0, end: 4 })).toEqual({
      kind: 'clip',
      clipId: 'c1',
      text: 'hi',
    })
  })

  it('a non-empty text selection becomes a range', () => {
    expect(deriveGenTarget(null, { start: 3, end: 9 })).toEqual({ kind: 'range', start: 3, end: 9 })
  })

  it('a caret with no selection is the whole text', () => {
    expect(deriveGenTarget(null, { start: 4, end: 4 })).toEqual({ kind: 'all' })
    expect(deriveGenTarget(null, null)).toEqual({ kind: 'all' })
  })
})

describe('findWholeWord', () => {
  it('matches case-insensitively on word boundaries', () => {
    expect(findWholeWord('Оновлення ГАБу-2 завершено.', 'габу')).toEqual({ start: 10, end: 14 })
  })

  it('refuses a match inside a longer word', () => {
    expect(findWholeWord('constructions everywhere', 'construction')).toBeNull()
  })

  it('finds a later occurrence when the first one is glued to a word', () => {
    expect(findWholeWord('abcat a cat', 'cat')).toEqual({ start: 8, end: 11 })
  })

  it('ignores empty needles', () => {
    expect(findWholeWord('anything', '  ')).toBeNull()
  })
})

describe('targetRange and targetText', () => {
  const text = 'Модулі живлення та оболонки.'

  it('the whole text underlines everything', () => {
    expect(targetRange(text, { kind: 'all' })).toEqual({ start: 0, end: text.length })
    expect(targetText(text, { kind: 'all' })).toBe(text)
  })

  it('a range is clamped to the text and sends only its words', () => {
    expect(targetRange(text, { kind: 'range', start: 7, end: 999 })).toEqual({
      start: 7,
      end: text.length,
    })
    expect(targetText(text, { kind: 'range', start: 0, end: 6 })).toBe('Модулі')
  })

  it('a clip target underlines its own words and regenerates its own text', () => {
    const target = { kind: 'clip', clipId: 'c1', text: 'живлення' } as const
    expect(targetRange(text, target)).toEqual({ start: 7, end: 15 })
    expect(targetText(text, target)).toBe('живлення')
  })

  it('a clip whose text is not in the translation underlines nothing', () => {
    expect(targetRange(text, { kind: 'clip', clipId: 'c1', text: 'absent' })).toBeNull()
  })

  it('an empty text has nothing to underline', () => {
    expect(targetRange('', { kind: 'all' })).toBeNull()
  })
})

describe('clipTargetText', () => {
  it('joins the words of the clip source', () => {
    const source = take('t1', {
      words: [
        { text: 'Модулі', start: 0, end: 1 },
        { text: 'живлення', start: 1, end: 2 },
        { text: 'тепер', start: 2, end: 3 },
      ],
    })
    const c = cue({ takes: [source], comp: { clips: [clip({ srcIn: 0, srcOut: 2 })] } })
    expect(clipTargetText({ cues: [c] }, c, 'c1')).toBe('Модулі живлення')
  })

  it('falls back to the source text when the take has no words', () => {
    const source = take('t1', { meta: { text: 'Whole clip' } })
    const c = cue({ takes: [source], comp: { clips: [clip()] } })
    expect(clipTargetText({ cues: [c] }, c, 'c1')).toBe('Whole clip')
  })

  it('an unknown clip has no text', () => {
    expect(clipTargetText(undefined, cue(), 'nope')).toBe('')
  })
})

describe('placeTake', () => {
  const track = (id: string, name: string) => ({
    id,
    name,
    gainDb: 0,
    muted: false,
    solo: false,
  })

  it('places on the implicit first track of a line with no composition', () => {
    const placed = placeTake({ takeId: 'new', duration: 3, playhead: 0 })
    expect(placed.trackId).toBe('track-1')
    expect(placed.comp.clips).toHaveLength(1)
    expect(placed.comp.clips[0]).toMatchObject({ sourceTakeId: 'new', start: 0, srcOut: 3 })
    expect(placed.comp.tracks).toBeUndefined()
  })

  it('lands at the playhead on the target track', () => {
    const comp: CueComp = {
      clips: [clip({ id: 'a', start: 0, trackId: 'track-1' })],
      tracks: [track('track-1', 'Track 1'), track('track-2', 'Track 2')],
    }
    const placed = placeTake({
      comp,
      takeId: 'new',
      duration: 1,
      targetTrackId: 'track-2',
      playhead: 4,
    })
    expect(placed.trackId).toBe('track-2')
    expect(placed.comp.clips.find((c) => c.id === placed.clipId)).toMatchObject({
      start: 4,
      trackId: 'track-2',
    })
  })

  it('moves to a new track when the target slot is occupied', () => {
    const comp: CueComp = { clips: [clip({ id: 'a', start: 0, srcOut: 5 })] }
    const placed = placeTake({ comp, takeId: 'new', duration: 2, playhead: 1 })
    expect(placed.trackId).toBe('track-2')
    expect(placed.comp.tracks?.map((t) => t.id)).toEqual(['track-1', 'track-2'])
  })

  it('an unknown target track falls back to the first one', () => {
    const placed = placeTake({
      comp: { clips: [] },
      takeId: 'new',
      duration: 1,
      targetTrackId: 'gone',
      playhead: 0,
    })
    expect(placed.trackId).toBe('track-1')
  })

  it('a clip target replaces in place and keeps its start and track', () => {
    const comp: CueComp = {
      clips: [clip({ id: 'c1', start: 2, srcIn: 1, srcOut: 3, trackId: 'track-2' })],
      tracks: [track('track-1', 'Track 1'), track('track-2', 'Track 2')],
    }
    const placed = placeTake({
      comp,
      takeId: 'new',
      duration: 4,
      playhead: 9,
      replaceClipId: 'c1',
    })
    expect(placed).toMatchObject({ clipId: 'c1', trackId: 'track-2' })
    expect(placed.comp.clips[0]).toMatchObject({
      start: 2,
      srcIn: 0,
      srcOut: 4,
      sourceTakeId: 'new',
    })
  })
})

describe('knob numbers', () => {
  it('converts between stored 0..1 and the shown 0..100', () => {
    expect(toPercent(0.45)).toBe(45)
    expect(toPercent(2)).toBe(100)
    expect(fromPercent(51)).toBe(0.51)
    expect(fromPercent(-4)).toBe(0)
    expect(fromPercent(140)).toBe(1)
    expect(fromPercent(Number.NaN)).toBe(0)
  })

  it('clamps speed to the provider range at two decimals', () => {
    expect(clampSpeed(1)).toBe(1)
    expect(clampSpeed(0.4)).toBe(0.7)
    expect(clampSpeed(1.9)).toBe(1.2)
    expect(clampSpeed(1.017)).toBe(1.02)
    expect(clampSpeed(Number.NaN)).toBe(1)
  })
})

describe('groupByCharacter', () => {
  it('keeps project order and counts each character once', () => {
    const cues = [
      cue({ id: 'a', characterId: 'ada' }),
      cue({ id: 'b', characterId: 'mam' }),
      cue({ id: 'c', characterId: 'ada' }),
      cue({ id: 'd', characterId: '' }),
    ]
    const grouped = groupByCharacter(cues, [
      { id: 'ada', name: 'ADA' },
      { id: 'mam', name: 'MAM' },
    ])
    expect(grouped.groups).toEqual([
      { name: 'ADA', count: 2 },
      { name: 'MAM', count: 1 },
      { name: 'No character', count: 1 },
    ])
    expect(grouped.cues.map((c) => c.id)).toEqual(['a', 'c', 'b', 'd'])
  })
})
