import { afterEach, describe, expect, it } from 'vitest'
import {
  PITCH_PARAM,
  PITCH_PROCESSOR,
  PITCH_WORKLET_SOURCE,
} from '../src/renderer/audio/worklets/pitch-shifter.worklet'
import { GRAIN_SECONDS, PitchShifterCore, grainSamples } from '@shared/pitch'
import { PITCH_SEMITONES_MAX, PITCH_SEMITONES_MIN } from '@shared/effects'

const SR = 48000
const QUANTUM = 128

interface Proc {
  process: (
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>
  ) => boolean
}

interface Ctor {
  new (): Proc
  parameterDescriptors?: unknown
}

function instantiate(sampleRate = SR): { proc: Proc; ctor: Ctor } {
  let ctor: Ctor | null = null
  class FakeProcessor {}
  const register = (_name: string, c: Ctor): void => {
    ctor = c
  }
  Object.defineProperty(globalThis, 'sampleRate', {
    configurable: true,
    get: () => sampleRate,
  })
  new Function('AudioWorkletProcessor', 'registerProcessor', PITCH_WORKLET_SOURCE)(
    FakeProcessor,
    register
  )
  if (!ctor) throw new Error('registerProcessor was not called')
  return { proc: new (ctor as Ctor)(), ctor: ctor as Ctor }
}

function runWorklet(
  proc: Proc,
  input: Float32Array,
  semitones: number,
  channels = 1,
  silentAfter = Infinity
): Float32Array[] {
  const outs: Float32Array[] = []
  for (let c = 0; c < channels; c++) outs.push(new Float32Array(input.length))
  const params = { [PITCH_PARAM]: new Float32Array([semitones]) }
  for (let at = 0; at + QUANTUM <= input.length; at += QUANTUM) {
    const inp: Float32Array[] = []
    const outp: Float32Array[] = []
    for (let c = 0; c < channels; c++) {
      if (at < silentAfter) inp.push(input.subarray(at, at + QUANTUM))
      outp.push(outs[c].subarray(at, at + QUANTUM))
    }
    proc.process([inp], [outp], params)
  }
  return outs
}

function runCore(
  input: Float32Array,
  semitones: number,
  channels = 1,
  silentAfter = Infinity
): Float32Array[] {
  const core = new PitchShifterCore(SR, channels, semitones)
  const outs: Float32Array[] = []
  for (let c = 0; c < channels; c++) outs.push(new Float32Array(input.length))
  for (let at = 0; at + QUANTUM <= input.length; at += QUANTUM) {
    const inp: (Float32Array | null)[] = []
    const outp: Float32Array[] = []
    for (let c = 0; c < channels; c++) {
      inp.push(at < silentAfter ? input.subarray(at, at + QUANTUM) : null)
      outp.push(outs[c].subarray(at, at + QUANTUM))
    }
    core.process(inp, outp)
  }
  return outs
}

function signal(n: number): Float32Array {
  let a = 12345 >>> 0
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    out[i] =
      0.5 * Math.sin(2 * Math.PI * 180 * t) +
      0.3 * Math.sin(2 * Math.PI * 540 * t) +
      0.15 * Math.sin(2 * Math.PI * 1300 * t) +
      0.02 * (rnd() * 2 - 1)
  }
  return out
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'sampleRate')
})

describe('pitch-shifter.worklet: source', () => {
  it('syntactically valid JS', () => {
    expect(() => new Function(PITCH_WORKLET_SOURCE)).not.toThrow()
  })

  it('registers the processor under the expected name', () => {
    expect(PITCH_WORKLET_SOURCE).toContain(`registerProcessor('${PITCH_PROCESSOR}'`)
    expect(PITCH_PROCESSOR).toBe('vo-pitch')
  })

  it('interpolations were substituted, not left as placeholders', () => {
    expect(PITCH_WORKLET_SOURCE).toContain(`const GRAIN_SECONDS = ${GRAIN_SECONDS}`)
    expect(PITCH_WORKLET_SOURCE).toContain(`const SEMI_MIN = ${PITCH_SEMITONES_MIN}`)
    expect(PITCH_WORKLET_SOURCE).toContain(`const SEMI_MAX = ${PITCH_SEMITONES_MAX}`)
    expect(PITCH_WORKLET_SOURCE).not.toContain('${')
  })

  it('exposes the semitones AudioParam within the knob range', () => {
    const { ctor } = instantiate()
    const descs = ctor.parameterDescriptors as Array<Record<string, unknown>>
    expect(descs).toHaveLength(1)
    expect(descs[0].name).toBe(PITCH_PARAM)
    expect(descs[0].defaultValue).toBe(0)
    expect(descs[0].minValue).toBe(PITCH_SEMITONES_MIN)
    expect(descs[0].maxValue).toBe(PITCH_SEMITONES_MAX)
  })

  it('grain is computed from the CONTEXT sampleRate, not from a constant', () => {
    const a = instantiate(48000).proc as unknown as { grain: number }
    const b = instantiate(44100).proc as unknown as { grain: number }
    expect(a.grain).toBe(grainSamples(48000))
    expect(b.grain).toBe(grainSamples(44100))
  })
})

describe('pitch-shifter.worklet: parity with @shared/pitch', () => {
  const input = signal(SR / 2)

  for (const st of [PITCH_SEMITONES_MIN, -7, -0.5, 0.5, 3, 7, PITCH_SEMITONES_MAX]) {
    it(`sample-for-sample at ${st} semitones`, () => {
      const { proc } = instantiate()
      const [w] = runWorklet(proc, input, st)
      const [c] = runCore(input, st)
      expect(w.length).toBe(c.length)
      for (let i = 0; i < w.length; i++) {
        if (w[i] !== c[i]) {
          throw new Error(`mismatch at sample ${i}: worklet ${w[i]} vs core ${c[i]}`)
        }
      }
      let energy = 0
      for (let i = 0; i < w.length; i++) energy += w[i] * w[i]
      expect(energy).toBeGreaterThan(1)
    })
  }

  it('stereo matches too — and channels do not swap', () => {
    const { proc } = instantiate()
    const w = runWorklet(proc, input, 4, 2)
    const c = runCore(input, 4, 2)
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < w[ch].length; i++) {
        if (w[ch][i] !== c[ch][i]) throw new Error(`channel ${ch}, sample ${i}`)
      }
    }
  })

  it('the tail after the source stops is identical too', () => {
    const half = QUANTUM * 100
    const { proc } = instantiate()
    const [w] = runWorklet(proc, input, 6, 1, half)
    const [c] = runCore(input, 6, 1, half)
    for (let i = 0; i < w.length; i++) {
      if (w[i] !== c[i]) throw new Error(`tail mismatch at sample ${i}`)
    }
    let tail = 0
    for (let i = half; i < half + grainSamples(SR); i++) tail += w[i] * w[i]
    expect(tail).toBeGreaterThan(0)
  })
})

describe('pitch-shifter.worklet: behavior', () => {
  it('process is ALWAYS true — the node survives a source pause', () => {
    const { proc } = instantiate()
    const out = [new Float32Array(QUANTUM)]
    const params = { [PITCH_PARAM]: new Float32Array([3]) }
    expect(proc.process([[new Float32Array(QUANTUM)]], [out], params)).toBe(true)
    expect(proc.process([[]], [out], params)).toBe(true)
    expect(proc.process([], [out], params)).toBe(true)
  })

  it('an empty output does not crash the processor', () => {
    const { proc } = instantiate()
    const params = { [PITCH_PARAM]: new Float32Array([3]) }
    expect(() => proc.process([[]], [[]], params)).not.toThrow()
    expect(() => proc.process([[]], [], params)).not.toThrow()
  })

  it('an empty param array means 0 semitones, not NaN in the phase step', () => {
    const { proc } = instantiate()
    const inp = new Float32Array(QUANTUM).fill(0.5)
    const out = new Float32Array(QUANTUM)
    proc.process([[inp]], [[out]], { [PITCH_PARAM]: new Float32Array(0) })
    for (const v of out) expect(Number.isFinite(v)).toBe(true)
  })
})
