import type { AudioRef, Cue } from './domain'
import type { ChangeSet, PlacedCue, ProjectCommand } from './project-commands'

export interface Reference {
  referenceAudio: AudioRef | null
  referenceDuration: number | null
}

export type LineChange =
  | {
      kind: 'cues'
      undoRemoves: boolean
      ids: string[]
      snapshots: PlacedCue[]
      focus: string
      text?: { cueId: string; before: string; after: string }
    }
  | { kind: 'original'; cueId: string; before: Reference; after: Reference }

export type LineEdit = LineChange & { at: number }

export interface LineHistory {
  undo: LineEdit[]
  redo: LineEdit[]
}

export type StepDir = 'undo' | 'redo'

export const LINE_HISTORY_LIMIT = 100

export const referenceOf = (cue: Cue | undefined): Reference => ({
  referenceAudio: cue?.referenceAudio ?? null,
  referenceDuration: cue?.referenceDuration ?? null,
})

export function recordLineEdit(history: LineHistory, change: LineChange, at: number): void {
  history.undo.push({ ...change, at })
  if (history.undo.length > LINE_HISTORY_LIMIT) history.undo.shift()
  history.redo = []
}

export function removesLines(edit: LineEdit, dir: StepDir): boolean {
  return edit.kind === 'cues' && (dir === 'undo') === edit.undoRemoves
}

export function lineStepCommand(edit: LineEdit, dir: StepDir): ProjectCommand {
  if (edit.kind === 'original') {
    return { type: 'cue.restoreOriginal', cueId: edit.cueId, ...(dir === 'undo' ? edit.before : edit.after) }
  }
  return removesLines(edit, dir)
    ? { type: 'cue.delete', cueIds: edit.ids }
    : { type: 'cue.restore', cues: edit.snapshots }
}

export function steppedEdit(edit: LineEdit, dir: StepDir, changes: ChangeSet, current: Reference): LineEdit {
  if (edit.kind === 'original') return dir === 'undo' ? { ...edit, after: current } : { ...edit, before: current }
  return removesLines(edit, dir) ? { ...edit, snapshots: changes.removedCues ?? [] } : edit
}

export async function runLineStep(
  history: LineHistory,
  dir: StepDir,
  apply: (edit: LineEdit) => Promise<LineEdit>
): Promise<LineEdit | null> {
  const from = dir === 'undo' ? history.undo : history.redo
  const edit = from.pop()
  if (!edit) return null
  let next: LineEdit
  try {
    next = await apply(edit)
  } catch (error) {
    from.push(edit)
    throw error
  }
  ;(dir === 'undo' ? history.redo : history.undo).push(next)
  return next
}

export interface RemovalState {
  busy: (cueId: string) => boolean
  recordingCueId: string | null
}

export function removalBlock(ids: string[], state: RemovalState): string | null {
  if (state.recordingCueId !== null && ids.includes(state.recordingCueId)) return 'Stop the recording first'
  if (ids.some((id) => state.busy(id))) return 'Line is busy'
  return null
}
