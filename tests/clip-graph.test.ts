import { describe, expect, it } from 'vitest'
import {
  dbToGain,
  envelopeDbAt,
  fadeCurve,
  fadeInWindow,
  fadeOutWindow,
  fadeValue,
  renderDuration,
  stretchRate,
  trimmedDuration,
} from '../src/renderer/audio/clip-graph'
import { emptyEdits, type ClipEdits } from '../src/shared/domain'

const edits = (over: Partial<ClipEdits> = {}): ClipEdits => ({ ...emptyEdits(), ...over })

describe('emptyEdits — the graph must degenerate into a no-op', () => {
  const e = emptyEdits()

  it('rate 1, duration = buffer duration', () => {
    expect(stretchRate(e)).toBe(1)
    expect(trimmedDuration(10, e)).toBe(10)
    expect(renderDuration(10, e)).toBe(10)
  })

  it('gain 0 dB = factor 1', () => {
    expect(dbToGain(e.gainDb)).toBe(1)
  })

  it('no automation windows at all', () => {
    expect(fadeInWindow(e.fadeIn.duration, 0)).toBeNull()
    expect(fadeOutWindow(e.fadeOut.duration, 10, 0)).toBeNull()
  })

  it('offset equals seek — live playback does not shift', () => {
    const seek = 3.25
    expect(Math.max(0, e.trimStart) + seek * stretchRate(e)).toBe(seek)
  })
})

describe('durations', () => {
  it('trims are subtracted from both sides', () => {
    expect(trimmedDuration(10, edits({ trimStart: 1, trimEnd: 2 }))).toBe(7)
  })

  it('negative trims are ignored, not added to the length', () => {
    expect(trimmedDuration(10, edits({ trimStart: -5, trimEnd: -5 }))).toBe(10)
  })

  it('timeStretch changes the REAL duration, not the buffer length', () => {
    const e = edits({ timeStretch: 2 })
    expect(trimmedDuration(10, e)).toBe(10)
    expect(renderDuration(10, e)).toBe(5)
    expect(renderDuration(10, edits({ timeStretch: 0.5 }))).toBe(20)
  })

  it('trims and stretch are counted together', () => {
    expect(renderDuration(10, edits({ trimStart: 2, trimEnd: 2, timeStretch: 2 }))).toBe(3)
  })

  it('broken timeStretch = 1, not NaN in playbackRate', () => {
    expect(stretchRate(edits({ timeStretch: 0 }))).toBe(1)
    expect(stretchRate(edits({ timeStretch: -1 }))).toBe(1)
    expect(stretchRate(edits({ timeStretch: NaN }))).toBe(1)
  })

  it('trims larger than the clip give a NON-positive duration — a signal to fail', () => {
    expect(renderDuration(1, edits({ trimStart: 0.6, trimEnd: 0.6 }))).toBeLessThan(0)
    expect(renderDuration(1, edits({ trimStart: 1 }))).toBe(0)
  })
})

describe('dbToGain', () => {
  it('0 dB = 1, −6 dB ≈ 0.5, +6 dB ≈ 2', () => {
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(-6.0206)).toBeCloseTo(0.5, 4)
    expect(dbToGain(6.0206)).toBeCloseTo(2, 4)
  })

  it('−inf-like values do not break the multiplication', () => {
    expect(dbToGain(-120)).toBeGreaterThan(0)
    expect(dbToGain(-120)).toBeLessThan(1e-5)
  })
})

describe('fade profiles', () => {
  it('all shapes go 0 → 1 and are monotonic', () => {
    for (const shape of ['linear', 'equalPower', 'sCurve'] as const) {
      expect(fadeValue(shape, 0)).toBeCloseTo(0, 6)
      expect(fadeValue(shape, 1)).toBeCloseTo(1, 6)
      let prev = -1
      for (let i = 0; i <= 20; i++) {
        const v = fadeValue(shape, i / 20)
        expect(v).toBeGreaterThanOrEqual(prev)
        prev = v
      }
    }
  })

  it('equalPower holds power at the midpoint (−3 dB, not −6)', () => {
    expect(fadeValue('equalPower', 0.5)).toBeCloseTo(Math.SQRT1_2, 6)
    expect(fadeValue('linear', 0.5)).toBeCloseTo(0.5, 6)
    expect(fadeValue('sCurve', 0.5)).toBeCloseTo(0.5, 6)
  })

  it('progress outside [0,1] is clamped', () => {
    expect(fadeValue('linear', -1)).toBe(0)
    expect(fadeValue('linear', 2)).toBe(1)
  })
})

describe('fadeCurve — curve layout', () => {
  it('a rising curve starts at 0 and ends at 1', () => {
    const c = fadeCurve('linear', 0, 1, 16)
    expect(c).toHaveLength(16)
    expect(c[0]).toBeCloseTo(0, 6)
    expect(c[15]).toBeCloseTo(1, 6)
  })

  it('a falling curve is mirrored', () => {
    const c = fadeCurve('linear', 0, 1, 16, true)
    expect(c[0]).toBeCloseTo(1, 6)
    expect(c[15]).toBeCloseTo(0, 6)
  })

  it('a partial segment starts at the right value', () => {
    const c = fadeCurve('linear', 0.5, 1, 8)
    expect(c[0]).toBeCloseTo(0.5, 6)
    expect(c[7]).toBeCloseTo(1, 6)
  })

  it('at least two points — setValueCurveAtTime accepts no fewer', () => {
    expect(fadeCurve('linear', 0, 1, 1).length).toBe(2)
  })
})

describe('fade windows with seek', () => {
  it('fade-in from zero — the full window', () => {
    expect(fadeInWindow(2, 0)).toEqual({ at: 0, duration: 2, from: 0, to: 1 })
  })

  it('seek into the fade-in picks it up from the middle', () => {
    expect(fadeInWindow(2, 0.5)).toEqual({ at: 0, duration: 1.5, from: 0.25, to: 1 })
  })

  it('seek past the fade-in — no window', () => {
    expect(fadeInWindow(2, 2)).toBeNull()
    expect(fadeInWindow(2, 5)).toBeNull()
    expect(fadeInWindow(0, 0)).toBeNull()
  })

  it('fade-out is scheduled right at the end of the clip', () => {
    expect(fadeOutWindow(2, 10, 0)).toEqual({ at: 8, duration: 2, from: 0, to: 1 })
  })

  it('seek before the fade-out only shifts the start moment', () => {
    expect(fadeOutWindow(2, 10, 3)).toEqual({ at: 5, duration: 2, from: 0, to: 1 })
  })

  it('seek into the fade-out picks it up from the middle', () => {
    expect(fadeOutWindow(2, 10, 9)).toEqual({ at: 0, duration: 1, from: 0.5, to: 1 })
  })

  it('a fade-out longer than the clip is cut down to the clip', () => {
    expect(fadeOutWindow(20, 5, 0)).toEqual({ at: 0, duration: 5, from: 0, to: 1 })
  })

  it('seek to the very end — no window', () => {
    expect(fadeOutWindow(2, 10, 10)).toBeNull()
  })
})

describe('gainEnvelope', () => {
  const pts = [
    { t: 0, db: 0 },
    { t: 2, db: -6 },
    { t: 4, db: 0 },
  ]

  it('exact points return their own value', () => {
    expect(envelopeDbAt(pts, 0)).toBe(0)
    expect(envelopeDbAt(pts, 2)).toBe(-6)
    expect(envelopeDbAt(pts, 4)).toBe(0)
  })

  it('between points — linear interpolation', () => {
    expect(envelopeDbAt(pts, 1)).toBeCloseTo(-3, 6)
    expect(envelopeDbAt(pts, 3)).toBeCloseTo(-3, 6)
  })

  it('past the edges — a plateau, not extrapolation', () => {
    expect(envelopeDbAt(pts, -5)).toBe(0)
    expect(envelopeDbAt(pts, 100)).toBe(0)
  })

  it('an empty envelope — 0 dB', () => {
    expect(envelopeDbAt([], 1)).toBe(0)
  })
})
