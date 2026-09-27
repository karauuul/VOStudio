import { clampSpeed } from './generation'
import { PAUSE_MIN, peakPosition, voicedContour, type Contour, type PhraseProsody, type Prosody } from './prosody'

export const SKIP_COST = 0.5
export const MERGE_COST = 0.1
export const CONTOUR_POINTS = 20
export const FLAT_SPREAD_ST = 0.25
export const TIMING_TOLERANCE = 0.15
export const EMPHASIS_TOLERANCE = 0.2
export const SUGGESTIONS_MAX = 8
export const PAIRS_VIEW_MAX = 20

export interface Span {
  start: number
  end: number
}

export interface PhrasePair {
  dub: [number, number]
  original: [number, number]
  durationDiff: number
  startOffset: number
  dubFinal: Contour | null
  originalFinal: Contour | null
  finalMatch: boolean | null
  correlation: number | null
  dubPeakAt: number | null
  originalPeakAt: number | null
  emphasisMatch: boolean | null
}

export interface ProsodyComparison {
  pairs: PhrasePair[]
  extraDub: number[]
  missingOriginal: number[]
  lengthDiff: number
  speechDiff: number
  onsetDiff: number
  rhythm: number | null
  intonation: number | null
  suggestions: string[]
  analyzedSeconds?: number
}

const spanOf = (phrases: PhraseProsody[], from: number, to: number): Span => ({ start: phrases[from].start, end: phrases[to].end })
const length = (s: Span): number => s.end - s.start

export function alignPhrases(dub: Span[], original: Span[]): { pairs: { dub: [number, number]; original: [number, number] }[]; extraDub: number[]; missingOriginal: number[] } {
  const n = dub.length
  const m = original.length
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity))
  const step: { a: number; b: number }[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill({ a: 0, b: 0 }))
  cost[0][0] = 0
  const merged = (spans: Span[], from: number, count: number): Span => ({ start: spans[from].start, end: spans[from + count - 1].end })
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = cost[i][j]
      if (!Number.isFinite(here)) continue
      const relax = (a: number, b: number, add: number): void => {
        if (here + add < cost[i + a][j + b]) {
          cost[i + a][j + b] = here + add
          step[i + a][j + b] = { a, b }
        }
      }
      if (i < n) relax(1, 0, SKIP_COST + length(dub[i]))
      if (j < m) relax(0, 1, SKIP_COST + length(original[j]))
      for (let a = 1; a <= 2 && i + a <= n; a++) {
        for (let b = 1; b <= 2 && j + b <= m; b++) {
          const d = merged(dub, i, a)
          const o = merged(original, j, b)
          relax(a, b, Math.abs(d.start - o.start) + Math.abs(length(d) - length(o)) + (a + b - 2) * MERGE_COST)
        }
      }
    }
  }
  const pairs: { dub: [number, number]; original: [number, number] }[] = []
  const extraDub: number[] = []
  const missingOriginal: number[] = []
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const { a, b } = step[i][j]
    if (a > 0 && b > 0) pairs.unshift({ dub: [i - a, i - 1], original: [j - b, j - 1] })
    else if (a > 0) extraDub.unshift(i - 1)
    else missingOriginal.unshift(j - 1)
    i -= a
    j -= b
  }
  return { pairs, extraDub, missingOriginal }
}

function resampled(times: number[], values: number[], span: Span): number[] {
  const out: number[] = []
  for (let k = 0; k < CONTOUR_POINTS; k++) {
    const t = span.start + (length(span) * k) / (CONTOUR_POINTS - 1)
    let hi = times.findIndex((x) => x >= t)
    if (hi < 0) hi = times.length - 1
    const lo = Math.max(0, hi - 1)
    const w = times[hi] > times[lo] ? Math.min(1, Math.max(0, (t - times[lo]) / (times[hi] - times[lo]))) : 0
    out.push(values[lo] + (values[hi] - values[lo]) * w)
  }
  return out
}

function zScored(values: number[]): number[] | null {
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
  return sd < FLAT_SPREAD_ST ? null : values.map((v) => (v - mean) / sd)
}

export function contourCorrelation(dub: Prosody, dubSpan: Span, original: Prosody, originalSpan: Span): number | null {
  const a = voicedContour(dub.track, dubSpan.start, dubSpan.end + dub.track.hop)
  const b = voicedContour(original.track, originalSpan.start, originalSpan.end + original.track.hop)
  if (a.times.length < 5 || b.times.length < 5) return null
  const za = zScored(resampled(a.times, a.st, dubSpan))
  const zb = zScored(resampled(b.times, b.st, originalSpan))
  if (!za || !zb) return null
  return za.reduce((s, v, i) => s + v * zb[i], 0) / CONTOUR_POINTS
}

const r2 = (n: number): number => Math.round(n * 100) / 100
const pct = (n: number): string => `${Math.round(n * 100)}%`
const secs = (n: number): string => `${Math.abs(n).toFixed(2)} s`

function longestPause(dub: Prosody, from: number, to: number): { pause: number; after: string } | null {
  let best: { pause: number; after: string } | null = null
  const words = dub.words.filter((w) => w.phrase >= from && w.phrase <= to)
  for (let i = 1; i < words.length; i++) {
    const pause = words[i].start - words[i - 1].end
    if (pause >= PAUSE_MIN && (!best || pause > best.pause)) best = { pause, after: words[i - 1].text }
  }
  for (let p = from; p < to; p++) {
    const pause = dub.phrases[p + 1].start - dub.phrases[p].end
    if (pause >= PAUSE_MIN && (!best || pause > best.pause)) {
      const last = dub.words.filter((w) => w.phrase === p).pop()
      best = { pause, after: last ? last.text : `${dub.phrases[p].end.toFixed(2)} s` }
    }
  }
  return best
}

function speedAdvice(dubLength: number, originalLength: number, speed: number): string {
  const wanted = (speed * dubLength) / originalLength
  const clamped = clampSpeed(wanted)
  const reach = Math.abs(clamped - wanted) > 0.005 ? ` (the speed limit; also ${dubLength > originalLength ? 'shorten' : 'lengthen'} the text)` : ''
  return `speed ${clamped.toFixed(2)}${reach}`
}

const wordNear = (dub: Prosody, phrase: number, at: number): string | null => {
  const hit = dub.words.find((w) => w.phrase === phrase && w.start <= at && w.end >= at)
  return hit ? hit.text : null
}

function pairSuggestions(dub: Prosody, pair: PhrasePair, label: string, speed: number, timing: boolean): string[] {
  const out: string[] = []
  const dubSpan = spanOf(dub.phrases, pair.dub[0], pair.dub[1])
  if (timing && Math.abs(pair.durationDiff) >= TIMING_TOLERANCE) {
    const longer = pair.durationDiff > 0
    const pause = longer ? longestPause(dub, pair.dub[0], pair.dub[1]) : null
    const origLength = length(dubSpan) - pair.durationDiff
    const cut = pause ? ` or remove the ${pause.pause.toFixed(2)} s pause after "${pause.after}"` : ''
    out.push(`${label} is ${secs(pair.durationDiff)} ${longer ? 'longer' : 'shorter'}: ${speedAdvice(length(dubSpan), origLength, speed)}${cut}`)
  }
  if (timing && Math.abs(pair.startOffset) >= TIMING_TOLERANCE) {
    out.push(`${label} starts ${secs(pair.startOffset)} ${pair.startOffset > 0 ? 'late' : 'early'}: move it ${secs(pair.startOffset)} ${pair.startOffset > 0 ? 'earlier' : 'later'}`)
  }
  if (pair.finalMatch === false && pair.originalFinal && pair.dubFinal) {
    const delivery = pair.originalFinal === 'rising' ? 'a questioning' : pair.originalFinal === 'falling' ? 'a statement (falling)' : 'a level, unfinished'
    const question = pair.originalFinal === 'rising' ? ' (question-like)' : ''
    out.push(`original ${label} ends ${pair.originalFinal}${question}, dub ends ${pair.dubFinal}: regenerate with ${delivery} delivery`)
  }
  if (pair.emphasisMatch === false && pair.dubPeakAt !== null && pair.originalPeakAt !== null) {
    const word = wordNear(dub, pair.dub[0], dubSpan.start + pair.dubPeakAt * length(dubSpan))
    const target = wordNear(dub, pair.dub[0], dubSpan.start + pair.originalPeakAt * length(dubSpan))
    const now = word ? ` ("${word}")` : ''
    const want = target ? `, near "${target}"` : ''
    out.push(
      `${label} stress: original peaks at ${pct(pair.originalPeakAt)} of the phrase, dub at ${pct(pair.dubPeakAt)}${now}: move the emphasis ${pair.originalPeakAt > pair.dubPeakAt ? 'later' : 'earlier'}${want}`
    )
  }
  if (pair.correlation !== null && pair.correlation < 0) {
    out.push(`${label} pitch contour runs against the original (r ${pair.correlation.toFixed(2)}): regenerate with a delivery closer to the original`)
  }
  return out
}

const weighted = (items: { w: number; s: number }[]): number | null => {
  const total = items.reduce((sum, x) => sum + x.w, 0)
  return total > 0 ? r2(items.reduce((sum, x) => sum + x.w * x.s, 0) / total) : null
}

const analyzedUntil = (p: Prosody): number => (p.truncated ? p.duration : Infinity)
const fullLength = (measured: number | undefined, p: Prosody): number => (measured !== undefined && measured > 0 ? measured : p.duration)

export function compareProsody(dub: Prosody, original: Prosody, speed = 1, lengths: { dub?: number; original?: number } = {}): ProsodyComparison {
  const limit = Math.min(analyzedUntil(dub), analyzedUntil(original))
  const cut = Number.isFinite(limit)
  const analyzed = (...spans: Span[]): boolean => spans.every((s) => s.end < limit - TIMING_TOLERANCE)
  const dubSpans = dub.phrases.map((p) => ({ start: p.start, end: p.end }))
  const originalSpans = original.phrases.map((p) => ({ start: p.start, end: p.end }))
  const aligned = alignPhrases(dubSpans, originalSpans)
  const pairs = aligned.pairs.map((p): PhrasePair => {
    const d = spanOf(dub.phrases, p.dub[0], p.dub[1])
    const o = spanOf(original.phrases, p.original[0], p.original[1])
    const dubFinal = dub.phrases[p.dub[1]].finalContour
    const originalFinal = original.phrases[p.original[1]].finalContour
    const dubPeakAt = peakPosition(dub.track, d.start, d.end + dub.track.hop)
    const originalPeakAt = peakPosition(original.track, o.start, o.end + original.track.hop)
    return {
      dub: p.dub,
      original: p.original,
      durationDiff: length(d) - length(o),
      startOffset: d.start - o.start,
      dubFinal,
      originalFinal,
      finalMatch: dubFinal && originalFinal ? dubFinal === originalFinal : null,
      correlation: contourCorrelation(dub, d, original, o),
      dubPeakAt,
      originalPeakAt,
      emphasisMatch: dubPeakAt === null || originalPeakAt === null ? null : Math.abs(dubPeakAt - originalPeakAt) <= EMPHASIS_TOLERANCE,
    }
  })
  const speech = (p: Prosody): Span | null => (p.phrases.length > 0 ? spanOf(p.phrases, 0, p.phrases.length - 1) : null)
  const dubSpeech = speech(dub)
  const originalSpeech = speech(original)
  const speechDiff = dubSpeech && originalSpeech ? length(dubSpeech) - length(originalSpeech) : 0
  const onsetDiff = dubSpeech && originalSpeech ? dubSpeech.start - originalSpeech.start : 0
  const rhythm = weighted([
    ...pairs.map((p) => {
      const o = length(spanOf(original.phrases, p.original[0], p.original[1]))
      return { w: Math.max(o, 0.1), s: Math.max(0, 1 - (Math.abs(p.durationDiff) + Math.abs(p.startOffset)) / Math.max(o, 0.5)) }
    }),
    ...aligned.extraDub.map((i) => ({ w: Math.max(length(dubSpans[i]), 0.1), s: 0 })),
    ...aligned.missingOriginal.map((j) => ({ w: Math.max(length(originalSpans[j]), 0.1), s: 0 })),
  ])
  const intonation = weighted(
    pairs.flatMap((p) => {
      const parts = [
        ...(p.finalMatch === null ? [] : [p.finalMatch ? 1 : 0]),
        ...(p.correlation === null ? [] : [(p.correlation + 1) / 2]),
        ...(p.emphasisMatch === null ? [] : [p.emphasisMatch ? 1 : 0]),
      ]
      if (parts.length === 0) return []
      return [{ w: Math.max(length(spanOf(original.phrases, p.original[0], p.original[1])), 0.1), s: parts.reduce((s, v) => s + v, 0) / parts.length }]
    })
  )
  const suggestions: string[] = []
  if (!cut && dubSpeech && originalSpeech && Math.abs(speechDiff) >= TIMING_TOLERANCE) {
    const longer = speechDiff > 0
    const pause = longer ? longestPause(dub, 0, dub.phrases.length - 1) : null
    const cut = pause ? ` or remove the ${pause.pause.toFixed(2)} s pause after "${pause.after}"` : ''
    suggestions.push(
      `dub speech is ${secs(speechDiff)} ${longer ? 'longer' : 'shorter'} than the original (${length(dubSpeech).toFixed(2)} vs ${length(originalSpeech).toFixed(2)} s): ${speedAdvice(length(dubSpeech), length(originalSpeech), speed)}${cut}`
    )
  }
  if (dubSpeech && originalSpeech && Math.abs(onsetDiff) >= TIMING_TOLERANCE) {
    suggestions.push(`dub speech starts ${secs(onsetDiff)} ${onsetDiff > 0 ? 'later' : 'earlier'} than the original: move it ${secs(onsetDiff)} ${onsetDiff > 0 ? 'earlier' : 'later'}`)
  }
  const multi = pairs.length > 1
  for (const [index, pair] of pairs.entries()) {
    const label = multi ? `phrase ${index + 1}` : 'phrase'
    const timing = multi && analyzed(spanOf(dub.phrases, pair.dub[0], pair.dub[1]), spanOf(original.phrases, pair.original[0], pair.original[1]))
    suggestions.push(...pairSuggestions(dub, pair, label, speed, timing))
  }
  for (const i of aligned.extraDub.filter((i) => analyzed(dubSpans[i]))) {
    suggestions.push(`dub has an extra phrase at ${dubSpans[i].start.toFixed(2)} s (${length(dubSpans[i]).toFixed(2)} s) with no counterpart in the original`)
  }
  for (const j of aligned.missingOriginal.filter((j) => analyzed(originalSpans[j]))) {
    suggestions.push(`original phrase at ${originalSpans[j].start.toFixed(2)} s (${length(originalSpans[j]).toFixed(2)} s) has no counterpart in the dub`)
  }
  return {
    pairs,
    extraDub: aligned.extraDub,
    missingOriginal: aligned.missingOriginal,
    lengthDiff: fullLength(lengths.dub, dub) - fullLength(lengths.original, original),
    speechDiff,
    onsetDiff,
    rhythm,
    intonation,
    suggestions: suggestions.slice(0, SUGGESTIONS_MAX),
    ...(cut ? { analyzedSeconds: limit } : {}),
  }
}

export function comparisonView(c: ProsodyComparison): Record<string, unknown> {
  const range = ([a, b]: [number, number]): number | number[] => (a === b ? a + 1 : [a + 1, b + 1])
  return {
    lengthDiff: r2(c.lengthDiff),
    speechDiff: r2(c.speechDiff),
    onsetDiff: r2(c.onsetDiff),
    rhythm: c.rhythm,
    intonation: c.intonation,
    pairs: c.pairs.slice(0, PAIRS_VIEW_MAX).map((p) => ({
      dub: range(p.dub),
      original: range(p.original),
      durationDiff: r2(p.durationDiff),
      startOffset: r2(p.startOffset),
      final: { dub: p.dubFinal, original: p.originalFinal, match: p.finalMatch },
      correlation: p.correlation === null ? null : r2(p.correlation),
      emphasis: { dub: p.dubPeakAt === null ? null : r2(p.dubPeakAt), original: p.originalPeakAt === null ? null : r2(p.originalPeakAt), match: p.emphasisMatch },
    })),
    ...(c.pairs.length > PAIRS_VIEW_MAX ? { pairsTotal: c.pairs.length } : {}),
    ...(c.extraDub.length > 0 ? { extraDubPhrases: c.extraDub.map((i) => i + 1) } : {}),
    ...(c.missingOriginal.length > 0 ? { unmatchedOriginalPhrases: c.missingOriginal.map((j) => j + 1) } : {}),
    suggestions: c.suggestions,
    ...(c.analyzedSeconds === undefined
      ? {}
      : { analyzedSeconds: r2(c.analyzedSeconds), note: `Analysis stops at ${c.analyzedSeconds.toFixed(2)} s; overall speech length and timing past it are not compared` }),
  }
}
