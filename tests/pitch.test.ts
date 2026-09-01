import { describe, expect, it } from 'vitest'
import {
  GRAIN_SECONDS,
  PitchShifterCore,
  grainSamples,
  hann,
  hannPair,
  phaseStep,
  pitchRatio,
  tapDelay,
  wrap01,
} from '@shared/pitch'
import {
  DEFAULT_PITCH,
  PITCH_SEMITONES_MAX,
  PITCH_SEMITONES_MIN,
  PITCH_STEP,
  effectsTail,
  hasEffects,
  hasSends,
  pitchActive,
  sanitizeEffects,
  sanitizePitch,
  toggleEffect,
  type ClipEffects,
} from '@shared/effects'
import { compHasPitch, setClipEdits } from '@shared/comp'
import { emptyEdits, type CompClip, type CueComp } from '@shared/domain'
import { clipEffectsSchema } from '../src/main/schemas'

describe('pitchRatio', () => {
  it('0 semitones — exactly one, no floating-point garbage', () => {
    expect(pitchRatio(0)).toBe(1)
  })

  it('±12 semitones — exactly double and exactly half', () => {
    expect(pitchRatio(PITCH_SEMITONES_MAX)).toBeCloseTo(2, 12)
    expect(pitchRatio(PITCH_SEMITONES_MIN)).toBeCloseTo(0.5, 12)
  })

  it('a semitone is the 12th root of two, and twelve of them make an octave', () => {
    expect(pitchRatio(1)).toBeCloseTo(Math.pow(2, 1 / 12), 12)
    expect(Math.pow(pitchRatio(1), 12)).toBeCloseTo(2, 10)
  })

  it('garbage in the argument — ratio 1, not NaN in the phase step', () => {
    expect(pitchRatio(Number.NaN)).toBe(1)
    expect(pitchRatio(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('grain', () => {
  it('the length is TIME, so in samples it follows the sample rate', () => {
    expect(grainSamples(48000)).toBe(Math.round(GRAIN_SECONDS * 48000))
    expect(grainSamples(44100)).toBe(Math.round(GRAIN_SECONDS * 44100))
    expect(grainSamples(48000)).toBeGreaterThan(grainSamples(44100))
  })

  it('a broken sampleRate does not make a zero-length grain (division by zero in the step)', () => {
    expect(grainSamples(0)).toBeGreaterThan(0)
    expect(grainSamples(Number.NaN)).toBeGreaterThan(0)
  })

  it('the phase step is negative going up and positive going down — the cursor catches up or falls behind', () => {
    const g = grainSamples(48000)
    expect(phaseStep(pitchRatio(12), g)).toBeLessThan(0)
    expect(phaseStep(pitchRatio(-12), g)).toBeGreaterThan(0)
    expect(phaseStep(pitchRatio(0), g)).toBe(0)
  })

  it('one full phase turn makes the cursor consume exactly one grain', () => {
    const g = grainSamples(48000)
    const st = Math.abs(phaseStep(pitchRatio(12), g))
    expect(st * g).toBeCloseTo(1, 12)
  })

  it('the cursor moves at exactly the ratio speed — for any semitones', () => {
    const g = grainSamples(48000)
    for (const st of [-12, -7, -0.5, 0, 0.5, 3, 7, 12]) {
      const ratio = pitchRatio(st)
      const step = phaseStep(ratio, g)
      let phase = 0.5
      const rp0 = 0 - tapDelay(phase, g)
      phase = wrap01(phase + step)
      const rp1 = 1 - tapDelay(phase, g)
      expect(rp1 - rp0).toBeCloseTo(ratio, 10)
    }
  })
})

describe('Hann windows with 50 % overlap', () => {
  it('the sum of two windows is IDENTICALLY one — loudness does not breathe at the seams', () => {
    for (let i = 0; i <= 1000; i++) {
      expect(hannPair(i / 1000)).toBeCloseTo(1, 12)
    }
  })

  it('at the grain edges the window is exactly 0, in the middle exactly 1', () => {
    expect(hann(0)).toBeCloseTo(0, 12)
    expect(hann(1)).toBeCloseTo(0, 12)
    expect(hann(0.5)).toBeCloseTo(1, 12)
  })

  it('the phase must never go negative — otherwise the ring index drifts', () => {
    expect(wrap01(-0.25)).toBeCloseTo(0.75, 12)
    expect(wrap01(1.25)).toBeCloseTo(0.25, 12)
    expect(wrap01(1)).toBe(0)
    expect(wrap01(-1)).toBe(0)
  })

  it('the cursor delay stays within one grain — the ring is twice its size', () => {
    const g = grainSamples(48000)
    for (let i = 0; i < 1000; i++) {
      const d = tapDelay(i / 1000, g)
      expect(d).toBeGreaterThanOrEqual(1)
      expect(d).toBeLessThan(g + 2)
    }
  })
})

const SR = 48000

function tone(n: number, freq: number, sr = SR): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr)
  return out
}

export function runCore(core: PitchShifterCore, input: Float32Array, channels = 1): Float32Array[] {
  const Q = 128
  const outs: Float32Array[] = []
  for (let c = 0; c < channels; c++) outs.push(new Float32Array(input.length))
  for (let at = 0; at + Q <= input.length; at += Q) {
    const inp: (Float32Array | null)[] = []
    const outp: Float32Array[] = []
    for (let c = 0; c < channels; c++) {
      inp.push(input.subarray(at, at + Q))
      outp.push(outs[c].subarray(at, at + Q))
    }
    core.process(inp, outp)
  }
  return outs
}

function magAt(x: Float32Array, f: number, from: number, to: number, sr = SR): number {
  let re = 0
  let im = 0
  for (let i = from; i < to; i++) {
    const w = (2 * Math.PI * f * i) / sr
    re += x[i] * Math.cos(w)
    im += x[i] * Math.sin(w)
  }
  return (2 * Math.sqrt(re * re + im * im)) / (to - from)
}

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / (to - from))
}

describe('PitchShifterCore', () => {
  const SPEC_LO = 40
  const SPEC_HI = 1800
  const SPEC_STEP = 4
  const spectrum = (x: Float32Array): number[] => {
    const out: number[] = []
    for (let f = SPEC_LO; f <= SPEC_HI; f += SPEC_STEP) out.push(magAt(x, f, 8000, 24000))
    return out
  }

  const band = (spec: number[], lo: number, hi: number): number => {
    let s = 0
    for (let i = 0; i < spec.length; i++) {
      const f = SPEC_LO + i * SPEC_STEP
      if (f < lo || f > hi) continue
      s += spec[i] * spec[i]
    }
    return s
  }

  const cases: Array<[number, number]> = [
    [12, 220],
    [-12, 440],
    [7, 200],
    [5, 300],
    [-5, 300],
    [2, 180],
    [0.5, 400],
    [-0.5, 400],
  ]

  for (const [st, fin] of cases) {
    it(`${st > 0 ? '+' : ''}${st} semitones from ${fin} Hz — the note lands where it should`, () => {
      const core = new PitchShifterCore(SR, 1, st)
      const [out] = runCore(core, tone(SR, fin))
      const target = fin * pitchRatio(st)
      const spec = spectrum(out)
      expect(band(spec, target / 1.1, target * 1.1) / band(spec, SPEC_LO, SPEC_HI)).toBeGreaterThan(
        0.9
      )
      expect(magAt(out, fin, 8000, 24000)).toBeLessThan(0.1)
    })
  }

  it('does NOT change duration: as many samples in, as many out', () => {
    const core = new PitchShifterCore(SR, 1, 5)
    const input = tone(SR, 300)
    const [out] = runCore(core, input)
    expect(out.length).toBe(input.length)
  })

  it('loudness does not pulse — the window overlap holds the level', () => {
    const core = new PitchShifterCore(SR, 1, 5)
    const [out] = runCore(core, tone(SR, 220))
    const w = [rms(out, 10000, 14000), rms(out, 20000, 24000), rms(out, 30000, 34000)]
    const lo = Math.min(...w)
    const hi = Math.max(...w)
    expect(hi / lo).toBeLessThan(1.05)
    expect(lo).toBeGreaterThan(0.5)
  })

  it('nothing blows up or yields NaN at the knob limits', () => {
    for (const st of [PITCH_SEMITONES_MIN, PITCH_SEMITONES_MAX]) {
      const core = new PitchShifterCore(SR, 2, st)
      const outs = runCore(core, tone(SR / 2, 440), 2)
      for (const o of outs) {
        for (let i = 0; i < o.length; i += 37) {
          expect(Number.isFinite(o[i])).toBe(true)
          expect(Math.abs(o[i])).toBeLessThan(4)
        }
      }
    }
  })

  it('the source went silent — the node still pours the tail from the ring, not silence', () => {
    const core = new PitchShifterCore(SR, 1, 4)
    runCore(core, tone(4096, 300))
    const out = new Float32Array(128)
    core.process([null], [out])
    let energy = 0
    for (const v of out) energy += v * v
    expect(energy).toBeGreaterThan(0)
  })

  it('the channels share ONE phase — the stereo image does not drift', () => {
    const core = new PitchShifterCore(SR, 2, 6)
    const input = tone(4096, 300)
    const outs = runCore(core, input, 2)
    for (let i = 0; i < outs[0].length; i += 13) {
      expect(outs[0][i]).toBe(outs[1][i])
    }
  })

  it('latency stays within one grain — the ceiling promised in the header', () => {
    const core = new PitchShifterCore(SR, 1, 3)
    expect(core.grain).toBe(grainSamples(SR))
    expect(core.latencySamples()).toBeLessThanOrEqual(core.grain + 1)
    runCore(core, tone(8192, 300))
    expect(core.latencySamples()).toBeLessThanOrEqual(core.grain + 1)
  })
})

describe('sanitizePitch', () => {
  it('clamps to ±12', () => {
    expect(sanitizePitch({ semitones: 99 }).semitones).toBe(PITCH_SEMITONES_MAX)
    expect(sanitizePitch({ semitones: -99 }).semitones).toBe(PITCH_SEMITONES_MIN)
  })

  it('snaps to a 0.5 grid — the knob must not sit between ticks', () => {
    expect(sanitizePitch({ semitones: 2.3 }).semitones).toBe(2.5)
    expect(sanitizePitch({ semitones: 2.1 }).semitones).toBe(2)
    expect(sanitizePitch({ semitones: -3.26 }).semitones).toBe(-3.5)
    expect(PITCH_STEP).toBe(0.5)
  })

  it('garbage becomes 0, not NaN in AudioParam', () => {
    expect(sanitizePitch({ semitones: Number.NaN }).semitones).toBe(0)
    expect(sanitizePitch({ semitones: 'x' as unknown as number }).semitones).toBe(0)
  })
})

describe('pitch in the effects set', () => {
  it('0 semitones — the field is ABSENT: otherwise the graph would hold a node with latency', () => {
    expect(sanitizeEffects({ pitch: { semitones: 0 } })).toBeUndefined()
    expect(sanitizeEffects({ pitch: { semitones: 0.2 } })).toBeUndefined()
    expect(pitchActive({ semitones: 0 })).toBe(false)
    expect(pitchActive(undefined)).toBe(false)
    expect(pitchActive({ semitones: 0.5 })).toBe(true)
  })

  it('a live pitch survives sanitization and does not touch its neighbours', () => {
    const fx: ClipEffects = { pitch: { semitones: -4 } }
    expect(sanitizeEffects(fx)).toEqual({ pitch: { semitones: -4 } })
    expect(hasEffects(sanitizeEffects(fx))).toBe(true)
  })

  it('pitch is an INSERT, so it needs no dry/wet branching', () => {
    expect(hasSends({ pitch: { semitones: 5 } })).toBe(false)
    expect(hasEffects({ pitch: { semitones: 5 } })).toBe(true)
    expect(hasSends({ delay: { time: 0.2, feedback: 0.2, mix: 0.3 } })).toBe(true)
  })

  it('adds NO tail: pitch shifting does not lengthen the clip by a single sample', () => {
    expect(effectsTail({ pitch: { semitones: 12 } })).toBe(0)
    expect(effectsTail({ pitch: { semitones: -12 } })).toBe(0)
    const rvOnly = effectsTail({ reverb: { mix: 0.3, size: 0.5, decay: 2 } })
    expect(effectsTail({ reverb: { mix: 0.3, size: 0.5, decay: 2 }, pitch: { semitones: 7 } })).toBe(
      rvOnly
    )
  })

  it('the toggle sets +2 and REMOVES the field when switched off', () => {
    expect(toggleEffect(undefined, 'pitch', true)).toEqual({ pitch: DEFAULT_PITCH })
    expect(DEFAULT_PITCH.semitones).toBe(2)
    expect(toggleEffect({ pitch: DEFAULT_PITCH }, 'pitch', false)).toBeUndefined()
    const both = toggleEffect({ delay: { time: 0.2, feedback: 0.2, mix: 0.3 } }, 'pitch', true)
    expect(both?.delay).toBeDefined()
    expect(both?.pitch).toEqual(DEFAULT_PITCH)
  })
})

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'c1',
  sourceTakeId: 't1',
  srcIn: 0,
  srcOut: 2,
  start: 0,
  edits: emptyEdits(),
  ...over,
})

describe('compHasPitch', () => {
  it('sees pitch and does not see zero', () => {
    expect(compHasPitch([clip()])).toBe(false)
    expect(
      compHasPitch([clip({ edits: { ...emptyEdits(), effects: { pitch: { semitones: 3 } } } })])
    ).toBe(true)
    expect(
      compHasPitch([clip({ edits: { ...emptyEdits(), effects: { pitch: { semitones: 0 } } } })])
    ).toBe(false)
  })
})

describe('setClipEdits with pitch', () => {
  const comp = (): CueComp => ({ clips: [clip()] })

  it('writes and clamps, keeping the effects key only when it is needed', () => {
    const next = setClipEdits(comp(), 'c1', { effects: { pitch: { semitones: 40 } } })
    expect(next.clips[0].edits.effects?.pitch).toEqual({ semitones: PITCH_SEMITONES_MAX })
  })

  it('zero semitones removes the WHOLE effects key — byte for byte as before', () => {
    const base = setClipEdits(comp(), 'c1', {})
    const on = setClipEdits(base, 'c1', { effects: { pitch: { semitones: 5 } } })
    const off = setClipEdits(on, 'c1', { effects: { pitch: { semitones: 0 } } })
    expect('effects' in off.clips[0].edits).toBe(false)
    expect(JSON.stringify(off.clips[0].edits)).toBe(JSON.stringify(base.clips[0].edits))
  })

  it('pitch and speed live independently: one does not touch the other', () => {
    const a = setClipEdits(comp(), 'c1', { timeStretch: 1.5 })
    const b = setClipEdits(a, 'c1', { effects: { pitch: { semitones: -3 } } })
    expect(b.clips[0].edits.timeStretch).toBe(1.5)
    expect(b.clips[0].edits.effects?.pitch).toEqual({ semitones: -3 })
    const c = setClipEdits(b, 'c1', { timeStretch: 0.8 })
    expect(c.clips[0].edits.effects?.pitch).toEqual({ semitones: -3 })
  })
})

describe('zod roundtrip', () => {
  it('pitch survives a write to disk and a read back', () => {
    const fx: ClipEffects = { pitch: { semitones: -7.5 } }
    const parsed = clipEffectsSchema.parse(JSON.parse(JSON.stringify(fx)))
    expect(parsed).toEqual(fx)
  })

  it('pitch alongside the other effects is not swallowed', () => {
    const fx: ClipEffects = {
      reverb: { mix: 0.25, size: 0.5, decay: 1.2 },
      delay: { time: 0.25, feedback: 0.35, mix: 0.3 },
      pitch: { semitones: 2 },
    }
    expect(clipEffectsSchema.parse(JSON.parse(JSON.stringify(fx)))).toEqual(fx)
  })

  it('beyond the knob range — rejection, not silent clamping', () => {
    expect(clipEffectsSchema.safeParse({ pitch: { semitones: 13 } }).success).toBe(false)
    expect(clipEffectsSchema.safeParse({ pitch: { semitones: -13 } }).success).toBe(false)
    expect(clipEffectsSchema.safeParse({ pitch: { semitones: 'x' } }).success).toBe(false)
  })

  it('a value between ticks is read and makes it through to sanitizePitch', () => {
    const parsed = clipEffectsSchema.parse({ pitch: { semitones: 2.3 } })
    expect(parsed.pitch?.semitones).toBe(2.3)
    expect(sanitizeEffects(parsed)?.pitch?.semitones).toBe(2.5)
  })
})
