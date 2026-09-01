import { PITCH_SEMITONES_MAX, PITCH_SEMITONES_MIN } from '@shared/effects'
import { GRAIN_SECONDS } from '@shared/pitch'

export const PITCH_PROCESSOR = 'vo-pitch'

export const PITCH_PARAM = 'semitones'

export const PITCH_WORKLET_SOURCE = `
const GRAIN_SECONDS = ${GRAIN_SECONDS}
const SEMI_MIN = ${PITCH_SEMITONES_MIN}
const SEMI_MAX = ${PITCH_SEMITONES_MAX}
const TWO_PI = Math.PI * 2

function wrap01(x) {
  const f = x - Math.floor(x)
  return f < 0 ? 0 : f >= 1 ? 0 : f
}

function hann(phase) {
  return 0.5 - 0.5 * Math.cos(TWO_PI * phase)
}

function tap(ring, size, write, delay) {
  const rp = write - delay
  const i0 = Math.floor(rp)
  const frac = rp - i0
  const a = ((i0 % size) + size) % size
  const b = a + 1 === size ? 0 : a + 1
  const va = ring[a]
  return va + (ring[b] - va) * frac
}

class VoPitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: '${PITCH_PARAM}',
        defaultValue: 0,
        minValue: SEMI_MIN,
        maxValue: SEMI_MAX,
        automationRate: 'k-rate',
      },
    ]
  }

  constructor() {
    super()
    this.grain = Math.max(64, Math.round(GRAIN_SECONDS * sampleRate))
    this.size = this.grain * 2
    this.rings = []
    this.write = 0
    this.phase = 0
  }

  ringFor(c) {
    while (this.rings.length <= c) this.rings.push(new Float32Array(this.size))
    return this.rings[c]
  }

  process(inputs, outputs, params) {
    const out = outputs[0]
    if (!out || out.length === 0) return true
    const inp = inputs[0] || []

    const p = params.${PITCH_PARAM}
    const semis = p.length > 0 ? p[0] : 0
    const ratio = Math.pow(2, semis / 12)
    const grain = this.grain
    const size = this.size
    const step = (1 - ratio) / grain

    const chans = out.length
    const frames = out[0].length
    let write = this.write
    let phase = this.phase

    for (let i = 0; i < frames; i++) {
      const pA = phase
      const pB = wrap01(phase + 0.5)
      const wA = hann(pA)
      const wB = hann(pB)
      const dA = pA * grain + 1
      const dB = pB * grain + 1

      for (let c = 0; c < chans; c++) {
        const ring = this.ringFor(c)
        const src = inp[c]
        ring[write] = src ? src[i] : 0
        out[c][i] = tap(ring, size, write, dA) * wA + tap(ring, size, write, dB) * wB
      }

      write = write + 1 === size ? 0 : write + 1
      phase = wrap01(phase + step)
    }

    this.write = write
    this.phase = phase
    return true
  }
}

registerProcessor('${PITCH_PROCESSOR}', VoPitchProcessor)
`
