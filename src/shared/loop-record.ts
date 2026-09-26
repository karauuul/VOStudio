export const LOOP_PASS_MAX = 1000
export const LOOP_PARTIAL_MIN_SECONDS = 0.1

export interface PassRange {
  from: number
  to: number
}

export interface LoopPlan {
  passes: PassRange[]
  place: number | null
}

export interface LoopTake {
  marks: readonly number[]
  length: number
  latency: number
  frames: number
  sampleRate: number
}

const EMPTY: LoopPlan = { passes: [], place: null }

export function loopPlan(take: LoopTake): LoopPlan {
  const rate = take.sampleRate
  if (!(rate > 0) || !Number.isFinite(take.length) || !Number.isFinite(take.latency)) return EMPTY
  const length = Math.round(take.length * rate)
  const frames = Math.floor(take.frames)
  if (!(length > 0) || !(frames > 0)) return EMPTY
  const shift = Math.round(take.latency * rate)
  const minPartial = Math.max(1, Math.round(LOOP_PARTIAL_MIN_SECONDS * rate))
  const starts = [...new Set(take.marks.filter(Number.isFinite).map((m) => Math.round(m) + shift))]
    .sort((a, b) => a - b)
    .filter((from) => from < frames)

  const passes: PassRange[] = []
  let place: number | null = null
  for (const [i, start] of starts.entries()) {
    const next = i + 1 < starts.length ? starts[i + 1] : frames
    const from = Math.max(0, start)
    const to = Math.min(start + length, next, frames)
    const complete = start >= 0 && to === start + length
    if (!complete && to - from < minPartial) continue
    if (complete) place = passes.length
    passes.push({ from, to })
  }
  return passes.length > LOOP_PASS_MAX ? EMPTY : { passes, place }
}
