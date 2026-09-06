export const END_EPS = 0.02

export interface ResumeBounds {
  dur: number
  end: number
  from: number
}

export function resumeAt(pos: number, b: ResumeBounds, rewindAtEnd: boolean): number {
  const p = Math.max(0, Math.min(b.dur, pos))
  return rewindAtEnd && p >= b.end - END_EPS ? b.from : p
}

export function playBounds(
  dur: number,
  region?: { in: number; out: number } | null,
  tail = 0
): { from: number; until: number } {
  const d = Math.max(0, dur)
  if (!region) return { from: 0, until: d + Math.max(0, tail) }
  const from = Math.min(Math.max(0, region.in), d)
  return { from, until: Math.max(from, region.out) }
}
