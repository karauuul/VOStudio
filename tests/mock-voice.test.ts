import { describe, expect, it } from 'vitest'
import { sanitizeWords } from '../src/shared/domain'
import {
  MOCK_CHAR_LIMIT,
  MOCK_LEVEL,
  MOCK_SAMPLE_RATE,
  layoutWords,
  mockDuration,
  mockPitch,
  mockUsage,
  parseFfmetadata,
  synthesizeMock,
} from '../src/shared/mock-voice'

const LINE = 'Hello there, pioneer. Welcome back to the station!'

const bytes = (samples: Float32Array): Buffer => Buffer.from(samples.buffer)

const speech = (text: string, voiceId: string, speed = 1): Float32Array => {
  const duration = mockDuration(text, speed)
  return synthesizeMock(layoutWords(text, duration), duration, voiceId)
}

describe('mock voice duration', () => {
  it('grows with text length', () => {
    expect(mockDuration('a'.repeat(100), 1)).toBeCloseTo(6.5)
    expect(mockDuration('a'.repeat(200), 1)).toBeGreaterThan(mockDuration('a'.repeat(100), 1))
  })

  it('shrinks as speed rises', () => {
    expect(mockDuration(LINE, 1.2)).toBeLessThan(mockDuration(LINE, 1))
    expect(mockDuration(LINE, 0.7)).toBeGreaterThan(mockDuration(LINE, 1))
    expect(mockDuration('a'.repeat(100), 2)).toBeCloseTo(3.25)
  })

  it('clamps after applying speed', () => {
    expect(mockDuration('', 1)).toBe(0.4)
    expect(mockDuration('Hi', 1)).toBe(0.4)
    expect(mockDuration('a'.repeat(10), 4)).toBe(0.4)
    expect(mockDuration('a'.repeat(5000), 1)).toBe(60)
    expect(mockDuration('a'.repeat(900), 0.5)).toBe(60)
  })

  it('treats a non-positive or non-finite speed as normal speed', () => {
    for (const speed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(mockDuration(LINE, speed)).toBe(mockDuration(LINE, 1))
    }
  })
})

describe('mock voice word layout', () => {
  it('lays out every word in order without overlap inside the duration', () => {
    const duration = mockDuration(LINE, 1)
    const words = layoutWords(LINE, duration)
    expect(words.map((w) => w.text)).toEqual(LINE.split(' '))
    expect(words[0].start).toBeGreaterThan(0)
    expect(words[words.length - 1].end).toBeLessThan(duration)
    for (let i = 0; i < words.length; i++) {
      expect(words[i].end).toBeGreaterThan(words[i].start)
      if (i > 0) expect(words[i].start).toBeGreaterThan(words[i - 1].end)
    }
    expect(sanitizeWords(words)).toEqual(words)
  })

  it('leaves a longer pause after a sentence than between words', () => {
    const words = layoutWords('One two. Three', 3)
    const between = words[1].start - words[0].end
    const sentence = words[2].start - words[1].end
    expect(sentence).toBeGreaterThan(between * 3)
  })

  it('returns no words for empty text or zero duration', () => {
    expect(layoutWords('   ', 2)).toEqual([])
    expect(layoutWords('Hello', 0)).toEqual([])
  })
})

describe('mock voice synthesis', () => {
  it('is deterministic', () => {
    expect(bytes(speech(LINE, 'mock-alto')).equals(bytes(speech(LINE, 'mock-alto')))).toBe(true)
  })

  it('sounds different per voice', () => {
    expect(mockPitch('mock-alto')).not.toBe(mockPitch('mock-bass'))
    expect(mockPitch('mock-bass')).not.toBe(mockPitch('mock-tenor'))
    expect(bytes(speech(LINE, 'mock-alto')).equals(bytes(speech(LINE, 'mock-bass')))).toBe(false)
    for (const id of ['mock-alto', 'mock-bass', 'mock-tenor', 'x']) {
      expect(mockPitch(id)).toBeGreaterThanOrEqual(95)
      expect(mockPitch(id)).toBeLessThan(255)
    }
  })

  it('fills the planned duration with bursts on words and silence between them', () => {
    const duration = mockDuration(LINE, 1)
    const words = layoutWords(LINE, duration)
    const samples = synthesizeMock(words, duration, 'mock-tenor')
    expect(samples.length).toBe(Math.round(duration * MOCK_SAMPLE_RATE))
    const peak = samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0)
    expect(peak).toBeGreaterThan(MOCK_LEVEL / 2)
    expect(peak).toBeLessThanOrEqual(MOCK_LEVEL)
    const gap = Math.round(((words[0].end + words[1].start) / 2) * MOCK_SAMPLE_RATE)
    expect(samples[gap]).toBe(0)
    expect(samples[0]).toBe(0)
    const mid = Math.round(((words[0].start + words[0].end) / 2) * MOCK_SAMPLE_RATE)
    const burst = samples.subarray(mid - 200, mid + 200).reduce((max, v) => Math.max(max, Math.abs(v)), 0)
    expect(burst).toBeGreaterThan(0.05)
  })

  it('renders silence for empty text', () => {
    const samples = speech('', 'mock-alto')
    expect(samples.length).toBe(Math.round(0.4 * MOCK_SAMPLE_RATE))
    expect(samples.every((v) => v === 0)).toBe(true)
  })
})

describe('ffmetadata parsing', () => {
  it('reads escaped values and continuation lines', () => {
    const text = ';FFMETADATA1\ncomment=Hello\\; world\\=x \\#1 \\\\ back\\\nnewline\nencoder=Lavf61.1.100\n'
    expect(parseFfmetadata(text)).toEqual({
      comment: 'Hello; world=x #1 \\ back\nnewline',
      encoder: 'Lavf61.1.100',
    })
  })

  it('skips comment lines and stops at the first section', () => {
    const text = ';FFMETADATA1\n#note=x\ntitle=Take\n[STREAM]\ntitle=Other\n'
    expect(parseFfmetadata(text)).toEqual({ title: 'Take' })
  })

  it('keeps unicode values', () => {
    expect(parseFfmetadata(';FFMETADATA1\nvostudio_mock_text=Привіт, world\n')).toEqual({
      vostudio_mock_text: 'Привіт, world',
    })
  })
})

describe('mock usage', () => {
  it('reports characters against a fixed limit', () => {
    expect(mockUsage(0)).toEqual({ used: 0, limit: MOCK_CHAR_LIMIT, remaining: MOCK_CHAR_LIMIT, unit: 'chars' })
    expect(mockUsage(120)).toEqual({ used: 120, limit: 1_000_000, remaining: 999_880, unit: 'chars' })
  })
})
