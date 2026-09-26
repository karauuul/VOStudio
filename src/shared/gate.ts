import { dbToGain, sanitizeGate, type NoiseGateEffect } from './effects'

export const GATE_SNAP = 1e-9

export function smoothing(seconds: number, sampleRate: number): number {
  const n = seconds * sampleRate
  return n > 0 ? 1 - Math.exp(-1 / n) : 1
}

export interface GateCoefficients {
  open: number
  floor: number
  attack: number
  release: number
  hold: number
}

export function gateCoefficients(gate: NoiseGateEffect, sampleRate: number): GateCoefficients {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
  const g = sanitizeGate(gate)
  return {
    open: dbToGain(g.threshold),
    floor: dbToGain(g.range),
    attack: smoothing(g.attack, sr),
    release: smoothing(g.release, sr),
    hold: Math.round(g.hold * sr),
  }
}

export function gateStep(gain: number, target: number, k: GateCoefficients): number {
  const d = target - gain
  if (d > -GATE_SNAP && d < GATE_SNAP) return target
  return gain + d * (d > 0 ? k.attack : k.release)
}

export class NoiseGateCore {
  private readonly k: GateCoefficients
  private gain: number
  private held = 0

  constructor(sampleRate: number, gate: NoiseGateEffect) {
    this.k = gateCoefficients(gate, sampleRate)
    this.gain = this.k.floor
  }

  level(): number {
    return this.gain
  }

  process(input: (Float32Array | null)[], output: Float32Array[]): void {
    const k = this.k
    const ins = input.length
    const chans = output.length
    const frames = chans > 0 ? output[0].length : 0
    let gain = this.gain
    let held = this.held

    for (let i = 0; i < frames; i++) {
      let peak = 0
      for (let c = 0; c < ins; c++) {
        const src = input[c]
        const v = src ? Math.abs(src[i]) : 0
        if (v > peak) peak = v
      }
      let target = k.floor
      if (peak >= k.open) {
        held = k.hold
        target = 1
      } else if (held > 0) {
        held--
        target = 1
      }
      gain = gateStep(gain, target, k)
      for (let c = 0; c < chans; c++) {
        const src = input[c]
        output[c][i] = src ? src[i] * gain : 0
      }
    }

    this.gain = gain
    this.held = held
  }
}
