import { describe, expect, it } from 'vitest'
import {
  analyzeFrames,
  analyzeProsody,
  ANALYSIS_MAX_SECONDS,
  ANALYSIS_RATE,
  contourOf,
  findPhrases,
  prosodyTranscript,
  prosodyView,
  WORDS_VIEW_MAX,
  yinPitch,
} from '../src/shared/prosody'
import { alignPhrases, compareProsody, comparisonView } from '../src/shared/prosody-compare'

const RATE = ANALYSIS_RATE

interface Part {
  seconds: number
  from?: number
  to?: number
  amp?: number
}

function signal(parts: Part[]): Float32Array {
  const total = parts.reduce((s, p) => s + Math.round(p.seconds * RATE), 0)
  const out = new Float32Array(total)
  let at = 0
  for (const p of parts) {
    const n = Math.round(p.seconds * RATE)
    let phase = 0
    for (let i = 0; i < n; i++) {
      if (p.from !== undefined) {
        const f = p.from * Math.pow((p.to ?? p.from) / p.from, i / n)
        phase += (2 * Math.PI * f) / RATE
        const edge = Math.min(1, i / 160, (n - 1 - i) / 160)
        out[at + i] = (p.amp ?? 0.5) * edge * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase)) / 1.75
      }
    }
    at += n
  }
  return out
}

const tone = (seconds: number, from: number, to = from, amp = 0.5): Part => ({ seconds, from, to, amp })
const gap = (seconds: number): Part => ({ seconds })

function noise(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  let seed = 12345
  for (let i = 0; i < out.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    out[i] = (seed / 0xffffffff - 0.5) * 0.6
  }
  return out
}

describe('YIN pitch', () => {
  it('finds the fundamental of tones across the speech range', () => {
    for (const f of [70, 110, 180, 260, 420]) {
      const frame = signal([tone(0.04, f)]).subarray(0, 640)
      const heard = yinPitch(Float32Array.from(frame), RATE)
      expect(heard).not.toBeNull()
      expect(Math.abs((heard ?? 0) / f - 1)).toBeLessThan(0.02)
    }
  })

  it('calls pitch above the range unvoiced instead of folding it an octave down', () => {
    for (const f of [523, 660, 900]) expect(yinPitch(Float32Array.from(signal([tone(0.04, f)]).subarray(0, 640)), RATE)).toBeNull()
  })

  it('calls silence and noise unvoiced', () => {
    expect(yinPitch(new Float32Array(640), RATE)).toBeNull()
    const track = analyzeFrames(noise(0.5), RATE)
    const voiced = Array.from(track.f0).filter((f) => f > 0).length
    expect(voiced / track.f0.length).toBeLessThan(0.1)
  })
})

describe('frames and phrases', () => {
  it('silence has no phrases and a silence transcript', () => {
    const p = analyzeProsody(new Float32Array(RATE), RATE)
    expect(p.phrases).toEqual([])
    expect(prosodyTranscript(p)).toBe('silence')
    expect(Array.from(p.track.f0).every((f) => f === 0)).toBe(true)
  })

  it('splits phrases at pauses of 150 ms or more and keeps shorter gaps inside a phrase', () => {
    const split = analyzeProsody(signal([gap(0.2), tone(0.5, 150), gap(0.3), tone(0.4, 150)]), RATE)
    expect(split.phrases).toHaveLength(2)
    expect(split.phrases[0].start).toBeCloseTo(0.2, 1)
    expect(split.phrases[0].end).toBeCloseTo(0.7, 1)
    expect(split.phrases[1].start).toBeCloseTo(1.0, 1)
    expect(split.phrases[1].end).toBeCloseTo(1.4, 1)
    const joined = analyzeFrames(signal([tone(0.5, 150), gap(0.08), tone(0.4, 150)]), RATE)
    expect(findPhrases(joined)).toHaveLength(1)
  })

  it('reads rising, falling and flat final contours from chirps', () => {
    const final = (from: number, to: number) => analyzeProsody(signal([gap(0.1), tone(0.8, from, to), gap(0.1)]), RATE).phrases[0]
    expect(final(120, 200).finalContour).toBe('rising')
    expect(final(220, 130).finalContour).toBe('falling')
    const flat = final(160, 160)
    expect(flat.finalContour).toBe('flat')
    expect(flat.f0Mean).toBeCloseTo(160, -1)
    expect(flat.f0RangeSt).toBeLessThan(0.5)
    expect(flat.rateUnit).toBe('voiced')
    expect(flat.rate).toBeGreaterThan(0.8)
  })

  it('robust contour fit ignores a single outlier', () => {
    expect(contourOf([0, 0.1, 0.2, 0.3, 0.4], [0, 0, 12, 0, 0])).toBe('flat')
    expect(contourOf([0, 0.1, 0.2, 0.3], [0, 1, 2, 3])).toBe('rising')
    expect(contourOf([0], [0])).toBeNull()
  })
})

describe('word prosody', () => {
  const pcm = signal([gap(0.1), tone(0.3, 150), gap(0.05), tone(0.3, 220, 220, 0.9), gap(0.05), tone(0.4, 180, 120), gap(0.2)])
  const words = [
    { text: 'Welcome', start: 0.1, end: 0.4 },
    { text: 'back,', start: 0.45, end: 0.75 },
    { text: 'pioneer.', start: 0.8, end: 1.2 },
  ]

  it('measures pitch, pauses, contour and emphasis per word', () => {
    const p = analyzeProsody(pcm, RATE, words)
    expect(p.phrases).toHaveLength(1)
    const [a, b, c] = p.words
    expect(a.f0?.mean).toBeCloseTo(150, -1)
    expect(b.f0?.mean).toBeCloseTo(220, -1)
    expect(a.contour).toBe('flat')
    expect(c.contour).toBe('falling')
    expect(b.pauseBefore).toBeCloseTo(0.05, 5)
    expect(b.emphasis).toBe(true)
    expect(a.emphasis).toBe(false)
    expect(p.phrases[0].rateUnit).toBe('words/s')
    expect(p.phrases[0].rate).toBeCloseTo(3 / 1.1, 0)
    expect(p.phrases[0].finalContour).toBe('falling')
  })

  it('writes a compact transcript and a rounded view', () => {
    const p = analyzeProsody(pcm, RATE, words)
    const text = prosodyTranscript(p)
    expect(text).toMatch(/^0\.10 Welcome →15\dHz -\d+dB · 0\.45 \*back,\* →2[12]\dHz -\d+dB · 0\.80 pioneer\. ↘1\d\dHz -\d+dB \| falling, 2\.\d w\/s$/)
    const view = prosodyView(p) as { words: Record<string, unknown>[]; phrases: Record<string, unknown>[] }
    expect(view.words[1]).toMatchObject({ text: 'back,', start: 0.45, duration: 0.3, pauseBefore: 0.05, emphasis: true, phrase: 1 })
    expect(view.phrases[0]).toMatchObject({ start: expect.any(Number), words: 3, finalContour: 'falling' })
  })

  it('without word timings the transcript lists phrases only', () => {
    const p = analyzeProsody(signal([tone(0.5, 150), gap(0.3), tone(0.4, 200, 260)]), RATE)
    expect(prosodyTranscript(p)).toMatch(/^0\.0\d-0\.\d\d 15\dHz \d(\.\d)?st -\d+dB \| flat, voiced \d+% · \[pause 0\.\d\d\] · 0\.\d\d-1\.\d\d 2\d\dHz \d\.\dst -\d+dB \| rising, voiced \d+%$/)
  })

  it('caps words in the view and the transcript and says so', () => {
    const many = Array.from({ length: 90 }, (_, i) => ({ text: `w${i}`, start: i * 0.02, end: i * 0.02 + 0.015 }))
    const p = analyzeProsody(signal([tone(2, 150)]), RATE, many)
    const view = prosodyView(p) as { words: unknown[]; wordsTotal: number }
    expect(view.words).toHaveLength(WORDS_VIEW_MAX)
    expect(view.wordsTotal).toBe(90)
    expect(prosodyTranscript(p).endsWith('… truncated')).toBe(true)
  })

  it('drops words past the analysed audio and clamps a word that straddles its end', () => {
    const p = analyzeProsody(signal([gap(0.1), tone(0.8, 150), gap(0.1)]), RATE, [
      { text: 'inside', start: 0.1, end: 0.5 },
      { text: 'straddles', start: 0.6, end: 1.4 },
      { text: 'beyond', start: 1.0, end: 1.3 },
      { text: 'later', start: 2, end: 2.5 },
    ])
    expect(p.words.map((w) => [w.text, w.end])).toEqual([
      ['inside', 0.5],
      ['straddles', 1],
    ])
    expect(p.phrases[0].words).toBe(2)
    expect(p.truncated).toBeUndefined()
    expect(prosodyTranscript(p)).not.toContain('analysis stops')
    expect(prosodyView(p)).not.toHaveProperty('truncated')
  })

  it('flags audio cut at the analysis limit in the result, the view and the transcript', () => {
    const p = analyzeProsody(signal([gap(ANALYSIS_MAX_SECONDS - 0.6), tone(0.5, 150), gap(0.1)]), RATE, [
      { text: 'last', start: ANALYSIS_MAX_SECONDS - 0.6, end: ANALYSIS_MAX_SECONDS - 0.1 },
      { text: 'cut', start: ANALYSIS_MAX_SECONDS - 0.05, end: ANALYSIS_MAX_SECONDS + 0.4 },
      { text: 'unheard', start: ANALYSIS_MAX_SECONDS + 1, end: ANALYSIS_MAX_SECONDS + 1.5 },
    ])
    expect(p.truncated).toBe(true)
    expect(p.words.map((w) => w.text)).toEqual(['last', 'cut'])
    expect(p.words[1].end).toBe(ANALYSIS_MAX_SECONDS)
    expect(prosodyView(p)).toMatchObject({ truncated: true })
    expect(prosodyTranscript(p).endsWith(`[analysis stops at ${ANALYSIS_MAX_SECONDS.toFixed(2)}s]`)).toBe(true)
  })
})

describe('comparison with the original', () => {
  it('aligns phrases monotonically, merges a split phrase and leaves extras unmatched', () => {
    expect(alignPhrases([{ start: 0, end: 1 }, { start: 1.5, end: 2 }], [{ start: 0.1, end: 1.1 }, { start: 1.6, end: 2.1 }]).pairs).toEqual([
      { dub: [0, 0], original: [0, 0] },
      { dub: [1, 1], original: [1, 1] },
    ])
    expect(alignPhrases([{ start: 0, end: 0.5 }, { start: 0.7, end: 1.2 }], [{ start: 0, end: 1.2 }])).toEqual({
      pairs: [{ dub: [0, 1], original: [0, 0] }],
      extraDub: [],
      missingOriginal: [],
    })
    expect(alignPhrases([{ start: 0, end: 1 }, { start: 4, end: 6 }], [{ start: 0, end: 1 }])).toEqual({
      pairs: [{ dub: [0, 0], original: [0, 0] }],
      extraDub: [1],
      missingOriginal: [],
    })
    expect(alignPhrases([], [{ start: 0, end: 1 }]).missingOriginal).toEqual([0])
  })

  it('scores an identical delivery as a perfect match with no suggestions', () => {
    const p = analyzeProsody(signal([gap(0.1), tone(0.6, 140, 200), gap(0.3), tone(0.5, 200, 130)]), RATE)
    const c = compareProsody(p, p)
    expect(c.rhythm).toBe(1)
    expect(c.intonation).toBe(1)
    expect(c.pairs.every((pair) => pair.correlation !== null && pair.correlation > 0.99)).toBe(true)
    expect(c.suggestions).toEqual([])
  })

  it('names a longer dub, the pause to cut, a speed and a missed rising ending', () => {
    const original = analyzeProsody(signal([gap(0.1), tone(0.9, 140, 210), gap(0.2)]), RATE)
    const dubPcm = signal([gap(0.1), tone(0.4, 170), gap(0.12), tone(0.4, 170), gap(0.06), tone(0.3, 190, 130), gap(0.2)])
    const dub = analyzeProsody(dubPcm, RATE, [
      { text: 'Welcome', start: 0.1, end: 0.5 },
      { text: 'back', start: 0.62, end: 1.02 },
      { text: 'pioneer', start: 1.08, end: 1.38 },
    ])
    expect(dub.phrases).toHaveLength(1)
    const c = compareProsody(dub, original, 1)
    expect(c.speechDiff).toBeCloseTo(0.38, 1)
    expect(c.pairs[0].finalMatch).toBe(false)
    expect(c.suggestions[0]).toMatch(/^dub speech is 0\.3\d s longer than the original \(1\.2\d vs 0\.9\d s\): speed 1\.20 \(the speed limit; also shorten the text\)$/)
    expect(c.suggestions).toContain('original phrase ends rising (question-like), dub ends falling: regenerate with a questioning delivery')
    expect(c.intonation).toBeLessThan(0.7)
    const view = comparisonView(c) as { pairs: { dub: number; original: number }[] }
    expect(view.pairs[0]).toMatchObject({ dub: 1, original: 1 })
  })

  it('suggests removing the pause after a word when a phrase runs long', () => {
    const original = analyzeProsody(signal([gap(0.1), tone(0.8, 150), gap(0.4), tone(0.5, 150)]), RATE)
    const dub = analyzeProsody(signal([gap(0.1), tone(0.3, 150), gap(0.1), tone(0.6, 150), gap(0.4), tone(0.5, 150)]), RATE, [
      { text: 'one', start: 0.1, end: 0.4 },
      { text: 'two', start: 0.5, end: 1.1 },
      { text: 'three', start: 1.5, end: 2.0 },
    ])
    const c = compareProsody(dub, original, 1.1)
    expect(c.pairs.map((p) => [p.dub, p.original])).toEqual([[[0, 0], [0, 0]], [[1, 1], [1, 1]]])
    expect(c.suggestions.some((s) => /^phrase 1 is 0\.\d\d s longer: speed 1\.2\d?/.test(s))).toBe(true)
    expect(c.suggestions.some((s) => s.startsWith('phrase 2 starts 0.') && s.includes('late: move it'))).toBe(true)
  })
})
