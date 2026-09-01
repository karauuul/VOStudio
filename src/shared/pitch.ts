export const GRAIN_SECONDS = 0.03

export function grainSamples(sampleRate: number): number {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
  return Math.max(64, Math.round(GRAIN_SECONDS * sr))
}

export function pitchRatio(semitones: number): number {
  const s = Number.isFinite(semitones) ? semitones : 0
  return Math.pow(2, s / 12)
}

export function wrap01(x: number): number {
  const f = x - Math.floor(x)
  return f < 0 ? 0 : f >= 1 ? 0 : f
}

export function hann(phase: number): number {
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * phase)
}

export function hannPair(phase: number): number {
  return hann(phase) + hann(wrap01(phase + 0.5))
}

export function phaseStep(ratio: number, grain: number): number {
  return (1 - ratio) / grain
}

export function tapDelay(phase: number, grain: number): number {
  return phase * grain + 1
}

export class PitchShifterCore {
  readonly grain: number
  readonly size: number
  private readonly rings: Float32Array[]
  private write = 0
  private phase = 0
  private step = 0

  constructor(sampleRate: number, channels: number, semitones = 0) {
    this.grain = grainSamples(sampleRate)
    this.size = this.grain * 2
    const n = Math.max(1, Math.floor(channels))
    this.rings = []
    for (let i = 0; i < n; i++) this.rings.push(new Float32Array(this.size))
    this.setSemitones(semitones)
  }

  setSemitones(semitones: number): void {
    this.step = phaseStep(pitchRatio(semitones), this.grain)
  }

  latencySamples(): number {
    return tapDelay(this.phase, this.grain)
  }

  process(input: (Float32Array | null)[], output: Float32Array[]): void {
    const size = this.size
    const grain = this.grain
    const step = this.step
    const chans = output.length
    const frames = chans > 0 ? output[0].length : 0
    let write = this.write
    let phase = this.phase

    for (let i = 0; i < frames; i++) {
      const pA = phase
      const pB = wrap01(phase + 0.5)
      const wA = hann(pA)
      const wB = hann(pB)
      const dA = tapDelay(pA, grain)
      const dB = tapDelay(pB, grain)

      for (let c = 0; c < chans; c++) {
        const ring = this.rings[c] ?? this.rings[0]
        const src = input[c]
        ring[write] = src ? src[i] : 0
        output[c][i] = tap(ring, size, write, dA) * wA + tap(ring, size, write, dB) * wB
      }

      write = write + 1 === size ? 0 : write + 1
      phase = wrap01(phase + step)
    }

    this.write = write
    this.phase = phase
  }
}

function tap(ring: Float32Array, size: number, write: number, delay: number): number {
  const rp = write - delay
  const i0 = Math.floor(rp)
  const frac = rp - i0
  const a = ((i0 % size) + size) % size
  const b = a + 1 === size ? 0 : a + 1
  const va = ring[a]
  return va + (ring[b] - va) * frac
}
