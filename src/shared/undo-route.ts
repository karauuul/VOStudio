export type UndoSide = 'comp' | 'fx'

export interface UndoTimes {
  comp: number | null
  fx: number | null
}

export function pickHistory(times: UndoTimes, dir: 'undo' | 'redo'): UndoSide | null {
  const { comp, fx } = times
  if (comp === null) return fx === null ? null : 'fx'
  if (fx === null) return 'comp'
  return (dir === 'undo' ? comp >= fx : comp <= fx) ? 'comp' : 'fx'
}

export function redoStale(redoAt: number | null, otherUndoAt: number | null): boolean {
  return redoAt !== null && otherUndoAt !== null && redoAt < otherUndoAt
}
