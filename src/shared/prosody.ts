import type { WordTiming } from './domain'

export const ANALYSIS_RATE = 16000
export const ANALYSIS_MAX_SECONDS = 60
export const HOP_SECONDS = 0.01
export const RMS_SECONDS = 0.02
export const PITCH_SECONDS = 0.04
export const F0_MIN = 60
export const F0_MAX = 500
export const YIN_THRESHOLD = 0.15
export const SILENCE_BELOW_PEAK_DB = 35
export const SILENCE_FLOOR_DB = -60
export const PAUSE_MIN = 0.15
export const FINAL_SECONDS = 0.3
export const CONTOUR_SEMITONES = 1
export const EMPHASIS_DB = 3
export const EMPHASIS_SEMITONES = 2
export const MIN_VOICED_RUN = 3
export const MIN_PHRASE_FRAMES = 3
export const FLAT_PEAK_DB = 3
export const FLAT_PEAK_ST = 1

const DB_FLOOR = -100

export type Contour = 'rising' | 'flat' | 'falling'

export interface FrameTrack {
  hop: number
  db: Float32Array
  f0: Float32Array
  peak: Float32Array
}

export interface WordProsody {
  text: string
  start: number
  end: number
  pauseBefore: number
  f0: { mean: number; min: number; max: number } | null
  contour: Contour | null
  db: number
  emphasis: boolean
  phrase: number
}

export interface PhraseProsody {
  start: number
  end: number
  words: number
  rate: number
  rateUnit: 'words/s' | 'voiced'
  finalContour: Contour | null
  f0Mean: number | null
  f0RangeSt: number | null
  db: number
  peakAt: number | null
}

export interface Prosody {
  duration: number
  silenceDb: number
  track: FrameTrack
  words: WordProsody[]
  phrases: PhraseProsody[]
}

export const semitones = (hz: number): number => 12 * Math.log2(hz / 100)

const powerDb = (power: number): number => (power > 0 ? Math.max(DB_FLOOR, 10 * Math.log10(power)) : DB_FLOOR)

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.min(sorted.length - 1, lo + 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

export function yinPitch(frame: Float32Array, rate: number, threshold = YIN_THRESHOLD): number | null {
  const maxLag = Math.min(Math.floor(rate / F0_MIN), frame.length - 3)
  const span = frame.length - maxLag - 1
  if (span < 2 || maxLag <= 2) return null
  const cmnd = new Float32Array(maxLag + 2)
  cmnd[0] = 1
  let running = 0
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let sum = 0
    for (let j = 0; j < span; j++) {
      const d = frame[j] - frame[j + lag]
      sum += d * d
    }
    running += sum
    cmnd[lag] = running > 0 ? (sum * lag) / running : 1
  }
  let lag = -1
  for (let t = 2; t <= maxLag; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= maxLag && cmnd[t + 1] < cmnd[t]) t++
      lag = t
      break
    }
  }
  if (lag < 0) return null
  const a = cmnd[lag - 1]
  const b = cmnd[lag]
  const c = cmnd[lag + 1]
  const bend = a - 2 * b + c
  const refined = bend > 0 ? lag + (a - c) / (2 * bend) : lag
  const f0 = rate / refined
  return f0 >= F0_MIN && f0 <= F0_MAX ? f0 : null
}

function windowAt(pcm: Float32Array, center: number, size: number): Float32Array {
  const out = new Float32Array(size)
  const from = center - (size >> 1)
  for (let i = 0; i < size; i++) {
    const at = from + i
    if (at >= 0 && at < pcm.length) out[i] = pcm[at]
  }
  return out
}

function cleanVoicing(f0: Float32Array): void {
  const smoothed = Float32Array.from(f0)
  for (let i = 1; i < f0.length - 1; i++) {
    if (f0[i - 1] > 0 && f0[i] > 0 && f0[i + 1] > 0) smoothed[i] = median([f0[i - 1], f0[i], f0[i + 1]])
  }
  f0.set(smoothed)
  for (let i = 0; i < f0.length; ) {
    if (!(f0[i] > 0)) {
      i++
      continue
    }
    let end = i
    while (end < f0.length && f0[end] > 0) end++
    if (end - i < MIN_VOICED_RUN) f0.fill(0, i, end)
    i = end
  }
}

export const silenceThreshold = (db: Float32Array): number => {
  let loudest = DB_FLOOR
  for (const v of db) if (v > loudest) loudest = v
  return Math.max(SILENCE_FLOOR_DB, loudest - SILENCE_BELOW_PEAK_DB)
}

export function analyzeFrames(pcm: Float32Array, rate: number): FrameTrack {
  const hop = Math.max(1, Math.round(HOP_SECONDS * rate))
  const rmsSize = Math.max(1, Math.round(RMS_SECONDS * rate))
  const pitchSize = Math.max(4, Math.round(PITCH_SECONDS * rate))
  const count = Math.ceil(pcm.length / hop)
  const db = new Float32Array(count)
  const peak = new Float32Array(count)
  const f0 = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const center = i * hop
    const from = center - (rmsSize >> 1)
    let power = 0
    for (let k = Math.max(0, from); k < Math.min(pcm.length, from + rmsSize); k++) power += pcm[k] * pcm[k]
    db[i] = powerDb(power / rmsSize)
    let top = 0
    for (let k = Math.max(0, center - (hop >> 1)); k < Math.min(pcm.length, center + hop - (hop >> 1)); k++) {
      const v = Math.abs(pcm[k])
      if (v > top) top = v
    }
    peak[i] = top
  }
  const floor = silenceThreshold(db)
  for (let i = 0; i < count; i++) {
    if (db[i] < floor) continue
    f0[i] = yinPitch(windowAt(pcm, i * hop, pitchSize), rate) ?? 0
  }
  cleanVoicing(f0)
  return { hop: hop / rate, db, f0, peak }
}

export function contourOf(times: number[], values: number[]): Contour | null {
  if (times.length < 2) return null
  const stride = Math.max(1, Math.ceil(times.length / 60))
  const slopes: number[] = []
  for (let i = 0; i < times.length; i += stride) {
    for (let j = i + stride; j < times.length; j += stride) {
      if (times[j] > times[i]) slopes.push((values[j] - values[i]) / (times[j] - times[i]))
    }
  }
  if (slopes.length === 0) return null
  const change = median(slopes) * (times[times.length - 1] - times[0])
  return change >= CONTOUR_SEMITONES ? 'rising' : change <= -CONTOUR_SEMITONES ? 'falling' : 'flat'
}

interface Voiced {
  times: number[]
  st: number[]
  hz: number[]
}

function voicedIn(track: FrameTrack, start: number, end: number): Voiced {
  const out: Voiced = { times: [], st: [], hz: [] }
  const from = Math.max(0, Math.ceil(start / track.hop - 1e-9))
  const to = Math.min(track.f0.length, Math.ceil(end / track.hop - 1e-9))
  for (let i = from; i < to; i++) {
    const hz = track.f0[i]
    if (!(hz > 0)) continue
    out.times.push(i * track.hop)
    out.hz.push(hz)
    out.st.push(semitones(hz))
  }
  return out
}

function meanDb(track: FrameTrack, start: number, end: number): number {
  const from = Math.max(0, Math.ceil(start / track.hop - 1e-9))
  const to = Math.min(track.db.length, Math.max(from + 1, Math.ceil(end / track.hop - 1e-9)))
  let power = 0
  for (let i = from; i < to; i++) power += 10 ** (track.db[i] / 10)
  return powerDb(power / Math.max(1, to - from))
}

export function peakPosition(track: FrameTrack, start: number, end: number): number | null {
  const voiced = voicedIn(track, start, end)
  if (voiced.times.length < MIN_VOICED_RUN || !(end > start)) return null
  const dbs = voiced.times.map((t) => track.db[Math.round(t / track.hop)])
  const z = (values: number[]): number[] => {
    const mean = values.reduce((s, v) => s + v, 0) / values.length
    const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
    return values.map((v) => (sd > 1e-6 ? (v - mean) / sd : 0))
  }
  const spread = (values: number[]): number => quantile(values, 0.9) - quantile(values, 0.1)
  if (spread(dbs) < FLAT_PEAK_DB && spread(voiced.st) < FLAT_PEAK_ST) return null
  const zDb = z(dbs)
  const zSt = z(voiced.st)
  let best = 0
  let bestScore = -Infinity
  for (let i = 0; i < zDb.length; i++) {
    let score = 0
    let n = 0
    for (let k = Math.max(0, i - 2); k <= Math.min(zDb.length - 1, i + 2); k++) {
      score += zDb[k] + zSt[k]
      n++
    }
    if (score / n > bestScore) {
      bestScore = score / n
      best = i
    }
  }
  return Math.min(1, Math.max(0, (voiced.times[best] - start) / (end - start)))
}

export function findPhrases(track: FrameTrack, silenceDb = silenceThreshold(track.db)): { start: number; end: number }[] {
  const gap = Math.round(PAUSE_MIN / track.hop)
  const runs: { from: number; to: number }[] = []
  for (let i = 0; i < track.db.length; ) {
    if (track.db[i] < silenceDb) {
      i++
      continue
    }
    let to = i
    while (to < track.db.length && track.db[to] >= silenceDb) to++
    const last = runs[runs.length - 1]
    if (last && i - last.to < gap) last.to = to
    else runs.push({ from: i, to })
    i = to
  }
  return runs.filter((r) => r.to - r.from >= MIN_PHRASE_FRAMES).map((r) => ({ start: r.from * track.hop, end: (r.to - 1) * track.hop }))
}

function finalContour(voiced: Voiced): Contour | null {
  const last = voiced.times[voiced.times.length - 1]
  if (last === undefined) return null
  const from = voiced.times.findIndex((t) => t >= last - FINAL_SECONDS)
  return contourOf(voiced.times.slice(from), voiced.st.slice(from))
}

function wordProsody(track: FrameTrack, word: WordTiming, previousEnd: number, phrase: number): WordProsody {
  const voiced = voicedIn(track, word.start, word.end)
  return {
    text: word.text,
    start: word.start,
    end: word.end,
    pauseBefore: Math.max(0, word.start - previousEnd),
    f0:
      voiced.hz.length > 0
        ? { mean: voiced.hz.reduce((s, v) => s + v, 0) / voiced.hz.length, min: Math.min(...voiced.hz), max: Math.max(...voiced.hz) }
        : null,
    contour: contourOf(voiced.times, voiced.st),
    db: meanDb(track, word.start, word.end),
    emphasis: false,
    phrase,
  }
}

function markEmphasis(words: WordProsody[]): void {
  if (words.length < 2) return
  const dbMid = median(words.map((w) => w.db))
  const pitched = words.flatMap((w) => (w.f0 ? [semitones(w.f0.max)] : []))
  const stMid = pitched.length > 0 ? median(pitched) : null
  for (const w of words) {
    const louder = w.db - dbMid >= EMPHASIS_DB
    const higher = stMid !== null && w.f0 !== null && semitones(w.f0.max) - stMid >= EMPHASIS_SEMITONES
    w.emphasis = louder || higher
  }
}

const nearestPhrase = (spans: { start: number; end: number }[], t: number): number => {
  let best = 0
  let bestDistance = Infinity
  spans.forEach((s, i) => {
    const d = t < s.start ? s.start - t : t > s.end ? t - s.end : 0
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  })
  return best
}

export function analyzeProsody(pcm: Float32Array, rate: number, timings?: WordTiming[]): Prosody {
  const track = analyzeFrames(pcm, rate)
  const silenceDb = silenceThreshold(track.db)
  const spans = findPhrases(track, silenceDb)
  const sorted = [...(timings ?? [])].filter((w) => w.end > w.start).sort((a, b) => a.start - b.start)
  const words = sorted.map((w, i) =>
    wordProsody(track, w, i > 0 ? sorted[i - 1].end : 0, spans.length > 0 ? nearestPhrase(spans, (w.start + w.end) / 2) : -1)
  )
  const phrases = spans.map((span, index): PhraseProsody => {
    const own = words.filter((w) => w.phrase === index)
    markEmphasis(own)
    const voiced = voicedIn(track, span.start, span.end + track.hop)
    const duration = Math.max(track.hop, span.end - span.start)
    const frames = Math.max(1, Math.round(duration / track.hop))
    return {
      start: span.start,
      end: span.end,
      words: own.length,
      rate: own.length > 0 ? own.length / duration : Math.min(1, voiced.times.length / frames),
      rateUnit: own.length > 0 ? 'words/s' : 'voiced',
      finalContour: finalContour(voiced),
      f0Mean: voiced.hz.length > 0 ? voiced.hz.reduce((s, v) => s + v, 0) / voiced.hz.length : null,
      f0RangeSt: voiced.st.length >= MIN_VOICED_RUN ? quantile(voiced.st, 0.9) - quantile(voiced.st, 0.1) : null,
      db: meanDb(track, span.start, span.end + track.hop),
      peakAt: peakPosition(track, span.start, span.end + track.hop),
    }
  })
  return { duration: pcm.length / rate, silenceDb, track, words, phrases }
}

export function voicedContour(track: FrameTrack, start: number, end: number): { times: number[]; st: number[] } {
  const { times, st } = voicedIn(track, start, end)
  return { times, st }
}

const r2 = (n: number): number => Math.round(n * 100) / 100
const r0 = (n: number): number => Math.round(n)
const r1 = (n: number): number => Math.round(n * 10) / 10

const ARROWS: Record<Contour, string> = { rising: '↗', flat: '→', falling: '↘' }

export const TRANSCRIPT_WORDS_MAX = 80
export const TRANSCRIPT_PHRASES_MAX = 30

function wordToken(w: WordProsody): string {
  const pitch = w.f0 ? `${w.contour ? ARROWS[w.contour] : ''}${r0(w.f0.mean)}Hz` : 'unvoiced'
  return `${w.start.toFixed(2)} ${w.emphasis ? `*${w.text}*` : w.text} ${pitch} ${r0(w.db)}dB`
}

const rateText = (p: PhraseProsody): string =>
  p.rateUnit === 'words/s' ? `${r1(p.rate)} w/s` : `voiced ${Math.round(p.rate * 100)}%`

function phraseToken(p: PhraseProsody): string {
  const pitch = p.f0Mean === null ? 'unvoiced' : `${r0(p.f0Mean)}Hz ${r1(p.f0RangeSt ?? 0)}st`
  return `${p.start.toFixed(2)}-${p.end.toFixed(2)} ${pitch} ${r0(p.db)}dB`
}

export function prosodyTranscript(p: Prosody): string {
  if (p.phrases.length === 0) return 'silence'
  const parts: string[] = []
  let words = 0
  let shown = 0
  for (const [index, phrase] of p.phrases.entries()) {
    if (shown >= TRANSCRIPT_PHRASES_MAX || words >= TRANSCRIPT_WORDS_MAX) break
    if (index > 0) parts.push(`[pause ${(phrase.start - p.phrases[index - 1].end).toFixed(2)}]`)
    const own = p.words.filter((w) => w.phrase === index).slice(0, TRANSCRIPT_WORDS_MAX - words)
    words += own.length
    const tokens =
      own.length === 0
        ? [phraseToken(phrase)]
        : own.map((w, i) => `${i > 0 && w.pauseBefore >= PAUSE_MIN ? `[pause ${w.pauseBefore.toFixed(2)}] · ` : ''}${wordToken(w)}`)
    parts.push(`${tokens.join(' · ')} | ${phrase.finalContour ?? 'unvoiced'}, ${rateText(phrase)}`)
    shown++
  }
  const truncated = shown < p.phrases.length || words < p.words.filter((w) => w.phrase >= 0).length
  return `${parts.join(' · ')}${truncated ? ' · … truncated' : ''}`
}

export const WORDS_VIEW_MAX = 60
export const PHRASES_VIEW_MAX = 20

export function prosodyView(p: Prosody): Record<string, unknown> {
  return {
    duration: r2(p.duration),
    transcript: prosodyTranscript(p),
    phrases: p.phrases.slice(0, PHRASES_VIEW_MAX).map((ph) => ({
      start: r2(ph.start),
      end: r2(ph.end),
      duration: r2(ph.end - ph.start),
      ...(ph.words > 0 ? { words: ph.words } : {}),
      ...(ph.rateUnit === 'words/s' ? { wordsPerSecond: r1(ph.rate) } : { voicedRatio: r2(ph.rate) }),
      finalContour: ph.finalContour,
      f0Mean: ph.f0Mean === null ? null : r0(ph.f0Mean),
      f0RangeSt: ph.f0RangeSt === null ? null : r1(ph.f0RangeSt),
      db: r0(ph.db),
      ...(ph.peakAt === null ? {} : { peakAt: r2(ph.peakAt) }),
    })),
    ...(p.phrases.length > PHRASES_VIEW_MAX ? { phrasesTotal: p.phrases.length } : {}),
    ...(p.words.length > 0
      ? {
          words: p.words.slice(0, WORDS_VIEW_MAX).map((w) => ({
            text: w.text,
            start: r2(w.start),
            duration: r2(w.end - w.start),
            pauseBefore: r2(w.pauseBefore),
            f0: w.f0 ? { mean: r0(w.f0.mean), min: r0(w.f0.min), max: r0(w.f0.max) } : null,
            contour: w.contour,
            db: r0(w.db),
            ...(w.emphasis ? { emphasis: true } : {}),
            phrase: w.phrase + 1,
          })),
        }
      : {}),
    ...(p.words.length > WORDS_VIEW_MAX ? { wordsTotal: p.words.length } : {}),
  }
}

export type PanelKind = 'original' | 'dub'

export interface ProsodyPanel {
  kind: PanelKind
  duration: number
  hop: number
  peak: number[]
  db: number[]
  f0: number[]
  silenceDb: number
  words: { text: string; start: number; end: number; emphasis: boolean }[]
  phrases: { start: number; end: number; finalContour: Contour | null }[]
}

export interface ProsodyFigure {
  title: string
  panels: ProsodyPanel[]
}

export const FIGURE_WIDTH = 1200
export const FIGURE_PANEL_HEIGHT = 226
export const FIGURE_CHROME_HEIGHT = 48

const r3 = (n: number): number => Math.round(n * 1000) / 1000

export const prosodyPanel = (kind: PanelKind, p: Prosody): ProsodyPanel => ({
  kind,
  duration: p.duration,
  hop: p.track.hop,
  peak: Array.from(p.track.peak, r3),
  db: Array.from(p.track.db, r1),
  f0: Array.from(p.track.f0, r1),
  silenceDb: p.silenceDb,
  words: p.words.map((w) => ({ text: w.text, start: w.start, end: w.end, emphasis: w.emphasis })),
  phrases: p.phrases.map((ph) => ({ start: ph.start, end: ph.end, finalContour: ph.finalContour })),
})
