import { afterEach, describe, expect, it } from 'vitest'
import {
  GATE_SNAP,
  NoiseGateCore,
  gateCoefficients,
  gateStep,
  smoothing,
} from '@shared/gate'
import { DEFAULT_GATE, GATE_THRESHOLD_MAX, dbToGain, type NoiseGateEffect } from '@shared/effects'
import {
  GATE_PROCESSOR,
  GATE_WORKLET_SOURCE,
} from '../src/renderer/audio/worklets/noise-gate.worklet'

const SR = 48000
const QUANTUM = 128

const gate = (over: Partial<NoiseGateEffect> = {}): NoiseGateEffect => ({ ...DEFAULT_GATE, ...over })

function tone(n: number, amp: number, freq = 440, sr = SR): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr)
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function runCore(
  g: NoiseGateEffect,
  inputs: Float32Array[],
  block = QUANTUM,
  sr = SR,
  silentFrom = Infinity
): { out: Float32Array[]; core: NoiseGateCore } {
  const core = new NoiseGateCore(sr, g)
  const n = inputs[0].length
  const out = inputs.map(() => new Float32Array(n))
  for (let at = 0; at < n; at += block) {
    const end = Math.min(n, at + block)
    const inp = inputs.map((ch) => (at < silentFrom ? ch.subarray(at, end) : null))
    core.process(
      inp,
      out.map((ch) => ch.subarray(at, end))
    )
  }
  return { out, core }
}

function rms(a: Float32Array, from: number, to: number): number {
  let e = 0
  for (let i = from; i < to; i++) e += a[i] * a[i]
  return Math.sqrt(e / Math.max(1, to - from))
}

describe('gate coefficients', () => {
  it('smoothing is a one-pole step: instant at zero time, slower for longer times', () => {
    expect(smoothing(0, SR)).toBe(1)
    expect(smoothing(-1, SR)).toBe(1)
    const fast = smoothing(0.001, SR)
    const slow = smoothing(0.1, SR)
    expect(fast).toBeGreaterThan(slow)
    expect(slow).toBeGreaterThan(0)
    expect(fast).toBeLessThan(1)
  })

  it('times are seconds, so in samples they follow the sample rate', () => {
    const a = gateCoefficients(gate({ hold: 0.05 }), 48000)
    const b = gateCoefficients(gate({ hold: 0.05 }), 44100)
    expect(a.hold).toBe(2400)
    expect(b.hold).toBe(Math.round(0.05 * 44100))
    expect(a.release).toBeLessThan(b.release)
  })

  it('threshold and range are decibels', () => {
    const k = gateCoefficients(gate({ threshold: -40, range: -24 }), SR)
    expect(k.open).toBeCloseTo(0.01, 12)
    expect(k.floor).toBeCloseTo(dbToGain(-24), 12)
  })

  it('garbage parameters fall back to the defaults, not NaN', () => {
    const k = gateCoefficients({ threshold: NaN, attack: NaN, hold: NaN, release: NaN, range: NaN }, SR)
    expect(k).toEqual(gateCoefficients(DEFAULT_GATE, SR))
    const broken = gateCoefficients(DEFAULT_GATE, NaN)
    for (const v of Object.values(broken)) expect(Number.isFinite(v)).toBe(true)
  })

  it('the step snaps onto its target instead of crawling through denormals', () => {
    const k = gateCoefficients(DEFAULT_GATE, SR)
    expect(gateStep(1 - GATE_SNAP / 2, 1, k)).toBe(1)
    expect(gateStep(0.5, 1, k)).toBeCloseTo(0.5 + 0.5 * k.attack, 12)
    expect(gateStep(0.5, 0.1, k)).toBeCloseTo(0.5 - 0.4 * k.release, 12)
  })
})

describe('NoiseGateCore', () => {
  it('silence in, silence out — and never NaN', () => {
    const { out } = runCore(gate(), [new Float32Array(SR / 10)])
    for (const v of out[0]) expect(v).toBe(0)
  })

  it('a signal above the threshold passes untouched once open', () => {
    const input = tone(SR / 2, 0.5)
    const { out } = runCore(gate({ attack: 0 }), [input])
    for (let i = 0; i < input.length; i++) expect(out[0][i]).toBe(input[i])
  })

  it('a signal below the threshold is attenuated by the range', () => {
    const input = tone(SR, 0.001)
    const g = gate({ threshold: -40, range: -30 })
    const { out } = runCore(g, [input])
    const ratio = rms(out[0], SR / 2, SR) / rms(input, SR / 2, SR)
    expect(20 * Math.log10(ratio)).toBeCloseTo(-30, 3)
  })

  it('range 0 dB is an exact passthrough whatever the level', () => {
    const input = concat(tone(SR / 4, 0.5), tone(SR / 4, 0.0001))
    const { out } = runCore(gate({ range: 0 }), [input])
    for (let i = 0; i < input.length; i++) expect(out[0][i]).toBe(input[i])
  })

  it('the noise between phrases drops, the phrase itself does not', () => {
    const loud = tone(SR / 2, 0.5)
    const quiet = tone(SR / 2, 0.002, 1000)
    const input = concat(quiet, loud, quiet)
    const { out } = runCore(gate({ threshold: -40, range: -40, attack: 0.001, release: 0.05 }), [input])
    const half = SR / 2
    const ratio = (from: number, to: number): number => rms(out[0], from, to) / rms(input, from, to)
    expect(ratio(half + half / 2, 2 * half)).toBeCloseTo(1, 6)
    expect(ratio(2 * half + half / 2, 3 * half)).toBeLessThan(1 / 30)
    expect(ratio(0, half)).toBeLessThan(1 / 50)
  })

  it('hold keeps the gate fully open after the signal drops', () => {
    const hold = 0.05
    const input = concat(tone(SR / 10, 0.5), new Float32Array(SR / 5).fill(0.0001))
    const g = gate({ attack: 0, hold, release: 0.1, range: -60 })
    const { out } = runCore(g, [input])
    const drop = SR / 10
    let last = drop
    for (let i = drop - 200; i < drop; i++) if (Math.abs(input[i]) >= dbToGain(g.threshold)) last = i
    const holdEnd = last + Math.round(hold * SR)
    for (let i = drop; i <= holdEnd; i++) expect(out[0][i]).toBe(input[i])
    expect(Math.abs(out[0][holdEnd + 100])).toBeLessThan(Math.abs(input[holdEnd + 100]))
  })

  it('release follows its time constant: one release time closes ~63 % of the way', () => {
    const release = 0.1
    const g = gate({ attack: 0, hold: 0, release, range: -60 })
    const core = new NoiseGateCore(SR, g)
    core.process([new Float32Array(4).fill(1)], [new Float32Array(4)])
    expect(core.level()).toBe(1)
    const zeros = new Float32Array(Math.round(release * SR))
    core.process([zeros], [new Float32Array(zeros.length)])
    const floor = dbToGain(-60)
    const expected = floor + (1 - floor) * Math.exp(-1)
    expect(core.level()).toBeCloseTo(expected, 3)
  })

  it('attack follows its time constant from the closed state', () => {
    const attack = 0.01
    const g = gate({ attack, hold: 0.5, range: -60 })
    const core = new NoiseGateCore(SR, g)
    const floor = dbToGain(-60)
    expect(core.level()).toBeCloseTo(floor, 12)
    const n = Math.round(attack * SR)
    core.process([new Float32Array(n).fill(0.5)], [new Float32Array(n)])
    expect(core.level()).toBeCloseTo(1 - (1 - floor) * Math.exp(-1), 3)
  })

  it('stereo is linked: a loud left opens the quiet right too, the image stays put', () => {
    const left = tone(SR / 4, 0.5)
    const right = tone(SR / 4, 0.001, 660)
    const { out } = runCore(gate({ attack: 0 }), [left, right])
    for (let i = 0; i < left.length; i++) {
      expect(out[0][i]).toBe(left[i])
      expect(out[1][i]).toBe(right[i])
    }
  })

  it('the result does not depend on the block size — live quanta and one big offline block agree', () => {
    const input = concat(tone(SR / 4, 0.002), tone(SR / 4, 0.4), tone(SR / 4, 0.002))
    const g = gate({ attack: 0.003, hold: 0.02, release: 0.08, range: -36 })
    const a = runCore(g, [input], 128).out[0]
    const b = runCore(g, [input], 1000).out[0]
    const c = runCore(g, [input], input.length).out[0]
    for (let i = 0; i < input.length; i++) {
      if (a[i] !== b[i] || a[i] !== c[i]) throw new Error(`block-size mismatch at ${i}`)
    }
  })

  it('a missing input channel writes silence rather than garbage', () => {
    const core = new NoiseGateCore(SR, gate())
    const out = [new Float32Array(QUANTUM).fill(7), new Float32Array(QUANTUM).fill(7)]
    core.process([tone(QUANTUM, 0.5), null], out)
    for (const v of out[1]) expect(v).toBe(0)
    expect(() => core.process([], [])).not.toThrow()
  })

  it('clamps an out-of-range threshold instead of never opening', () => {
    const core = new NoiseGateCore(SR, gate({ threshold: 40, attack: 0 }))
    const input = new Float32Array(QUANTUM).fill(1)
    const out = new Float32Array(QUANTUM)
    core.process([input], [out])
    expect(dbToGain(GATE_THRESHOLD_MAX)).toBe(1)
    expect(out[QUANTUM - 1]).toBe(1)
  })
})

interface Proc {
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean
}

type Ctor = new (options?: { processorOptions?: Partial<NoiseGateEffect> }) => Proc

function instantiate(sampleRate = SR): Ctor {
  let ctor: Ctor | null = null
  class FakeProcessor {}
  const register = (name: string, c: Ctor): void => {
    if (name === GATE_PROCESSOR) ctor = c
  }
  Object.defineProperty(globalThis, 'sampleRate', { configurable: true, get: () => sampleRate })
  new Function('AudioWorkletProcessor', 'registerProcessor', GATE_WORKLET_SOURCE)(
    FakeProcessor,
    register
  )
  if (!ctor) throw new Error('registerProcessor was not called')
  return ctor
}

function runWorklet(
  proc: Proc,
  inputs: Float32Array[],
  silentFrom = Infinity
): Float32Array[] {
  const n = inputs[0].length
  const out = inputs.map(() => new Float32Array(n))
  for (let at = 0; at < n; at += QUANTUM) {
    const end = Math.min(n, at + QUANTUM)
    const inp = at < silentFrom ? inputs.map((ch) => ch.subarray(at, end)) : []
    proc.process([inp], [out.map((ch) => ch.subarray(at, end))])
  }
  return out
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'sampleRate')
})

describe('noise-gate.worklet: source', () => {
  it('syntactically valid JS', () => {
    expect(() => new Function(GATE_WORKLET_SOURCE)).not.toThrow()
  })

  it('registers the processor under the expected name', () => {
    expect(GATE_PROCESSOR).toBe('vo-gate')
    expect(GATE_WORKLET_SOURCE).toContain(`registerProcessor('${GATE_PROCESSOR}'`)
  })

  it('interpolations were substituted, not left as placeholders', () => {
    expect(GATE_WORKLET_SOURCE).toContain(`const DEFAULT_THRESHOLD = ${DEFAULT_GATE.threshold}`)
    expect(GATE_WORKLET_SOURCE).toContain(`const DEFAULT_RANGE = ${DEFAULT_GATE.range}`)
    expect(GATE_WORKLET_SOURCE).toContain(`const SNAP = ${GATE_SNAP}`)
    expect(GATE_WORKLET_SOURCE).not.toContain('${')
  })
})

describe('noise-gate.worklet: parity with @shared/gate', () => {
  const input = concat(
    tone(SR / 4, 0.002, 1000),
    tone(SR / 4, 0.5, 220),
    tone(SR / 8, 0.004, 3000),
    tone(SR / 4, 0.3, 440)
  )
  const cases: NoiseGateEffect[] = [
    DEFAULT_GATE,
    gate({ attack: 0, hold: 0, release: 0.005 }),
    gate({ threshold: -20, attack: 0.1, hold: 0.5, release: 1, range: -80 }),
    gate({ threshold: -60, range: 0 }),
  ]

  for (const g of cases) {
    it(`sample-for-sample at ${JSON.stringify(g)}`, () => {
      const w = runWorklet(new (instantiate())({ processorOptions: g }), [input])[0]
      const c = runCore(g, [input]).out[0]
      for (let i = 0; i < w.length; i++) {
        if (w[i] !== c[i]) throw new Error(`mismatch at sample ${i}: worklet ${w[i]} vs core ${c[i]}`)
      }
    })
  }

  it('stereo matches too — and channels do not swap', () => {
    const right = tone(input.length, 0.01, 660)
    const g = gate({ threshold: -30 })
    const w = runWorklet(new (instantiate())({ processorOptions: g }), [input, right])
    const c = runCore(g, [input, right]).out
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < w[ch].length; i++) {
        if (w[ch][i] !== c[ch][i]) throw new Error(`channel ${ch}, sample ${i}`)
      }
    }
  })

  it('a source that stops (empty input) matches too', () => {
    const half = QUANTUM * 100
    const w = runWorklet(new (instantiate())({ processorOptions: DEFAULT_GATE }), [input], half)[0]
    const c = runCore(DEFAULT_GATE, [input], QUANTUM, SR, half).out[0]
    for (let i = 0; i < w.length; i++) {
      if (w[i] !== c[i]) throw new Error(`mismatch at sample ${i}`)
    }
  })

  it('no processor options means the documented defaults', () => {
    const w = runWorklet(new (instantiate())(), [input])[0]
    const c = runCore(DEFAULT_GATE, [input]).out[0]
    for (let i = 0; i < w.length; i++) {
      if (w[i] !== c[i]) throw new Error(`mismatch at sample ${i}`)
    }
  })

  it('the context sample rate drives the timing', () => {
    const g = gate({ hold: 0.01, release: 0.02 })
    const at44 = runWorklet(new (instantiate(44100))({ processorOptions: g }), [input])[0]
    const core44 = runCore(g, [input], QUANTUM, 44100).out[0]
    for (let i = 0; i < at44.length; i++) {
      if (at44[i] !== core44[i]) throw new Error(`mismatch at sample ${i}`)
    }
  })
})

describe('noise-gate.worklet: behavior', () => {
  it('process is ALWAYS true — the node survives a source pause', () => {
    const proc = new (instantiate())({ processorOptions: DEFAULT_GATE })
    const out = [new Float32Array(QUANTUM)]
    expect(proc.process([[new Float32Array(QUANTUM)]], [out])).toBe(true)
    expect(proc.process([[]], [out])).toBe(true)
    expect(proc.process([], [out])).toBe(true)
  })

  it('an empty output does not crash the processor', () => {
    const proc = new (instantiate())({ processorOptions: DEFAULT_GATE })
    expect(() => proc.process([[]], [[]])).not.toThrow()
    expect(() => proc.process([[]], [])).not.toThrow()
  })

  it('garbage options fall back to the defaults rather than NaN output', () => {
    const proc = new (instantiate())({
      processorOptions: { threshold: NaN, attack: Infinity } as unknown as NoiseGateEffect,
    })
    const out = new Float32Array(QUANTUM)
    proc.process([[tone(QUANTUM, 0.5)]], [[out]])
    for (const v of out) expect(Number.isFinite(v)).toBe(true)
  })
})
