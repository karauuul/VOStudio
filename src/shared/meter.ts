export const METER_FLOOR_DB = -60

export function meterFill(peak: number): number {
  if (!(peak > 0)) return 0
  const db = 20 * Math.log10(peak)
  return Math.min(1, Math.max(0, 1 - db / METER_FLOOR_DB))
}

export function parseMonitorGain(raw: string | null): number {
  const v = raw?.trim() ? Number(raw) : Number.NaN
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1
}
