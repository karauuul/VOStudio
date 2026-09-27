import {
  clipEnd,
  clipTimelineDuration,
  clipTrackId,
  compProblem,
  cutCandidate,
  maxCrossfade,
  MIN_CLIP_SRC,
  moveClips,
  moveClipTo,
  normalizeComp,
  setClipEdits,
  setCrossfade,
  splitClipAt,
  trackClips,
  trackAudible,
  trimClipEdge,
} from './comp'
import { clipSpeed, type ClipEffects, type CompClip, type CueComp, type FadeShape, type Take } from './domain'
import { EFFECT_KINDS, sanitizeEffects, setEffectEnabled, toggleEffect, type EffectKind } from './effects'
import { clampSpeed, SPEED_MAX, SPEED_MIN } from './generation'
import { clipWords, compTracks, normalizeWord } from './library'
import { TIMING_TOLERANCE, type Span } from './prosody-compare'

export const EDGE = 0.002
export const TRIM_PAD = 0.05
export const ALIGN_PAD = 0.03
export const ALIGN_TOLERANCE = 0.03
export const SLIVER = 0.1

export type TakeOf = (takeId: string) => Take | undefined

export type WordRef = number | string

export type EditOp =
  | { op: 'split'; at?: number; word?: WordRef; track?: string }
  | { op: 'cut'; word?: WordRef; range?: { start: number; end: number }; track?: string; ripple?: boolean }
  | { op: 'move'; clip: string; to?: number; shift?: number; track?: string }
  | { op: 'gap'; beforeWord?: WordRef; at?: number; seconds: number; track?: string }
  | { op: 'speed'; clip?: string; at?: number; track?: string; value: number }
  | { op: 'gain'; clip: string; db: number }
  | { op: 'fade'; clip: string; in?: number; out?: number; shape?: FadeShape }
  | { op: 'crossfade'; clip: string; seconds: number }
  | { op: 'trimSilence'; clip: string; pad?: number }

export type EditInfo = Record<string, unknown>

export interface TimelineWord {
  text: string
  clip: string
  track: string
  start: number
  end: number
}

export const r3 = (n: number): number => Math.round(n * 1000) / 1000

const fmt = (t: number): string => t.toFixed(3)

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')

export function timelineWords(comp: CueComp, takeOf: TakeOf): TimelineWord[] {
  return normalizeComp(comp)
    .clips.flatMap((clip) => {
      const speed = clipSpeed(clip.edits)
      const at = (src: number): number => clip.start + (Math.min(Math.max(src, clip.srcIn), clip.srcOut) - clip.srcIn) / speed
      return (takeOf(clip.sourceTakeId)?.words ?? [])
        .filter((w) => (w.start + w.end) / 2 >= clip.srcIn && (w.start + w.end) / 2 < clip.srcOut)
        .map((w) => ({ text: w.text, clip: clip.id, track: clipTrackId(clip), start: at(w.start), end: at(w.end) }))
    })
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

function findWord(words: TimelineWord[], ref: WordRef): TimelineWord {
  if (typeof ref === 'number') {
    const word = words[ref]
    if (!word) throw new Error(`word ${ref} does not exist; the timeline has ${words.length} words, numbered from 0`)
    return word
  }
  const wanted = normalizeWord(ref)
  const hits = words.flatMap((w, i) => (wanted && normalizeWord(w.text) === wanted ? [i] : []))
  if (hits.length === 1) return words[hits[0]]
  if (hits.length === 0) throw new Error(`no word "${ref}" on the timeline; call timeline for its words`)
  throw new Error(`"${ref}" matches words ${hits.slice(0, 10).join(', ')}; pass the index`)
}

function pickTrack(comp: CueComp, track: string | undefined): string {
  const ids = compTracks(comp).map((t) => t.id)
  if (track !== undefined) {
    if (!ids.includes(track)) throw new Error(`no track "${track}"; tracks are ${ids.join(', ')}`)
    return track
  }
  const used = [...new Set(comp.clips.map(clipTrackId))]
  if (used.length > 1) throw new Error(`clips sit on several tracks (${used.join(', ')}); pass track`)
  return used[0] ?? ids[0]
}

function requireClip(comp: CueComp, id: string): CompClip {
  const clip = comp.clips.find((c) => c.id === id)
  if (!clip) throw new Error(`no clip "${id}"; call timeline for clip ids`)
  return clip
}

function clipAtTime(comp: CueComp, track: string, t: number): CompClip {
  const clip = trackClips(comp, track).find((c) => c.start - EDGE <= t && t < clipEnd(c) - EDGE)
  if (!clip) throw new Error(`no clip on track ${track} at ${fmt(t)} s`)
  return clip
}

function point(
  comp: CueComp,
  takeOf: TakeOf,
  at: number | undefined,
  word: WordRef | undefined,
  track: string | undefined,
  what: string
): { at: number; track: string; word?: TimelineWord } {
  if ((at === undefined) === (word === undefined)) throw new Error(what)
  if (word === undefined) return { at: at as number, track: pickTrack(comp, track) }
  const hit = findWord(timelineWords(comp, takeOf), word)
  return { at: hit.start, track: hit.track, word: hit }
}

function shiftClips(comp: CueComp, ids: string[], delta: number): CueComp {
  if (ids.length === 0 || delta === 0) return comp
  const before = requireClip(comp, ids[0]).start
  const next = moveClips(comp, ids, delta)
  const after = next.clips.find((c) => c.id === ids[0])?.start
  if (after === undefined || Math.abs(after - (before + delta)) > 1e-6) {
    throw new Error(`the clips after ${fmt(before)} s cannot move ${delta > 0 ? 'later' : 'earlier'} by ${fmt(Math.abs(delta))} s without overlapping or starting before 0`)
  }
  return next
}

function cutRange(comp: CueComp, track: string, start: number, end: number, ripple: boolean): { comp: CueComp; removed: number } {
  if (!(end - start >= MIN_CLIP_SRC)) throw new Error('the range to cut is empty')
  let next = comp
  for (const t of [end, start]) {
    const clip = cutCandidate(next, t, track)
    if (clip) next = splitClipAt(next, clip.id, t)
  }
  const row = trackClips(next, track)
  const inside = row.filter((c) => c.start >= start - EDGE && clipEnd(c) <= end + EDGE)
  const later = row.filter((c) => c.start >= end - EDGE && !inside.includes(c))
  if (inside.length === 0 && (!ripple || later.length === 0)) throw new Error(`no audio between ${fmt(start)} and ${fmt(end)} s on track ${track}`)
  const gone = new Set(inside.map((c) => c.id))
  next = normalizeComp({ ...next, clips: next.clips.filter((c) => !gone.has(c.id)) })
  const removed = inside.reduce((sum, c) => sum + clipTimelineDuration(c), 0)
  if (!ripple) return { comp: next, removed }
  next = shiftClips(next, later.map((c) => c.id), -(end - start))
  const prev = row.filter((c) => !gone.has(c.id) && clipEnd(c) <= start + EDGE).pop()
  if (prev?.crossfade !== undefined) next = setCrossfade(next, prev.id, 0)
  return { comp: next, removed }
}

function sounds(comp: CueComp, takeOf: TakeOf, track: string): Span[] {
  const words = timelineWords(comp, takeOf).filter((w) => w.track === track)
  const bare = trackClips(comp, track)
    .filter((c) => !takeOf(c.sourceTakeId)?.words?.length)
    .map((c) => ({ start: c.start, end: clipEnd(c) }))
  return [...words, ...bare]
}

function wordSpan(comp: CueComp, takeOf: TakeOf, ref: WordRef): { word: TimelineWord; start: number; end: number } {
  const words = timelineWords(comp, takeOf)
  const word = findWord(words, ref)
  const row = words.filter((w) => w.track === word.track)
  const k = row.indexOf(word)
  const next = row[k + 1]?.clip === word.clip ? row[k + 1] : undefined
  const prev = row[k - 1]?.clip === word.clip ? row[k - 1] : undefined
  if (next) return { word, start: word.start, end: Math.max(word.end, next.start) }
  if (prev) return { word, start: Math.min(word.start, prev.end), end: word.end }
  return { word, start: word.start, end: word.end }
}

function applyOp(comp: CueComp, op: EditOp, takeOf: TakeOf): { comp: CueComp; info: EditInfo } {
  switch (op.op) {
    case 'split': {
      const p = point(comp, takeOf, op.at, op.word, op.track, 'split needs exactly one of at or word')
      const clip = cutCandidate(comp, p.at, p.track)
      const boundary = { at: r3(p.at), boundary: true }
      if (!clip) {
        if (trackClips(comp, p.track).some((c) => Math.abs(c.start - p.at) <= EDGE || Math.abs(clipEnd(c) - p.at) <= EDGE)) return { comp, info: boundary }
        throw new Error(`no clip on track ${p.track} spans ${fmt(p.at)} s`)
      }
      const next = splitClipAt(comp, clip.id, p.at)
      return { comp: next, info: next.clips.length > comp.clips.length ? { clip: clip.id, at: r3(p.at) } : boundary }
    }
    case 'cut': {
      const ripple = op.ripple !== false
      if ((op.word === undefined) === (op.range === undefined)) throw new Error('cut needs exactly one of word or range')
      if (op.range) {
        if (!(op.range.end > op.range.start)) throw new Error('range end must be after its start')
        const track = pickTrack(comp, op.track)
        const done = cutRange(comp, track, op.range.start, op.range.end, ripple)
        return { comp: done.comp, info: { start: r3(op.range.start), end: r3(op.range.end), removed: r3(done.removed), ripple } }
      }
      const span = wordSpan(comp, takeOf, op.word as WordRef)
      const done = cutRange(comp, span.word.track, span.start, span.end, ripple)
      return { comp: done.comp, info: { word: span.word.text, start: r3(span.start), end: r3(span.end), removed: r3(done.removed), ripple } }
    }
    case 'move': {
      const clip = requireClip(comp, op.clip)
      if ((op.to === undefined) === (op.shift === undefined)) throw new Error('move needs exactly one of to or shift')
      const to = op.to ?? clip.start + (op.shift as number)
      if (to < 0) throw new Error(`clip ${clip.id} would start before 0 (${fmt(to)} s)`)
      const track = op.track === undefined ? clipTrackId(clip) : pickTrack(comp, op.track)
      const next = moveClipTo(comp, clip.id, to, op.track === undefined ? undefined : track)
      const moved = requireClip(next, clip.id)
      if (Math.abs(moved.start - to) > 1e-6 || clipTrackId(moved) !== track) {
        throw new Error(`clip ${clip.id} would overlap another clip on track ${track} at ${fmt(to)} s`)
      }
      return { comp: next, info: { clip: clip.id, start: r3(to), ...(op.track === undefined ? {} : { track }) } }
    }
    case 'gap': {
      if (op.seconds === 0) throw new Error('seconds must not be 0')
      const p = point(comp, takeOf, op.at, op.beforeWord, op.track, 'gap needs exactly one of at or beforeWord')
      if (op.seconds > 0) {
        const clip = cutCandidate(comp, p.at, p.track)
        const split = clip ? splitClipAt(comp, clip.id, p.at) : comp
        const later = trackClips(split, p.track).filter((c) => c.start >= p.at - EDGE)
        if (later.length === 0) throw new Error(`nothing on track ${p.track} after ${fmt(p.at)} s to push later`)
        return { comp: shiftClips(split, later.map((c) => c.id), op.seconds), info: { at: r3(p.at), seconds: r3(op.seconds) } }
      }
      const spans = sounds(comp, takeOf, p.track)
      const inside = spans.find((s) => s.start < p.at - EDGE && s.end > p.at + EDGE)
      if (inside) throw new Error(`${fmt(p.at)} s is inside audio, not in a pause`)
      const end = Math.min(...spans.filter((s) => s.start >= p.at - EDGE).map((s) => s.start))
      if (!Number.isFinite(end)) throw new Error(`no audio after ${fmt(p.at)} s on track ${p.track}`)
      const start = Math.max(0, ...spans.filter((s) => s.end <= p.at + EDGE).map((s) => s.end))
      const closed = Math.min(-op.seconds, end - start)
      if (closed < MIN_CLIP_SRC) throw new Error(`there is no pause before ${fmt(end)} s to close`)
      const done = cutRange(comp, p.track, end - closed, end, true)
      return { comp: done.comp, info: { at: r3(end), closed: r3(closed), ...(closed < -op.seconds - 1e-6 ? { requested: r3(-op.seconds) } : {}) } }
    }
    case 'speed': {
      if ((op.clip === undefined) === (op.at === undefined)) throw new Error('speed needs exactly one of clip or at')
      if (!(op.value >= SPEED_MIN && op.value <= SPEED_MAX)) throw new Error(`speed must be ${SPEED_MIN} to ${SPEED_MAX}`)
      const clip = op.clip !== undefined ? requireClip(comp, op.clip) : clipAtTime(comp, pickTrack(comp, op.track), op.at as number)
      const delta = (clip.srcOut - clip.srcIn) / op.value - clipTimelineDuration(clip)
      const later = trackClips(comp, clipTrackId(clip))
        .filter((c) => c.id !== clip.id && c.start >= clipEnd(clip) - EDGE)
        .map((c) => c.id)
      let next = delta > 0 ? shiftClips(comp, later, delta) : comp
      next = setClipEdits(next, clip.id, { timeStretch: op.value })
      if (Math.abs(clipSpeed(requireClip(next, clip.id).edits) - op.value) > 1e-6) throw new Error(`clip ${clip.id} has no room for speed ${op.value}`)
      if (delta < 0) next = shiftClips(next, later, delta)
      return { comp: next, info: { clip: clip.id, speed: op.value, duration: r3(clipTimelineDuration(requireClip(next, clip.id))) } }
    }
    case 'gain': {
      const clip = requireClip(comp, op.clip)
      const next = setClipEdits(comp, clip.id, { gainDb: op.db })
      return { comp: next, info: { clip: clip.id, gainDb: requireClip(next, clip.id).edits.gainDb } }
    }
    case 'fade': {
      const clip = requireClip(comp, op.clip)
      if (op.in === undefined && op.out === undefined) throw new Error('fade needs in or out')
      const e = clip.edits
      const next = setClipEdits(comp, clip.id, {
        ...(op.in === undefined ? {} : { fadeIn: { duration: op.in, shape: op.shape ?? e.fadeIn.shape } }),
        ...(op.out === undefined ? {} : { fadeOut: { duration: op.out, shape: op.shape ?? e.fadeOut.shape } }),
      })
      const done = requireClip(next, clip.id).edits
      return { comp: next, info: { clip: clip.id, in: r3(done.fadeIn.duration), out: r3(done.fadeOut.duration) } }
    }
    case 'crossfade': {
      const clip = requireClip(comp, op.clip)
      const room = maxCrossfade(comp, clip.id)
      if (op.seconds > 0 && room <= 0) {
        throw new Error(`clip ${clip.id} cannot crossfade: the next clip on its track must start exactly where it ends and have audio before its in point`)
      }
      return { comp: setCrossfade(comp, clip.id, op.seconds), info: { clip: clip.id, crossfade: r3(Math.min(op.seconds, room)) } }
    }
    case 'trimSilence': {
      const clip = requireClip(comp, op.clip)
      const take = takeOf(clip.sourceTakeId)
      if (!take?.words?.length) throw new Error(`clip ${clip.id} has no word timings; trimSilence needs them`)
      const words = clipWords(take, clip.srcIn, clip.srcOut)
      if (words.length === 0) throw new Error(`clip ${clip.id} holds no words`)
      const speed = clipSpeed(clip.edits)
      const pad = (op.pad ?? TRIM_PAD) * speed
      const lead = Math.max(0, Math.min(...words.map((w) => w.start)) - pad)
      const tail = Math.max(0, clip.srcOut - clip.srcIn - Math.max(...words.map((w) => w.end)) - pad)
      let next = comp
      if (lead > MIN_CLIP_SRC) next = trimClipEdge(next, clip.id, 'start', lead / speed)
      if (tail > MIN_CLIP_SRC) next = trimClipEdge(next, clip.id, 'end', -tail / speed)
      const done = requireClip(next, clip.id)
      return { comp: next, info: { clip: clip.id, trimmedStart: r3(done.start - clip.start), trimmedEnd: r3(clipEnd(clip) - clipEnd(done)) } }
    }
  }
}

export function applyEditOps(comp: CueComp, ops: readonly EditOp[], takeOf: TakeOf): { comp: CueComp; applied: EditInfo[] } {
  let next = normalizeComp(comp)
  const applied: EditInfo[] = []
  for (const [i, op] of ops.entries()) {
    try {
      const done = applyOp(next, op, takeOf)
      next = done.comp
      applied.push({ op: op.op, ...done.info })
    } catch (error) {
      throw new Error(`Op ${i + 1} (${op.op}) failed: ${message(error)}; nothing was changed.`)
    }
  }
  const problem = compProblem(next)
  if (problem) throw new Error(`The edited timeline would be invalid (${problem}); nothing was changed.`)
  return { comp: next, applied }
}

export const EFFECT_PRESETS = {
  radio: {
    highpass: { frequency: 300 },
    eq: { lowFreq: 250, lowGain: -12, midFreq: 1800, midGain: 6, midQ: 1.2, highFreq: 5000, highGain: -15 },
    compressor: { threshold: -24, ratio: 6, attack: 0.005, release: 0.1, knee: 6, makeup: 6 },
  },
  helmet: {
    highpass: { frequency: 120 },
    eq: { lowFreq: 150, lowGain: -4, midFreq: 900, midGain: 7, midQ: 2.5, highFreq: 6000, highGain: -9 },
    compressor: { threshold: -20, ratio: 3, attack: 0.01, release: 0.15, knee: 6, makeup: 3 },
    reverb: { mix: 0.18, size: 0.08, decay: 0.25, preDelay: 0.005 },
  },
  phone: {
    highpass: { frequency: 400 },
    eq: { lowFreq: 500, lowGain: -18, midFreq: 1500, midGain: 8, midQ: 1.5, highFreq: 3400, highGain: -18 },
    compressor: { threshold: -20, ratio: 4, attack: 0.005, release: 0.1, knee: 3, makeup: 4 },
  },
  cave: {
    eq: { lowFreq: 120, lowGain: -3, midFreq: 1000, midGain: 0, midQ: 1, highFreq: 6000, highGain: -4 },
    reverb: { mix: 0.45, size: 0.9, decay: 4, preDelay: 0.04 },
    delay: { time: 0.18, feedback: 0.3, mix: 0.15 },
  },
  clean: {},
} satisfies Record<string, ClipEffects>

export type EffectPreset = keyof typeof EFFECT_PRESETS

export const EFFECT_PRESET_NAMES = Object.keys(EFFECT_PRESETS) as EffectPreset[]

export interface ChainItem {
  kind: EffectKind
  params?: Record<string, number>
  enabled?: boolean
}

export function chainEffects(chain: readonly ChainItem[]): ClipEffects | undefined {
  const kinds = chain.map((item) => item.kind)
  const twice = kinds.find((k, i) => kinds.indexOf(k) !== i)
  if (twice) throw new Error(`${twice} appears twice in chain; the stack holds one of each kind`)
  const fx = Object.fromEntries(
    chain.map((item) => [item.kind, { ...toggleEffect(undefined, item.kind, true)?.[item.kind], ...item.params, ...(item.enabled === false ? { enabled: false } : {}) }])
  ) as ClipEffects
  return sanitizeEffects(fx)
}

export function bypassEffects(fx: ClipEffects | undefined, bypass: boolean): ClipEffects | undefined {
  return EFFECT_KINDS.reduce((acc, kind) => setEffectEnabled(acc, kind, !bypass), sanitizeEffects(fx))
}

export function effectsSummary(fx: ClipEffects | undefined): string[] {
  return EFFECT_KINDS.flatMap((kind) => {
    const effect = fx?.[kind]
    return effect ? [effect.enabled === false ? `${kind} (bypassed)` : kind] : []
  })
}

export interface AlignPair {
  dub: [number, number]
  original: [number, number]
}

export interface AlignInput {
  comp: CueComp
  takeOf: TakeOf
  dubFrom: number
  originalFrom: number
  dub: Span[]
  original: Span[]
  pairs: AlignPair[]
}

export interface AlignPhrase {
  dub: [number, number]
  original: [number, number]
  target: { start: number; duration: number }
  before: { start: number; duration: number }
  after?: { start: number; duration: number }
  speed?: number[]
  note?: string
}

export interface AlignPlan {
  ops: EditOp[]
  phrases: AlignPhrase[]
  comp: CueComp
}

type Side = 'start' | 'end'

interface Anchor {
  clip: string
  src: number
  side: Side
}

function anchorIn(clips: readonly CompClip[], t: number, side: Side): Anchor | null {
  const hits = clips.filter((c) => c.start - EDGE <= t && t <= clipEnd(c) + EDGE)
  const clip = hits.find((c) => (side === 'start' ? t < clipEnd(c) - EDGE : t > c.start + EDGE)) ?? hits[0]
  if (!clip) return null
  return { clip: clip.id, src: clip.srcIn + (Math.min(Math.max(t, clip.start), clipEnd(clip)) - clip.start) * clipSpeed(clip.edits), side }
}

export const ALIGN_ONE_VOICE = 'align needs one audible voice track; mute the others or edit manually'

function voiceTrack(comp: CueComp, start: number, end: number): string | undefined {
  const tracks = compTracks(comp)
  const voiced = [...new Set(comp.clips.filter((c) => c.start < end && clipEnd(c) > start).map(clipTrackId))].filter((id) => trackAudible(tracks, id))
  if (voiced.length > 1) throw new Error(ALIGN_ONE_VOICE)
  return voiced[0]
}

function splittable(comp: CueComp, track: string, t: number): boolean {
  const clip = cutCandidate(comp, t, track)
  return !!clip && splitClipAt(comp, clip.id, t).clips.length > comp.clips.length
}

interface Slivers {
  clip: CompClip
  before: boolean
  after: boolean
}

function slivers(comp: CueComp, takeOf: TakeOf, track: string, t: number): Slivers | null {
  const clip = cutCandidate(comp, t, track)
  if (!clip || !takeOf(clip.sourceTakeId)?.words?.length) return null
  const words = timelineWords(comp, takeOf).filter((w) => w.clip === clip.id)
  const empty = (from: number, to: number): boolean => to - from < SLIVER && !words.some((w) => w.end > from && w.start < to)
  return { clip, before: empty(clip.start, t), after: empty(t, clipEnd(clip)) }
}

export function planAlignment(input: AlignInput): AlignPlan {
  const { takeOf, dubFrom: from, originalFrom, dub, original } = input
  const base = normalizeComp(input.comp)
  let comp = base
  const ops: EditOp[] = []
  const phrases: AlignPhrase[] = []
  if (input.pairs.length === 0) return { ops, phrases, comp }
  const track = voiceTrack(
    base,
    from + Math.min(...input.pairs.map((p) => dub[p.dub[0]].start)),
    from + Math.max(...input.pairs.map((p) => dub[p.dub[1]].end))
  )
  const voice = track === undefined ? [] : trackClips(base, track)
  const origin = new Map<string, string>()
  const root = (id: string): string => origin.get(id) ?? id
  voice.forEach((c, i) => {
    const prev = voice[i - 1]
    if (prev?.sourceTakeId === c.sourceTakeId && Math.abs(prev.srcOut - c.srcIn) < 1e-6) origin.set(c.id, root(prev.id))
  })
  const locate = (at: CueComp, anchor: Anchor | null): { t: number; clip: CompClip } | null => {
    if (!anchor || track === undefined) return null
    const hits = trackClips(at, track).filter((c) => root(c.id) === root(anchor.clip) && c.srcIn - 1e-6 <= anchor.src && anchor.src <= c.srcOut + 1e-6)
    const clip = hits.find((c) => (anchor.side === 'start' ? anchor.src < c.srcOut - 1e-6 : anchor.src > c.srcIn + 1e-6)) ?? hits[0]
    return clip ? { t: clip.start + (anchor.src - clip.srcIn) / clipSpeed(clip.edits), clip } : null
  }
  const run = (op: EditOp): void => {
    const cutAt = op.op === 'cut' ? op.range?.end : op.op === 'split' || op.op === 'gap' ? op.at : undefined
    const parent = cutAt === undefined || track === undefined ? null : cutCandidate(comp, cutAt, track)
    const known = new Set(comp.clips.map((c) => c.id))
    comp = applyOp(comp, op, takeOf).comp
    ops.push(op)
    if (parent) for (const c of comp.clips) if (!known.has(c.id)) origin.set(c.id, root(parent.id))
  }
  for (const pair of input.pairs) {
    const [a, b] = pair.dub
    const d = { start: dub[a].start, end: dub[b].end }
    const o = { start: original[pair.original[0]].start + originalFrom - from, end: original[pair.original[1]].end + originalFrom - from }
    const target = { start: r3(o.start), duration: r3(o.end - o.start) }
    const entry: AlignPhrase = { dub: [a + 1, b + 1], original: [pair.original[0] + 1, pair.original[1] + 1], target, before: { start: r3(d.start), duration: r3(d.end - d.start) } }
    phrases.push(entry)
    const startAnchor = anchorIn(voice, d.start + from, 'start')
    const endAnchor = anchorIn(voice, d.end + from, 'end')
    const leftAt = a > 0 ? (dub[a - 1].end + d.start) / 2 : Math.max(0, d.start - ALIGN_PAD)
    const rightAt = b + 1 < dub.length ? (d.end + dub[b + 1].start) / 2 : d.end + ALIGN_PAD
    const left = anchorIn(voice, leftAt + from, 'end')
    const right = anchorIn(voice, rightAt + from, 'end')
    const prevEnd = a > 0 ? anchorIn(voice, dub[a - 1].end + from, 'end') : null
    const first = locate(comp, startAnchor)
    if (!first || !locate(comp, endAnchor) || track === undefined) {
      entry.note = 'this phrase is not on a timeline clip'
      continue
    }
    const saved = { comp, count: ops.length }
    try {
      const startT = first.t
      const length = (locate(comp, endAnchor)?.t ?? startT) - startT
      const want = o.end - o.start
      if (Math.abs(length - want) >= TIMING_TOLERANCE && want > 0) {
        for (const anchor of [left, right]) {
          const at = locate(comp, anchor)
          const edge = at && slivers(comp, takeOf, track, r3(at.t))
          if (at && splittable(comp, track, r3(at.t)) && !edge?.before && !edge?.after) run({ op: 'split', at: r3(at.t), track })
        }
        const lo = locate(comp, startAnchor)?.t ?? startT
        const hi = locate(comp, endAnchor)?.t ?? startT + length
        const ids = trackClips(comp, track)
          .filter((c) => c.start < hi - EDGE && clipEnd(c) > lo + EDGE)
          .map((c) => c.id)
        const content = ids.map((id) => requireClip(comp, id)).reduce((sum, c) => sum + Math.min(clipEnd(c), hi) - Math.max(c.start, lo), 0)
        const room = want - (hi - lo - content)
        const speeds: number[] = []
        for (const id of ids) {
          const clip = requireClip(comp, id)
          const value = room > 0 ? clampSpeed((clipSpeed(clip.edits) * content) / room) : SPEED_MAX
          speeds.push(value)
          if (Math.abs(value - clipSpeed(clip.edits)) < 0.005) continue
          run({ op: 'speed', at: r3((clip.start + clipEnd(clip)) / 2), track, value })
        }
        entry.speed = speeds
        if (speeds.some((s) => s === SPEED_MIN || s === SPEED_MAX)) entry.note = 'speed limit reached; also change the text to fit'
      }
      const now = locate(comp, startAnchor)?.t ?? startT
      const delta = o.start + from - now
      if (delta >= ALIGN_TOLERANCE) {
        const at = r3(Math.min(locate(comp, left)?.t ?? Math.max(0, now - ALIGN_PAD), now))
        const edge = slivers(comp, takeOf, track, at)
        run({ op: 'gap', at: edge?.before ? r3(edge.clip.start) : edge?.after ? r3(clipEnd(edge.clip)) : at, track, seconds: r3(delta) })
      } else if (delta <= -ALIGN_TOLERANCE) {
        const floor = prevEnd ? (locate(comp, prevEnd)?.t ?? 0) + ALIGN_PAD : 0
        const end = now - ALIGN_PAD
        const amount = Math.min(-delta, end - floor)
        if (amount >= ALIGN_TOLERANCE) {
          const range = { start: r3(end - amount), end: r3(end) }
          const head = slivers(comp, takeOf, track, range.start)
          const tail = slivers(comp, takeOf, track, range.end)
          run({ op: 'cut', range, track, ripple: true })
          if (tail?.after) run({ op: 'cut', range: { start: range.start, end: r3(range.start + clipEnd(tail.clip) - range.end) }, track, ripple: false })
          if (head?.before) run({ op: 'cut', range: { start: r3(head.clip.start), end: range.start }, track, ripple: false })
        }
        if (amount < -delta - ALIGN_TOLERANCE) entry.note = 'the pause before it is too short to start it on time'
      }
    } catch (error) {
      comp = saved.comp
      ops.length = saved.count
      entry.note = `left as is: ${message(error)}`
    }
    const start = locate(comp, startAnchor)?.t
    const end = locate(comp, endAnchor)?.t
    if (start !== undefined && end !== undefined) entry.after = { start: r3(start - from), duration: r3(end - start) }
  }
  return { ops, phrases, comp }
}
