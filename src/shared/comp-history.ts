import type { CueComp } from './domain'
import type { StepDir } from './line-history'

export interface CompEntry {
  value: CueComp | null
  at: number
}

export interface CompStacks {
  undo: CompEntry[]
  redo: CompEntry[]
}

export type CompHistory = Map<string, CompStacks>

export const COMP_HISTORY_LIMIT = 100

export function dropCompRedo(history: CompHistory): void {
  for (const stacks of history.values()) stacks.redo = []
}

export function recordCompEdit(history: CompHistory, cueId: string, prev: CueComp | null, at: number): void {
  dropCompRedo(history)
  const stacks = history.get(cueId) ?? { undo: [], redo: [] }
  history.set(cueId, stacks)
  stacks.undo.push({ value: prev, at })
  if (stacks.undo.length > COMP_HISTORY_LIMIT) stacks.undo.shift()
}

export function stepCompEdit(
  history: CompHistory,
  cueId: string,
  dir: StepDir,
  current: CueComp | null
): CompEntry | undefined {
  const stacks = history.get(cueId)
  const entry = stacks && (dir === 'undo' ? stacks.undo : stacks.redo).pop()
  if (!stacks || !entry) return undefined
  ;(dir === 'undo' ? stacks.redo : stacks.undo).push({ value: current, at: entry.at })
  return entry
}

export function nextCompEdit(history: CompHistory, dir: StepDir): { cueId: string; at: number } | null {
  let next: { cueId: string; at: number } | null = null
  for (const [cueId, stacks] of history) {
    const stack = dir === 'undo' ? stacks.undo : stacks.redo
    const at = stack[stack.length - 1]?.at
    if (at !== undefined && (next === null || (dir === 'undo' ? at > next.at : at < next.at))) next = { cueId, at }
  }
  return next
}

export function pruneCompHistory(history: CompHistory, cueIds: Iterable<string>): void {
  const live = new Set(cueIds)
  for (const cueId of history.keys()) if (!live.has(cueId)) history.delete(cueId)
}
