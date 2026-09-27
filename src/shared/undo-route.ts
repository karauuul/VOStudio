import type { ClipEffects, Cue, CueComp, Project, Take } from './domain'
import type { ChangeOrigin, ChangeSet } from './project-commands'

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

export interface AgentCompEdit {
  cueId: string
  prev: CueComp | null
}

export interface AgentEffectsEdit {
  cueId: string
  takeId: string
  prev: ClipEffects | undefined
  next: ClipEffects | undefined
}

export interface TakeEffectsEdit extends AgentEffectsEdit {
  at: number
}

export interface EffectsHistory {
  undo: TakeEffectsEdit[]
  redo: TakeEffectsEdit[]
}

export interface ExternalChanges {
  comps: Set<string>
  effects: Set<string>
  lines: Set<string>
  compEdits: AgentCompEdit[]
  effectEdits: AgentEffectsEdit[]
}

const liveComp = (comp: CueComp | undefined): CueComp | null => (comp && comp.clips.length > 0 ? comp : null)
const compKey = (comp: CueComp | undefined): string => JSON.stringify(liveComp(comp))
const effectsKey = (take: Take | undefined): string => JSON.stringify([take?.edits.effects ?? null, take?.deletedAt ?? null])
const lineKey = (cue: Cue | undefined): string =>
  JSON.stringify(
    cue
      ? [cue.text, cue.sourceText, cue.characterId, cue.suggestedText, cue.status, cue.output, cue.approval, cue.referenceAudio, cue.original]
      : null
  )
export const takeKey = (cueId: string, takeId: string): string => `${cueId}/${takeId}`

export function externalChanges(before: Pick<Project, 'cues'> | null, changes: ChangeSet, origin?: ChangeOrigin): ExternalChanges {
  const out: ExternalChanges = { comps: new Set(), effects: new Set(), lines: new Set(changes.removedCueIds ?? []), compEdits: [], effectEdits: [] }
  if (!changes.cues?.length) return out
  const agent = origin === 'agent'
  const prior = new Map((before?.cues ?? []).map((cue) => [cue.id, cue]))
  for (const cue of changes.cues) {
    const was = prior.get(cue.id)
    if (compKey(was?.comp) !== compKey(cue.comp)) {
      if (agent && was) out.compEdits.push({ cueId: cue.id, prev: liveComp(was.comp) })
      else out.comps.add(cue.id)
    }
    if (lineKey(was) !== lineKey(cue)) out.lines.add(cue.id)
    for (const take of cue.takes) {
      const old = was?.takes.find((t) => t.id === take.id)
      if (effectsKey(old) === effectsKey(take)) continue
      if (agent && old && old.deletedAt === take.deletedAt) {
        out.effectEdits.push({ cueId: cue.id, takeId: take.id, prev: old.edits.effects, next: take.edits.effects })
      } else out.effects.add(takeKey(cue.id, take.id))
    }
  }
  return out
}

export function recordExternalEffects(history: EffectsHistory, external: ExternalChanges, at: number, limit: number): EffectsHistory {
  const kept = (entry: TakeEffectsEdit): boolean => !external.effects.has(takeKey(entry.cueId, entry.takeId))
  const recorded = external.effectEdits.map((edit) => ({ ...edit, at }))
  return {
    undo: [...history.undo, ...recorded].slice(-limit).filter(kept),
    redo: recorded.length > 0 ? [] : history.redo.filter(kept),
  }
}
