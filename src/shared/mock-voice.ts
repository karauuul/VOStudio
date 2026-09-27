import type { UsageInfo, WordTiming } from './domain'

export const MOCK_SAMPLE_RATE = 44100
export const MOCK_TEXT_TAG = 'vostudio_mock_text'
export const MOCK_CHAR_LIMIT = 1_000_000
export const MOCK_LEVEL = 0.5

const SECONDS_PER_CHAR = 0.065
const MIN_SECONDS = 0.4
const MAX_SECONDS = 60
const EDGE_UNITS = 1
const SENTENCE_END = /[.!?…]$/
const CLAUSE_END = /[,;:]$/
const HARMONICS = [1, 1 / 2, 1 / 3, 1 / 4]
const HARMONIC_SUM = HARMONICS.reduce((sum, a) => sum + a, 0)
const VIBRATO_HZ = 5.5
const VIBRATO_DEPTH = 0.02
const SYLLABLE_HZ = 4.5
const RAMP_SECONDS = 0.015
const DECLINATION = 0.08
const TWO_PI = 2 * Math.PI

const speedOf = (speed: number): number => (Number.isFinite(speed) && speed > 0 ? speed : 1)

export const mockDuration = (text: string, speed: number): number =>
  Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, (text.trim().length * SECONDS_PER_CHAR) / speedOf(speed)))

const pauseUnits = (word: string): number => (SENTENCE_END.test(word) ? 4 : CLAUSE_END.test(word) ? 2 : 1)

export function layoutWords(text: string, duration: number): WordTiming[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || !(duration > 0)) return []
  const gaps = tokens.map((word, i) => (i < tokens.length - 1 ? pauseUnits(word) : EDGE_UNITS))
  const total = EDGE_UNITS + tokens.reduce((sum, word, i) => sum + word.length + gaps[i], 0)
  const unit = duration / total
  let at = EDGE_UNITS * unit
  return tokens.map((word, i) => {
    const start = at
    const end = start + word.length * unit
    at = end + gaps[i] * unit
    return { text: word, start, end }
  })
}

export function mockPitch(voiceId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < voiceId.length; i++) hash = Math.imul(hash ^ voiceId.charCodeAt(i), 0x01000193) >>> 0
  return 95 + (hash % 1000) * 0.16
}

export function synthesizeMock(words: WordTiming[], duration: number, voiceId: string): Float32Array {
  const out = new Float32Array(Math.round(duration * MOCK_SAMPLE_RATE))
  const base = mockPitch(voiceId)
  const ramp = RAMP_SECONDS * MOCK_SAMPLE_RATE
  words.forEach((word, index) => {
    const from = Math.round(word.start * MOCK_SAMPLE_RATE)
    const length = Math.min(out.length, Math.round(word.end * MOCK_SAMPLE_RATE)) - from
    const pitch = base * (1 + 0.06 * Math.sin(index * 1.7))
    let phase = 0
    for (let i = 0; i < length; i++) {
      const t = i / MOCK_SAMPLE_RATE
      const vibrato = 1 + VIBRATO_DEPTH * Math.sin(TWO_PI * VIBRATO_HZ * t)
      phase += (TWO_PI * pitch * vibrato * (1 - (DECLINATION * i) / length)) / MOCK_SAMPLE_RATE
      let voiced = 0
      for (let k = 0; k < HARMONICS.length; k++) voiced += HARMONICS[k] * Math.sin((k + 1) * phase)
      const edge = Math.min(1, i / ramp, (length - 1 - i) / ramp)
      const syllable = 0.7 + 0.3 * Math.cos(TWO_PI * SYLLABLE_HZ * t)
      out[from + i] = (MOCK_LEVEL * edge * syllable * voiced) / HARMONIC_SUM
    }
  })
  return out
}

export function parseFfmetadata(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let key = ''
  let value = ''
  let inValue = false
  let lineStart = true
  let skip = false
  const push = (ch: string): void => {
    if (skip) return
    if (inValue) value += ch
    else key += ch
  }
  const commit = (): void => {
    if (!skip && inValue) out[key] = value
    key = ''
    value = ''
    inValue = false
    lineStart = true
    skip = false
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      push(text[++i])
      lineStart = false
      continue
    }
    if (ch === '\n') {
      commit()
      continue
    }
    if (lineStart && ch === '[') break
    if (lineStart && (ch === ';' || ch === '#')) skip = true
    lineStart = false
    if (!inValue && ch === '=') inValue = true
    else push(ch)
  }
  commit()
  return out
}

export const mockUsage = (used: number): UsageInfo => ({
  used,
  limit: MOCK_CHAR_LIMIT,
  remaining: MOCK_CHAR_LIMIT - used,
  unit: 'chars',
})
