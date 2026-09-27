import { parseEbur128, parseSamplePeak } from './export-settings'
import { parseSilence, type Span } from './sources'

export const EDGE_SILENCE_DB = -50
export const EDGE_SILENCE_MIN = 0.05
export const CLIP_DBFS = -0.01
const EDGE_TOLERANCE = 0.02

export interface AudioMetrics {
  duration: number
  lufs: number | null
  truePeakDb: number | null
  samplePeakDb: number | null
  rmsDb: number | null
  leadingSilence: number
  trailingSilence: number
  clipped: boolean
}

export const loudnessFilter = (rate?: number, peak = 'sample'): string =>
  `${rate ? `aresample=${rate},` : ''}ebur128=peak=${peak},astats=measure_perchannel=none`

export const silenceFilter = (noiseDb: number, minSeconds: number): string =>
  `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`

export const METRICS_FILTER = `${loudnessFilter(undefined, 'sample+true')},${silenceFilter(EDGE_SILENCE_DB, EDGE_SILENCE_MIN)}`

const TRUE_PEAK_RE = /True peak:\s*Peak:\s*(-inf|-?\d+(?:\.\d+)?)\s*dBFS/g
const RMS_RE = /RMS level dB:\s*(-inf|-?\d+(?:\.\d+)?)/g
const SAMPLES_RE = /Number of samples:\s*(\d+)/g

const round3 = (n: number): number => Math.round(n * 1000) / 1000

function lastNumber(stderr: string, pattern: RegExp): number | null {
  let last: number | null = null
  for (const m of stderr.matchAll(pattern)) {
    const v = Number(m[1])
    last = Number.isFinite(v) ? v : null
  }
  return last
}

export function edgeSilence(spans: Span[], duration: number): { leading: number; trailing: number } {
  const first = spans[0]
  const last = spans[spans.length - 1]
  if (!(duration > 0) || !first || !last) return { leading: 0, trailing: 0 }
  return {
    leading: first.start <= EDGE_TOLERANCE ? round3(Math.min(first.end, duration)) : 0,
    trailing: last.end >= duration - EDGE_TOLERANCE ? round3(Math.max(0, duration - last.start)) : 0,
  }
}

export function measuredDuration(stderr: string, probe: { duration?: number; sampleRate?: number }): number {
  const samples = lastNumber(stderr, SAMPLES_RE)
  return samples !== null && probe.sampleRate ? samples / probe.sampleRate : (probe.duration ?? 0)
}

export function parseMetrics(stderr: string, probe: { duration?: number; sampleRate?: number }): AudioMetrics {
  const duration = measuredDuration(stderr, probe)
  const samplePeakDb = parseSamplePeak(stderr)
  const { leading, trailing } = edgeSilence(parseSilence(stderr), duration)
  const rounded = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100)
  return {
    duration: round3(duration),
    lufs: rounded(parseEbur128(stderr)),
    truePeakDb: rounded(lastNumber(stderr, TRUE_PEAK_RE)),
    samplePeakDb: rounded(samplePeakDb),
    rmsDb: rounded(lastNumber(stderr, RMS_RE)),
    leadingSilence: leading,
    trailingSilence: trailing,
    clipped: samplePeakDb !== null && samplePeakDb >= CLIP_DBFS,
  }
}
