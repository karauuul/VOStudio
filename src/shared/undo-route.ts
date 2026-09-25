export type UndoSide = 'comp' | 'fx' | 'line'

export interface UndoTimes {
  comp: number | null
  fx: number | null
  line?: number | null
}

const SIDES: UndoSide[] = ['comp', 'fx', 'line']

export function pickHistory(times: UndoTimes, dir: 'undo' | 'redo'): UndoSide | null {
  let best: UndoSide | null = null
  for (const side of SIDES) {
    const at = times[side] ?? null
    if (at === null) continue
    const current = best === null ? null : (times[best] ?? null)
    if (current === null || (dir === 'undo' ? at > current : at < current)) best = side
  }
  return best
}

export function redoStale(redoAt: number | null, otherUndoAt: number | null): boolean {
  return redoAt !== null && otherUndoAt !== null && redoAt < otherUndoAt
}
