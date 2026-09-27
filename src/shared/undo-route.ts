import type { Cue, CueComp, Project, Take } from './domain'
import type { ChangeSet } from './project-commands'

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

export interface ExternalChanges {
  comps: Set<string>
  effects: Set<string>
  lines: Set<string>
}

const compKey = (comp: CueComp | undefined): string => JSON.stringify(comp && comp.clips.length > 0 ? comp : null)
const effectsKey = (take: Take | undefined): string => JSON.stringify(take?.edits.effects ?? null)
const lineKey = (cue: Cue | undefined): string =>
  JSON.stringify(
    cue
      ? [cue.text, cue.sourceText, cue.characterId, cue.suggestedText, cue.status, cue.output, cue.approval, cue.referenceAudio, cue.original]
      : null
  )
export const takeKey = (cueId: string, takeId: string): string => `${cueId}/${takeId}`

export function externalChanges(before: Pick<Project, 'cues'> | null, changes: ChangeSet): ExternalChanges {
  const out: ExternalChanges = { comps: new Set(), effects: new Set(), lines: new Set(changes.removedCueIds ?? []) }
  if (!changes.cues?.length) return out
  const prior = new Map((before?.cues ?? []).map((cue) => [cue.id, cue]))
  for (const cue of changes.cues) {
    const was = prior.get(cue.id)
    if (compKey(was?.comp) !== compKey(cue.comp)) out.comps.add(cue.id)
    if (lineKey(was) !== lineKey(cue)) out.lines.add(cue.id)
    for (const take of cue.takes) {
      if (effectsKey(was?.takes.find((t) => t.id === take.id)) !== effectsKey(take)) out.effects.add(takeKey(cue.id, take.id))
    }
  }
  return out
}
