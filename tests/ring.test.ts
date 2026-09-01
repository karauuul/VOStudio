import { describe, expect, it } from 'vitest'
import {
  createRing,
  createRingForRate,
  ringFirstFrame,
  ringLength,
  ringSlice,
  ringWrite,
  sliceTake,
  takeWindow,
  MAX_GAP_SECONDS,
  PREROLL_SECONDS,
  RING_SECONDS,
} from '../src/renderer/audio/ring'

function ramp(at: number, len: number): Float32Array {
  const a = new Float32Array(len)
  for (let i = 0; i < len; i++) a[i] = at + i
  return a
}

const asArray = (a: Float32Array): number[] => Array.from(a)

describe('ring: basic write and slice', () => {
  it('empty ring returns nothing', () => {
    const r = createRing(16)
    expect(ringLength(r)).toBe(0)
    expect(ringFirstFrame(r)).toBe(-1)
    expect(asArray(ringSlice(r, 0, 10))).toEqual([])
  })

  it('first chunk sets the base — absolute frames, not array indexes', () => {
    const r = createRing(16)
    ringWrite(r, ramp(1000, 4), 1000)
    expect(ringFirstFrame(r)).toBe(1000)
    expect(r.end).toBe(1004)
    expect(asArray(ringSlice(r, 1000, 1004))).toEqual([1000, 1001, 1002, 1003])
  })

  it('slice is clamped to the available window on both sides', () => {
    const r = createRing(16)
    ringWrite(r, ramp(100, 4), 100)
    expect(asArray(ringSlice(r, 90, 200))).toEqual([100, 101, 102, 103])
    expect(asArray(ringSlice(r, 0, 50))).toEqual([])
    expect(asArray(ringSlice(r, 500, 600))).toEqual([])
    expect(asArray(ringSlice(r, 102, 102))).toEqual([])
  })

  it('consecutive chunks join with no seams', () => {
    const r = createRing(64)
    ringWrite(r, ramp(0, 5), 0)
    ringWrite(r, ramp(5, 5), 5)
    ringWrite(r, ramp(10, 5), 10)
    expect(asArray(ringSlice(r, 0, 15))).toEqual(asArray(ramp(0, 15)))
    expect(ringLength(r)).toBe(15)
  })
})

describe('ring: wrap-around', () => {
  it('a slice across the array boundary reads as one piece', () => {
    const r = createRing(10)
    ringWrite(r, ramp(0, 6), 0)
    ringWrite(r, ramp(6, 8), 6)
    expect(r.end).toBe(14)
    expect(ringFirstFrame(r)).toBe(4)
    expect(ringLength(r)).toBe(10)
    expect(asArray(ringSlice(r, 4, 14))).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(asArray(ringSlice(r, 0, 14))).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  })

  it('survives many wraps in a row', () => {
    const r = createRing(8)
    for (let i = 0; i < 100; i++) ringWrite(r, ramp(i * 3, 3), i * 3)
    expect(r.end).toBe(300)
    expect(ringFirstFrame(r)).toBe(292)
    expect(asArray(ringSlice(r, 292, 300))).toEqual([292, 293, 294, 295, 296, 297, 298, 299])
  })

  it('a chunk longer than the ring itself keeps only the last wrap', () => {
    const r = createRing(4)
    ringWrite(r, ramp(0, 10), 0)
    expect(r.end).toBe(10)
    expect(asArray(ringSlice(r, 6, 10))).toEqual([6, 7, 8, 9])
  })
})

describe('ring: stream gaps', () => {
  it('a small gap is filled with silence — marks do not drift', () => {
    const r = createRing(64)
    ringWrite(r, ramp(0, 4), 0)
    const healed = ringWrite(r, ramp(8, 4), 8, 16)
    expect(healed).toBe(true)
    expect(asArray(ringSlice(r, 0, 12))).toEqual([0, 1, 2, 3, 0, 0, 0, 0, 8, 9, 10, 11])
    expect(asArray(ringSlice(r, 8, 9))).toEqual([8])
  })

  it('an oversized gap re-bases the ring instead of filling with zeros', () => {
    const r = createRing(64)
    ringWrite(r, ramp(0, 4), 0)
    ringWrite(r, ramp(10_000, 4), 10_000, 16)
    expect(ringFirstFrame(r)).toBe(10_000)
    expect(ringLength(r)).toBe(4)
    expect(asArray(ringSlice(r, 0, 10_004))).toEqual([10_000, 10_001, 10_002, 10_003])
  })

  it('a chunk from the past does not overwrite what is already written', () => {
    const r = createRing(64)
    ringWrite(r, ramp(0, 8), 0)
    ringWrite(r, ramp(6, 4), 6)
    expect(r.end).toBe(10)
    expect(asArray(ringSlice(r, 0, 10))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    ringWrite(r, ramp(0, 4), 0)
    expect(r.end).toBe(10)
  })
})

describe('ring: take marks and preroll', () => {
  it('preroll adds audio BEFORE the start mark', () => {
    const r = createRing(1000)
    ringWrite(r, ramp(0, 500), 0)
    const pcm = sliceTake(r, { start: 100, stop: 200 }, 10)
    expect(pcm.length).toBe(110)
    expect(pcm[0]).toBe(90)
    expect(pcm[pcm.length - 1]).toBe(199)
  })

  it('preroll is clamped when recording starts right after warm-up', () => {
    const r = createRing(1000)
    ringWrite(r, ramp(100, 50), 100)
    const w = takeWindow(r, { start: 120, stop: 150 }, 1000)
    expect(w.from).toBe(100)
    expect(w.to).toBe(150)
    expect(asArray(sliceTake(r, { start: 120, stop: 150 }, 1000))[0]).toBe(100)
  })

  it('the stop mark cannot run ahead of what was actually captured', () => {
    const r = createRing(1000)
    ringWrite(r, ramp(0, 100), 0)
    const w = takeWindow(r, { start: 10, stop: 999 }, 0)
    expect(w).toEqual({ from: 10, to: 100 })
  })

  it('the evicted start of a long take is cut off, not read as garbage', () => {
    const r = createRing(100)
    ringWrite(r, ramp(0, 500), 0)
    const w = takeWindow(r, { start: 0, stop: 500 }, 10)
    expect(w.from).toBe(400)
    expect(w.to).toBe(500)
    expect(sliceTake(r, { start: 0, stop: 500 }, 10).length).toBe(100)
  })

  it('a zero-length take does not crash and does not return a negative length', () => {
    const r = createRing(100)
    ringWrite(r, ramp(0, 50), 0)
    expect(sliceTake(r, { start: 40, stop: 30 }, 0).length).toBe(0)
    expect(takeWindow(r, { start: 40, stop: 30 }, 0).to).toBe(40)
    expect(sliceTake(createRing(10), { start: 0, stop: 5 }, 0).length).toBe(0)
  })

  it('zero preroll = exactly from the mark', () => {
    const r = createRing(1000)
    ringWrite(r, ramp(0, 500), 0)
    expect(sliceTake(r, { start: 100, stop: 110 }, 0)[0]).toBe(100)
  })
})

describe('ring: sizes for a real stream', () => {
  it('a 6.5 min ring holds the full STS limit with room to spare', () => {
    const r = createRingForRate(48_000)
    expect(RING_SECONDS).toBeGreaterThan(300)
    expect(r.capacity).toBe(Math.ceil(RING_SECONDS * 48_000))
    expect(r.capacity).toBeGreaterThan((300 + PREROLL_SECONDS) * 48_000)
  })

  it('warm-up constants stay within sane bounds', () => {
    expect(PREROLL_SECONDS).toBeGreaterThan(0)
    expect(PREROLL_SECONDS).toBeLessThan(1)
    expect(MAX_GAP_SECONDS).toBeGreaterThan(0)
  })

  it('full cycle: warm-up → mark → stop returns exactly what was said', () => {
    const rate = 8000
    const r = createRingForRate(rate, 10)
    let frame = 0
    const push = (n: number): void => {
      ringWrite(r, ramp(frame, n), frame, MAX_GAP_SECONDS * rate)
      frame += n
    }
    push(4096)
    const start = frame
    push(4096 * 4)
    const stop = frame
    push(1024)
    const pcm = sliceTake(r, { start, stop }, PREROLL_SECONDS * rate)
    expect(pcm.length).toBe(4096 * 4 + PREROLL_SECONDS * rate)
    expect(pcm[0]).toBe(start - PREROLL_SECONDS * rate)
    expect(pcm[pcm.length - 1]).toBe(stop - 1)
  })
})
