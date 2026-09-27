import { describe, expect, it } from 'vitest'
import {
  ALIGN_ONE_VOICE,
  applyEditOps,
  bypassEffects,
  chainEffects,
  EFFECT_PRESETS,
  effectsSummary,
  planAlignment,
  SLIVER,
  timelineWords,
  type EditOp,
  type TakeOf,
} from '../src/shared/agent-edit'
import { clipEnd, compDuration } from '../src/shared/comp'
import { clipSpeed, emptyEdits, type CompClip, type CompTrack, type CueComp, type Take } from '../src/shared/domain'
import { sanitizeEffects } from '../src/shared/effects'

const take: Take = {
  id: 't1',
  kind: 'tts',
  createdAt: 'now',
  file: { fileId: 't1', relPath: '/p/t1.mp3', format: 'mp3' },
  duration: 4,
  meta: { text: 'one two three four' },
  edits: emptyEdits(),
  words: [
    { text: 'one', start: 0.2, end: 0.6 },
    { text: 'two', start: 0.8, end: 1.2 },
    { text: 'three', start: 1.5, end: 2.0 },
    { text: 'four,', start: 2.4, end: 3.0 },
  ],
}
const bare: Take = { ...take, id: 't2', words: undefined }
const takeOf: TakeOf = (id) => [take, bare].find((t) => t.id === id)

const clip = (id: string, start: number, srcIn: number, srcOut: number, extra: Partial<CompClip> = {}): CompClip => ({
  id,
  sourceTakeId: 't1',
  srcIn,
  srcOut,
  start,
  edits: emptyEdits(),
  ...extra,
})

const single = (): CueComp => ({ clips: [clip('a', 0, 0, 3.2)] })
const split = (): CueComp => ({ clips: [clip('a', 0, 0, 1.3), clip('b', 1.5, 1.5, 3.2)] })

const run = (comp: CueComp, ...ops: EditOp[]) => applyEditOps(comp, ops, takeOf)
const layout = (comp: CueComp): number[][] =>
  comp.clips.map((c) => [c.start, c.srcIn, c.srcOut, clipEnd(c)].map((n) => Math.round(n * 1000) / 1000))
const words = (comp: CueComp): [string, number][] => timelineWords(comp, takeOf).map((w) => [w.text, Math.round(w.start * 1000) / 1000])

describe('timeline words', () => {
  it('places each word once, in the clip holding its middle, in timeline seconds', () => {
    expect(words(single())).toEqual([['one', 0.2], ['two', 0.8], ['three', 1.5], ['four,', 2.4]])
    const moved: CueComp = { clips: [clip('a', 0, 0, 1.3), clip('b', 2, 1.5, 3.2, { edits: { ...emptyEdits(), timeStretch: 2 } })] }
    expect(words(moved)).toEqual([['one', 0.2], ['two', 0.8], ['three', 2], ['four,', 2.45]])
  })
})

describe('edit ops', () => {
  it('splits at a time or a word start, and treats an existing boundary as done', () => {
    const at = run(single(), { op: 'split', word: 'three' })
    expect(layout(at.comp)).toEqual([[0, 0, 1.5, 1.5], [1.5, 1.5, 3.2, 3.2]])
    expect(run(at.comp, { op: 'split', at: 1.5 }).applied).toEqual([{ op: 'split', at: 1.5, boundary: true }])
    expect(() => run(split(), { op: 'split', at: 1.4 })).toThrow('Op 1 (split) failed: no clip on track track-1 spans 1.400 s; nothing was changed.')
    expect(() => run(single(), { op: 'split' })).toThrow('split needs exactly one of at or word')
  })

  it('cuts a word with the pause after it and ripples the rest earlier', () => {
    const done = run(single(), { op: 'cut', word: 1 })
    expect(done.applied).toEqual([{ op: 'cut', word: 'two', start: 0.8, end: 1.5, removed: 0.7, ripple: true }])
    expect(layout(done.comp)).toEqual([[0, 0, 0.8, 0.8], [0.8, 1.5, 3.2, 2.5]])
    expect(words(done.comp)).toEqual([['one', 0.2], ['three', 0.8], ['four,', 1.7]])
  })

  it('cuts the last word of a clip with the pause before it', () => {
    const done = run(single(), { op: 'cut', word: 'FOUR' })
    expect(layout(done.comp)).toEqual([[0, 0, 2, 2], [2, 3, 3.2, 2.2]])
  })

  it('leaves a gap when ripple is false', () => {
    const done = run(single(), { op: 'cut', word: 'two', ripple: false })
    expect(layout(done.comp)).toEqual([[0, 0, 0.8, 0.8], [1.5, 1.5, 3.2, 3.2]])
    expect(compDuration(done.comp)).toBeCloseTo(3.2)
  })

  it('cuts a range across clips and the empty space between them', () => {
    const done = run(split(), { op: 'cut', range: { start: 0.8, end: 1.7 } })
    expect(layout(done.comp)).toEqual([[0, 0, 0.8, 0.8], [0.8, 1.7, 3.2, 2.3]])
    expect(() => run(split(), { op: 'cut', range: { start: 3.5, end: 4 } })).toThrow('no audio between 3.500 and 4.000 s on track track-1')
  })

  it('moves a clip to a time or by a shift, and refuses an overlap', () => {
    expect(layout(run(split(), { op: 'move', clip: 'b', to: 2 }).comp)[1]).toEqual([2, 1.5, 3.2, 3.7])
    expect(layout(run(split(), { op: 'move', clip: 'b', shift: -0.2 }).comp)[1]).toEqual([1.3, 1.5, 3.2, 3])
    expect(() => run(split(), { op: 'move', clip: 'b', shift: -1 })).toThrow('clip b would overlap another clip on track track-1 at 0.500 s')
    expect(() => run(split(), { op: 'move', clip: 'a', to: 0, shift: 1 })).toThrow('move needs exactly one of to or shift')
  })

  it('inserts silence before a word and pushes later clips on that track', () => {
    const done = run(single(), { op: 'gap', beforeWord: 'three', seconds: 0.2 })
    expect(layout(done.comp)).toEqual([[0, 0, 1.5, 1.5], [1.7, 1.5, 3.2, 3.4]])
    expect(words(done.comp).slice(2)).toEqual([['three', 1.7], ['four,', 2.6]])
  })

  it('shortens a pause but never past the audio before it', () => {
    const done = run(single(), { op: 'gap', beforeWord: 'three', seconds: -1 })
    expect(done.applied).toEqual([{ op: 'gap', at: 1.5, closed: 0.3, requested: 1 }])
    expect(words(done.comp)).toEqual([['one', 0.2], ['two', 0.8], ['three', 1.2], ['four,', 2.1]])
    const between = run(split(), { op: 'gap', at: 1.3, seconds: -0.1 })
    expect(words(between.comp).slice(2)).toEqual([['three', 1.4], ['four,', 2.3]])
    expect(() => run(single(), { op: 'gap', at: 1, seconds: -0.1 })).toThrow('1.000 s is inside audio, not in a pause')
  })

  it('treats a clip without word timings as solid audio when closing a pause', () => {
    const comp: CueComp = { clips: [clip('a', 0, 0, 1, { sourceTakeId: 't2' }), clip('b', 1.5, 1.5, 3.2)] }
    const done = run(comp, { op: 'gap', at: 1.2, seconds: -2 })
    expect(done.applied).toEqual([{ op: 'gap', at: 1.5, closed: 0.5, requested: 2 }])
    expect(layout(done.comp)[1]).toEqual([1, 1.5, 3.2, 2.7])
  })

  it('changes speed and keeps the pause after the clip', () => {
    const slower = run(split(), { op: 'speed', clip: 'a', value: 0.8 })
    expect(layout(slower.comp)).toEqual([[0, 0, 1.3, 1.625], [1.825, 1.5, 3.2, 3.525]])
    const faster = run(split(), { op: 'speed', at: 2, value: 1.2 })
    expect(clipSpeed(faster.comp.clips[1].edits)).toBe(1.2)
    expect(faster.applied).toEqual([{ op: 'speed', clip: 'b', speed: 1.2, duration: 1.417 }])
    const first = run(split(), { op: 'speed', clip: 'a', value: 1.2 })
    expect(layout(first.comp)[1]).toEqual([1.283, 1.5, 3.2, 2.983])
  })

  it('sets gain and fades through the same clamps as the Properties panel', () => {
    const done = run(split(), { op: 'gain', clip: 'a', db: -3 }, { op: 'fade', clip: 'a', in: 0.2, out: 5, shape: 'linear' })
    const edits = done.comp.clips[0].edits
    expect(edits.gainDb).toBe(-3)
    expect(edits.fadeIn).toEqual({ duration: 0.2, shape: 'linear' })
    expect(edits.fadeOut.shape).toBe('linear')
    expect(edits.fadeOut.duration).toBeCloseTo(1.1)
    expect(() => run(split(), { op: 'fade', clip: 'a' })).toThrow('fade needs in or out')
  })

  it('crossfades into an abutting clip with a handle and explains when it cannot', () => {
    const cut = run(single(), { op: 'split', at: 1.5 }).comp
    const left = cut.clips[0].id
    const done = run(cut, { op: 'crossfade', clip: left, seconds: 0.1 })
    expect(done.comp.clips[0].crossfade).toBe(0.1)
    expect(() => run(split(), { op: 'crossfade', clip: 'a', seconds: 0.1 })).toThrow('clip a cannot crossfade')
  })

  it('trims silence around the words of a clip, keeping a pad and the words in place', () => {
    const done = run(single(), { op: 'trimSilence', clip: 'a' })
    expect(layout(done.comp)).toEqual([[0.15, 0.15, 3.05, 3.05]])
    expect(done.applied).toEqual([{ op: 'trimSilence', clip: 'a', trimmedStart: 0.15, trimmedEnd: 0.15 }])
    expect(words(done.comp)[0]).toEqual(['one', 0.2])
    expect(() => run({ clips: [clip('x', 0, 0, 1, { sourceTakeId: 't2' })] }, { op: 'trimSilence', clip: 'x' })).toThrow('clip x has no word timings')
  })

  it('refuses the whole batch when any op fails and leaves the input untouched', () => {
    const comp = single()
    const before = structuredClone(comp)
    expect(() => run(comp, { op: 'cut', word: 1 }, { op: 'move', clip: 'nope', to: 1 })).toThrow(
      'Op 2 (move) failed: no clip "nope"; call timeline for clip ids; nothing was changed.'
    )
    expect(comp).toEqual(before)
  })

  it('names ambiguous or missing words and asks for a track when clips sit on several', () => {
    const twice: CueComp = { clips: [clip('a', 0, 0, 1), clip('b', 1, 0, 1)] }
    expect(() => run(twice, { op: 'split', word: 'one' })).toThrow('"one" matches words 0, 1; pass the index')
    expect(() => run(single(), { op: 'split', word: 9 })).toThrow('word 9 does not exist; the timeline has 4 words, numbered from 0')
    expect(() => run(single(), { op: 'split', word: 'five' })).toThrow('no word "five" on the timeline')
    const tracks: CueComp = {
      clips: [clip('a', 0, 0, 3.2, { trackId: 't-a' }), clip('b', 0, 0, 3.2, { trackId: 't-b' })],
      tracks: [
        { id: 't-a', name: 'A', gainDb: 0, muted: false, solo: false },
        { id: 't-b', name: 'B', gainDb: 0, muted: false, solo: false },
      ],
    }
    expect(() => run(tracks, { op: 'split', at: 1 })).toThrow('clips sit on several tracks (t-a, t-b); pass track')
    const done = run(tracks, { op: 'split', at: 1, track: 't-b' })
    expect(done.comp.clips.filter((c) => c.trackId === 't-b')).toHaveLength(2)
    expect(done.comp.clips.filter((c) => c.trackId === 't-a')).toHaveLength(1)
  })
})

describe('effect presets', () => {
  it('are plain data already inside every effect range', () => {
    for (const [name, preset] of Object.entries(EFFECT_PRESETS)) {
      if (name === 'clean') expect(sanitizeEffects(preset)).toBeUndefined()
      else expect(sanitizeEffects(preset)).toEqual(preset)
    }
  })

  it('builds a stack from a chain over the defaults, clamped, one of each kind', () => {
    expect(chainEffects([{ kind: 'reverb', params: { mix: 2, junk: 1 } }, { kind: 'highpass', enabled: false }])).toEqual({
      reverb: { mix: 1, size: 0.5, decay: 1.2 },
      highpass: { frequency: 80, enabled: false },
    })
    expect(() => chainEffects([{ kind: 'eq' }, { kind: 'eq' }])).toThrow('eq appears twice in chain')
  })

  it('bypasses and restores a stack without removing it', () => {
    const off = bypassEffects(EFFECT_PRESETS.radio, true)
    expect(effectsSummary(off)).toEqual(['highpass (bypassed)', 'eq (bypassed)', 'compressor (bypassed)'])
    expect(bypassEffects(off, false)).toEqual(EFFECT_PRESETS.radio)
  })
})

describe('align planning', () => {
  const dub = [
    { start: 0.1, end: 0.6 },
    { start: 0.9, end: 1.5 },
  ]
  const original = [
    { start: 0.3, end: 0.8 },
    { start: 1.0, end: 1.4 },
  ]
  const pairs = [
    { dub: [0, 0] as [number, number], original: [0, 0] as [number, number] },
    { dub: [1, 1] as [number, number], original: [1, 1] as [number, number] },
  ]
  const comp = (): CueComp => ({ clips: [clip('a', 0, 0, 2)] })

  it('moves a late or early phrase with a gap or a pause cut and fits a long one with speed', () => {
    const plan = planAlignment({ comp: comp(), takeOf, from: 0, dub, original, pairs })
    expect(plan.ops.map((o) => o.op)).toEqual(['gap', 'split', 'split', 'speed', 'cut', 'cut'])
    expect(plan.ops[0]).toEqual({ op: 'gap', at: 0, track: 'track-1', seconds: 0.2 })
    expect(plan.ops[5]).toEqual({ op: 'cut', range: { start: 0.95, end: 0.97 }, track: 'track-1', ripple: false })
    expect(plan.comp.clips.every((c) => clipEnd(c) - c.start >= SLIVER)).toBe(true)
    expect(plan.ops[3]).toMatchObject({ op: 'speed', value: 1.2 })
    expect(plan.phrases.map((p) => p.after)).toEqual([
      { start: 0.3, duration: 0.5 },
      { start: 1, duration: 0.5 },
    ])
    expect(plan.phrases[1]).toMatchObject({ dub: [2, 2], original: [2, 2], speed: [1.2], note: 'speed limit reached; also change the text to fit' })
  })

  it('never leaves a wordless sliver when a phrase boundary sits 0.03 s from a clip edge', () => {
    const tight: CueComp = { clips: [clip('a', 0.14, 0.14, 1.25)] }
    const long = [{ start: 0.2, end: 1.8 }]
    const plan = planAlignment({ comp: tight, takeOf, from: 0, dub: [{ start: 0.2, end: 1.2 }], original: long, pairs: [pairs[0]] })
    expect(plan.ops).toEqual([{ op: 'speed', at: 0.695, track: 'track-1', value: 0.7 }])
    expect(layout(plan.comp)).toEqual([[0.14, 0.14, 1.25, 1.726]])
    const edged: CueComp = { clips: [clip('a', 0, 0, 0.2), clip('b', 0.2, 0.2, 2)] }
    const early = planAlignment({ comp: edged, takeOf, from: 0, dub: [{ start: 0.2, end: 0.6 }], original: [{ start: 0.1, end: 0.5 }], pairs: [pairs[0]] })
    expect(early.ops).toEqual([
      { op: 'cut', range: { start: 0.07, end: 0.17 }, track: 'track-1', ripple: true },
      { op: 'cut', range: { start: 0.07, end: 0.1 }, track: 'track-1', ripple: false },
      { op: 'cut', range: { start: 0, end: 0.07 }, track: 'track-1', ripple: false },
    ])
    expect(layout(early.comp)).toEqual([[0.1, 0.2, 2, 1.9]])
    expect(early.phrases[0].after).toEqual({ start: 0.1, duration: 0.4 })
  })

  it('replays through the edit path to the timeline it predicted', () => {
    const plan = planAlignment({ comp: comp(), takeOf, from: 0, dub, original, pairs })
    expect(layout(applyEditOps(comp(), plan.ops, takeOf).comp)).toEqual(layout(plan.comp))
  })

  it('works in render time when the render starts past zero on the timeline', () => {
    const shifted: CueComp = { clips: [clip('a', 0.5, 0, 2)] }
    const plan = planAlignment({ comp: shifted, takeOf, from: 0.5, dub, original, pairs })
    expect(plan.phrases.map((p) => p.after?.start)).toEqual([0.3, 1])
  })

  it('reports a phrase it cannot move early enough and leaves aligned phrases alone', () => {
    const early = [original[0], { start: 0.4, end: 0.9 }]
    const plan = planAlignment({ comp: comp(), takeOf, from: 0, dub: [dub[0], { start: 0.7, end: 1.2 }], original: early, pairs })
    expect(plan.ops.slice(-1)).toEqual([{ op: 'cut', range: { start: 0.83, end: 0.87 }, track: 'track-1', ripple: true }])
    expect(plan.phrases[1]).toMatchObject({ after: { start: 0.86, duration: 0.5 }, note: 'the pause before it is too short to start it on time' })
    expect(planAlignment({ comp: comp(), takeOf, from: 0, dub: [dub[0]], original: [dub[0]], pairs: [pairs[0]] }).ops).toEqual([])
  })

  it('retimes only the one audible track and refuses when two audible tracks carry clips', () => {
    const tracks = (bgMuted: boolean, voiceSolo = false): CompTrack[] => [
      { id: 'track-1', name: 'Voice', gainDb: 0, muted: false, solo: voiceSolo },
      { id: 'bg', name: 'Bed', gainDb: 0, muted: bgMuted, solo: false },
    ]
    const layered = (bgMuted: boolean, voiceSolo = false): CueComp => ({ tracks: tracks(bgMuted, voiceSolo), clips: [clip('bg1', 0, 0, 2, { trackId: 'bg' }), clip('a', 0, 0, 2)] })
    const alone = planAlignment({ comp: comp(), takeOf, from: 0, dub, original, pairs })
    for (const layers of [layered(true), layered(false, true)]) {
      const plan = planAlignment({ comp: layers, takeOf, from: 0, dub, original, pairs })
      expect(plan.ops).toEqual(alone.ops)
      expect(plan.comp.clips.filter((c) => c.trackId === 'bg')).toEqual(layers.clips.filter((c) => c.trackId === 'bg'))
    }
    expect(() => planAlignment({ comp: layered(false), takeOf, from: 0, dub, original, pairs })).toThrow(ALIGN_ONE_VOICE)
  })

  it('keeps a later placement of the same source range apart from the earlier one', () => {
    const twice: CueComp = { clips: [clip('a', 0, 0, 2), clip('b', 3, 0, 2)] }
    const late = [
      { start: 3.2, end: 3.6 },
      { start: 3.8, end: 4.2 },
    ]
    const plan = planAlignment({ comp: twice, takeOf, from: 0, dub: late, original: [late[0], { start: 3.9, end: 4.46 }], pairs })
    expect(plan.ops.length).toBeGreaterThan(0)
    for (const op of plan.ops) expect((op as { at?: number }).at ?? (op as { range: { start: number } }).range.start).toBeGreaterThan(3)
    expect(layout(plan.comp)[0]).toEqual([0, 0, 2, 2])
    expect(plan.phrases[0].after).toEqual({ start: 3.2, duration: 0.4 })
    expect(plan.phrases[1].after?.start).toBe(3.9)
    expect(plan.phrases[1].after?.duration).toBeCloseTo(0.56, 2)
    expect(layout(applyEditOps(twice, plan.ops, takeOf).comp)).toEqual(layout(plan.comp))
  })

  it('fits a phrase spanning two clips without scaling the pause between them', () => {
    const plan = planAlignment({ comp: split(), takeOf, from: 0, dub: [{ start: 0.8, end: 2.0 }], original: [{ start: 0.8, end: 2.3 }], pairs: [pairs[0]] })
    expect(plan.phrases[0].speed).toEqual([0.77, 0.77])
    expect(plan.phrases[0].after?.start).toBeCloseTo(0.8, 1)
    expect(plan.phrases[0].after?.duration).toBeCloseTo(1.5, 2)
    expect(layout(applyEditOps(split(), plan.ops, takeOf).comp)).toEqual(layout(plan.comp))
  })
})
