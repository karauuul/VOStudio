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
