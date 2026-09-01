import { describe, expect, it } from 'vitest'
import {
  concatFloat32,
  encodeWav,
  encodeWavFloat32,
  floatToPcm16,
  interleave,
  pcmDuration,
  WAV_HEADER_BYTES,
} from '../src/renderer/audio/wav'
import {
  emptyEdits,
  estimateStsCredits,
  hasVoicedTake,
  MAX_STS_SECONDS,
  type Cue,
  type Take,
  type TakeKind,
} from '../src/shared/domain'

const ascii = (v: DataView, off: number, len: number): string =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(v.getUint8(off + i))).join('')

describe('encodeWav — header', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1])
  const buf = encodeWav(samples, 48000)
  const v = new DataView(buf)

  it('RIFF/WAVE magic in place', () => {
    expect(ascii(v, 0, 4)).toBe('RIFF')
    expect(ascii(v, 8, 4)).toBe('WAVE')
    expect(ascii(v, 12, 4)).toBe('fmt ')
    expect(ascii(v, 36, 4)).toBe('data')
  })

  it('fmt chunk: PCM, mono, 16-bit', () => {
    expect(v.getUint32(16, true)).toBe(16)
    expect(v.getUint16(20, true)).toBe(1)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint16(34, true)).toBe(16)
    expect(v.getUint16(32, true)).toBe(2)
  })

  it('sampleRate is written as is — no resampling at all', () => {
    for (const sr of [8000, 16000, 44100, 48000, 96000]) {
      const b = new DataView(encodeWav(new Float32Array(4), sr))
      expect(b.getUint32(24, true)).toBe(sr)
      expect(b.getUint32(28, true)).toBe(sr * 2)
    }
  })

  it('sizes match the buffer length', () => {
    expect(buf.byteLength).toBe(WAV_HEADER_BYTES + samples.length * 2)
    expect(v.getUint32(4, true)).toBe(buf.byteLength - 8)
    expect(v.getUint32(40, true)).toBe(samples.length * 2)
  })

  it('an empty recording — a valid header with no data', () => {
    const empty = encodeWav(new Float32Array(0), 44100)
    expect(empty.byteLength).toBe(WAV_HEADER_BYTES)
    expect(new DataView(empty).getUint32(40, true)).toBe(0)
  })

  it('a zero sampleRate — an error, not a broken file', () => {
    expect(() => encodeWav(new Float32Array(1), 0)).toThrow()
  })
})

describe('encodeWav — samples', () => {
  it('float → int16 little-endian in the right order', () => {
    const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 44100)
    const v = new DataView(buf)
    const at = (i: number): number => v.getInt16(WAV_HEADER_BYTES + i * 2, true)
    expect(at(0)).toBe(0)
    expect(at(1)).toBe(16384)
    expect(at(2)).toBe(-16384)
    expect(at(3)).toBe(32767)
    expect(at(4)).toBe(-32768)
  })

  it('anything outside −1..1 is clamped, not wrapped', () => {
    expect(floatToPcm16(2)).toBe(32767)
    expect(floatToPcm16(-2)).toBe(-32768)
    expect(floatToPcm16(NaN)).toBe(0)
  })
})

describe('interleave', () => {
  it('stereo is interleaved L,R,L,R', () => {
    const out = interleave([new Float32Array([1, 3]), new Float32Array([2, 4])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4])
  })

  it('mono is returned as is, without a copy', () => {
    const mono = new Float32Array([1, 2, 3])
    expect(interleave([mono])).toBe(mono)
  })

  it('channels of different lengths — an error, not silence at the end', () => {
    expect(() => interleave([new Float32Array(2), new Float32Array(3)])).toThrow()
  })

  it('zero channels — empty', () => {
    expect(interleave([]).length).toBe(0)
  })
})

describe('encodeWavFloat32 — export intermediate', () => {
  const l = new Float32Array([0, 0.5, -0.5])
  const r = new Float32Array([1, -1, 0.25])
  const buf = encodeWavFloat32([l, r], 48000)
  const v = new DataView(buf)

  it('the fmt chunk declares IEEE float 32-bit', () => {
    expect(ascii(v, 0, 4)).toBe('RIFF')
    expect(ascii(v, 8, 4)).toBe('WAVE')
    expect(v.getUint16(20, true)).toBe(3)
    expect(v.getUint16(34, true)).toBe(32)
  })

  it('channels and block alignment', () => {
    expect(v.getUint16(22, true)).toBe(2)
    expect(v.getUint16(32, true)).toBe(8)
    expect(v.getUint32(28, true)).toBe(48000 * 8)
  })

  it('sizes match', () => {
    expect(buf.byteLength).toBe(WAV_HEADER_BYTES + 6 * 4)
    expect(v.getUint32(4, true)).toBe(buf.byteLength - 8)
    expect(v.getUint32(40, true)).toBe(6 * 4)
  })

  it('samples land interleaved and WITHOUT quantization', () => {
    const at = (i: number): number => v.getFloat32(WAV_HEADER_BYTES + i * 4, true)
    expect(at(0)).toBe(0)
    expect(at(1)).toBe(1)
    expect(at(2)).toBe(0.5)
    expect(at(3)).toBe(-1)
    expect(at(4)).toBe(-0.5)
    expect(at(5)).toBe(0.25)
  })

  it('a ±1 peak is not clamped and does not overflow', () => {
    const b = new DataView(encodeWavFloat32([new Float32Array([1, -1])], 44100))
    expect(b.getFloat32(WAV_HEADER_BYTES, true)).toBe(1)
    expect(b.getFloat32(WAV_HEADER_BYTES + 4, true)).toBe(-1)
  })

  it('sampleRate is written as is', () => {
    for (const sr of [22050, 44100, 48000, 96000]) {
      const b = new DataView(encodeWavFloat32([new Float32Array(2)], sr))
      expect(b.getUint32(24, true)).toBe(sr)
    }
  })

  it('a broken sampleRate and zero channels — an error', () => {
    expect(() => encodeWavFloat32([new Float32Array(1)], 0)).toThrow()
    expect(() => encodeWavFloat32([], 48000)).toThrow()
  })
})

describe('concatFloat32 / pcmDuration', () => {
  it('chunks are joined in the right order', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])])
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it('an empty list = an empty buffer', () => {
    expect(concatFloat32([]).length).toBe(0)
  })

  it('duration is computed from the native sample rate', () => {
    expect(pcmDuration(48000, 48000)).toBe(1)
    expect(pcmDuration(22050, 44100)).toBe(0.5)
    expect(pcmDuration(10, 0)).toBe(0)
  })
})

describe('STS cost', () => {
  it('~1000 credits per minute, rounded up', () => {
    expect(estimateStsCredits(60)).toBe(1000)
    expect(estimateStsCredits(30)).toBe(500)
    expect(estimateStsCredits(0.1)).toBe(2)
    expect(estimateStsCredits(0)).toBe(0)
  })

  it('the request limit — 5 minutes', () => {
    expect(MAX_STS_SECONDS).toBe(300)
  })
})

describe('hasVoicedTake', () => {
  const take = (kind: TakeKind): Take => ({
    id: kind,
    kind,
    createdAt: '2026-01-01T00:00:00.000Z',
    file: { fileId: 'f', relPath: 'f', format: kind === 'recording' ? 'wav' : 'mp3' },
    duration: 1,
    meta: {},
    edits: emptyEdits(),
  })
  const cue = (kinds: TakeKind[]): Cue =>
    ({ takes: kinds.map(take) }) as unknown as Cue

  it('a raw recording does NOT make a cue voiced', () => {
    expect(hasVoicedTake(cue(['recording']))).toBe(false)
    expect(hasVoicedTake(cue([]))).toBe(false)
  })

  it('sts / tts / imported — does', () => {
    expect(hasVoicedTake(cue(['recording', 'sts']))).toBe(true)
    expect(hasVoicedTake(cue(['tts']))).toBe(true)
    expect(hasVoicedTake(cue(['imported']))).toBe(true)
  })
})
