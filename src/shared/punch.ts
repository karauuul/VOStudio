export const PUNCH_PREROLL_DEFAULT = 5
export const PUNCH_PREROLL_MAX = 10
export const PUNCH_PREROLL_STEP = 0.5
export const RECORD_LATENCY_MAX_MS = 1000
export const AUTO_LATENCY_MAX_SECONDS = 1

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function punchPrerollSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PUNCH_PREROLL_DEFAULT
  return clamp(Math.round(value / PUNCH_PREROLL_STEP) * PUNCH_PREROLL_STEP, 0, PUNCH_PREROLL_MAX)
}

export function recordLatencyMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return clamp(Math.round(value), -RECORD_LATENCY_MAX_MS, RECORD_LATENCY_MAX_MS)
}

export function latencyEstimate(parts: readonly unknown[]): number {
  const sum = parts.reduce<number>(
    (acc, p) => (typeof p === 'number' && Number.isFinite(p) && p > 0 ? acc + p : acc),
    0
  )
  return clamp(sum, 0, AUTO_LATENCY_MAX_SECONDS)
}

export function latencySeconds(settingMs: unknown, estimate: number): number {
  const manual = recordLatencyMs(settingMs)
  return manual === undefined ? latencyEstimate([estimate]) : manual / 1000
}

export function punchHidden(hidden: number, latency: number, duration: number): number {
  return clamp(hidden + latency, 0, Math.max(0, duration))
}
