import { committedComp } from './comp'
import type { ClipEffects, Cue, CueComp, Project, Take } from './domain'
import { sanitizeRevision } from './approval'
import { outputStateOf, type LineChange } from './line-history'
import { outputStateKey, type ChangeOrigin, type ChangeSet, type FieldStep, type LineFields } from './project-commands'

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

export async function sendEdit<T>(send: () => Promise<T>, replay: boolean, onEdit: () => () => void): Promise<T> {
  const invalidate = replay ? null : onEdit()
  const result = await send()
  invalidate?.()
  return result
}

export function staleRedo(stacks: readonly (readonly object[])[]): (entry: object) => boolean {
  const stale = new Set(stacks.flat())
  return (entry) => !stale.has(entry)
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
  lineEdits: LineChange[]
}

const liveComp = (comp: CueComp | undefined): CueComp | null => committedComp(comp ?? null)
const compKey = (comp: CueComp | undefined): string => JSON.stringify(liveComp(comp))
const effectsKey = (take: Take | undefined): string => JSON.stringify([take?.edits.effects ?? null, take?.deletedAt ?? null])
const lineKey = (cue: Cue | undefined): string =>
  JSON.stringify(
    cue
      ? [cue.text, cue.sourceText, cue.characterId, cue.suggestedText, cue.status, cue.output, cue.approval, cue.referenceAudio, cue.original]
      : null
  )
export const takeKey = (cueId: string, takeId: string): string => `${cueId}/${takeId}`

const FIELD_KEYS = ['sourceText', 'text', 'characterId'] as const
const otherLineKey = (cue: Cue): string => JSON.stringify([cue.referenceAudio, cue.original])
const outputSourceKey = (cue: Cue): string =>
  JSON.stringify([compKey(cue.comp), cue.finalTakeId ?? null, sanitizeRevision(cue.textRevision), cue.takes.map((take) => [take.id, take.deletedAt ?? null])])

function fieldStep(was: Cue, cue: Cue): FieldStep | null {
  const from: LineFields = {}
  const to: LineFields = {}
  for (const key of FIELD_KEYS) {
    if (was[key] === cue[key]) continue
    from[key] = was[key]
    to[key] = cue[key]
  }
  if ((was.suggestedText ?? null) !== (cue.suggestedText ?? null)) {
    from.suggestedText = was.suggestedText ?? null
    to.suggestedText = cue.suggestedText ?? null
  }
  return Object.keys(to).length > 0 ? { cueId: cue.id, from, to } : null
}

export function externalChanges(before: Pick<Project, 'cues'> | null, changes: ChangeSet, origin?: ChangeOrigin): ExternalChanges {
  const agent = origin === 'agent'
  const lineAgent = agent && before !== null && changes.characters === undefined
  const removed = lineAgent ? (changes.removedCues ?? []) : []
  const out: ExternalChanges = {
    comps: new Set(),
    effects: new Set(),
    lines: new Set(removed.length > 0 ? [] : (changes.removedCueIds ?? [])),
    compEdits: [],
    effectEdits: [],
    lineEdits: [],
  }
  if (removed.length > 0) {
    const ids = removed.map((placed) => placed.cue.id)
    out.lineEdits.push({ kind: 'cues', undoRemoves: false, ids, snapshots: removed, focus: ids[0] })
  }
  if (!changes.cues?.length) return out
  const prior = new Map((before?.cues ?? []).map((cue) => [cue.id, cue]))
  const created: string[] = []
  const fields: FieldStep[] = []
  const outputs: Extract<LineChange, { kind: 'done' }>[] = []
  for (const cue of changes.cues) {
    const was = prior.get(cue.id)
    if (compKey(was?.comp) !== compKey(cue.comp)) {
      if (agent && was) out.compEdits.push({ cueId: cue.id, prev: liveComp(was.comp) })
      else out.comps.add(cue.id)
    }
    if (lineKey(was) !== lineKey(cue)) {
      const own = lineAgent && was !== undefined && otherLineKey(was) === otherLineKey(cue)
      const step = own ? fieldStep(was, cue) : null
      if (lineAgent && !was && changes.cueIndex?.[cue.id] !== undefined) created.push(cue.id)
      else if (step) fields.push(step)
      else if (!own) out.lines.add(cue.id)
      else if (outputSourceKey(was) === outputSourceKey(cue) && outputStateKey(outputStateOf(was)) !== outputStateKey(outputStateOf(cue))) {
        outputs.push({ kind: 'done', cueId: cue.id, textRevision: sanitizeRevision(was.textRevision), before: outputStateOf(was), after: outputStateOf(cue) })
      }
    }
    for (const take of cue.takes) {
      const old = was?.takes.find((t) => t.id === take.id)
      if (effectsKey(old) === effectsKey(take)) continue
      if (agent && old && old.deletedAt === take.deletedAt) {
        out.effectEdits.push({ cueId: cue.id, takeId: take.id, prev: old.edits.effects, next: take.edits.effects })
      } else out.effects.add(takeKey(cue.id, take.id))
    }
  }
  if (out.effects.size === 0 && out.effectEdits.length === 0) out.lineEdits.push(...outputs)
  if (created.length > 0 || fields.length > 0) {
    out.lineEdits.push({ kind: 'table', ids: created, snapshots: [], fields, characters: [], focus: created[0] ?? fields[0].cueId })
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

export function pruneEffectsHistory(history: EffectsHistory, cues: readonly Cue[]): EffectsHistory {
  const live = new Set(cues.flatMap((cue) => cue.takes.filter((take) => !take.deletedAt).map((take) => takeKey(cue.id, take.id))))
  const kept = (entry: TakeEffectsEdit): boolean => live.has(takeKey(entry.cueId, entry.takeId))
  return { undo: history.undo.filter(kept), redo: history.redo.filter(kept) }
}
