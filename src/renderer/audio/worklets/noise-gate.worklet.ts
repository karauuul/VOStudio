import { DEFAULT_GATE } from '@shared/effects'
import { GATE_SNAP } from '@shared/gate'

export const GATE_PROCESSOR = 'vo-gate'

export const GATE_WORKLET_SOURCE = `
const DEFAULT_THRESHOLD = ${DEFAULT_GATE.threshold}
const DEFAULT_ATTACK = ${DEFAULT_GATE.attack}
const DEFAULT_HOLD = ${DEFAULT_GATE.hold}
const DEFAULT_RELEASE = ${DEFAULT_GATE.release}
const DEFAULT_RANGE = ${DEFAULT_GATE.range}
const SNAP = ${GATE_SNAP}

function fin(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function dbToGain(db) {
  return Math.pow(10, db / 20)
}

function smoothing(seconds, sr) {
  const n = seconds * sr
  return n > 0 ? 1 - Math.exp(-1 / n) : 1
}

class VoGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = (options && options.processorOptions) || {}
    this.open = dbToGain(fin(o.threshold, DEFAULT_THRESHOLD))
    this.floor = dbToGain(fin(o.range, DEFAULT_RANGE))
    this.attack = smoothing(fin(o.attack, DEFAULT_ATTACK), sampleRate)
    this.release = smoothing(fin(o.release, DEFAULT_RELEASE), sampleRate)
    this.hold = Math.round(fin(o.hold, DEFAULT_HOLD) * sampleRate)
    this.gain = this.floor
    this.held = 0
  }

  process(inputs, outputs) {
    const out = outputs[0]
    if (!out || out.length === 0) return true
    const inp = inputs[0] || []

    const ins = inp.length
    const chans = out.length
    const frames = out[0].length
    const open = this.open
    const floor = this.floor
    const attack = this.attack
    const release = this.release
    const hold = this.hold
    let gain = this.gain
    let held = this.held

    for (let i = 0; i < frames; i++) {
      let peak = 0
      for (let c = 0; c < ins; c++) {
        const src = inp[c]
        const v = src ? Math.abs(src[i]) : 0
        if (v > peak) peak = v
      }
      let target = floor
      if (peak >= open) {
        held = hold
        target = 1
      } else if (held > 0) {
        held--
        target = 1
      }
      const d = target - gain
      gain = d > -SNAP && d < SNAP ? target : gain + d * (d > 0 ? attack : release)
      for (let c = 0; c < chans; c++) {
        const src = inp[c]
        out[c][i] = src ? src[i] * gain : 0
      }
    }

    this.gain = gain
    this.held = held
    return true
  }
}

registerProcessor('${GATE_PROCESSOR}', VoGateProcessor)
`
